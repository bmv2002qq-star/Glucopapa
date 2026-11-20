/* Bind the retained LOW layout to the app-owned storage contract. The frame executes no script. */
(() => {
  'use strict';
  const frame = document.getElementById('iframeLowTarget');
  const messages = {
    CGM_SOURCE_UNKNOWN: 'Источник CGM не задан.',
    CGM_RECEIPT_MISSING: 'Время получения показания CGM неизвестно или противоречиво.',
    CGM_STALE: 'Показание CGM устарело.',
    XDRIP_MODEL_QUALITY_UNKNOWN: 'xDrip+ передал показание. Качество ряда для модели неизвестно.',
    JOURNAL_COVERAGE_UNKNOWN: 'Полнота истории инсулина и еды не подтверждена.',
    SETTINGS_INCOMPLETE: 'Нужны действующие ручные УК и ФЧИ в текущем временном окне.',
    MEAL_PARTIAL: 'В истории есть незавершённая еда.',
    FOOD_COVERAGE_MISSING: 'Полнота истории фактически съеденного не подтверждена.',
    PRODUCT_COMPOSITION_UNKNOWN: 'Сохраните продукт с известным составом через «Мою тарелку».',
    PRODUCT_PROFILE_UNVERIFIED: 'Параметр усвоения выбранного продукта неизвестен.',
    LOW_CANONICAL_PARITY_MISSING: 'Для выбранного GFForecast ещё не доказано совпадение модели LOW.',
    GFCOB_PORT_UNAVAILABLE: 'Интервал GFCOB пока не имеет подтверждённого точечного вклада в сахар.',
    ILLNESS_EFFECT_UNMODELED: 'Отдельный численный эффект болезни не подтверждён.',
    ACTIVITY_EFFECT_UNMODELED: 'Отдельный численный эффект активности не подтверждён.',
  };
  const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : '—';
  const number = field => field.value === '' ? null : field.valueAsNumber;
  let doc, mountedHost, observer, view, pending, busy = false, productsKey = '';
  const el = id => doc.getElementById(id);
  const clearUse = () => {
    pending = null;
    el('juiceNumber').value = '';
    el('juice').value = '0';
  };

  function size() {
    if (doc && frame.offsetParent) frame.style.height = doc.body.getBoundingClientRect().height + 'px';
  }

  function renderAvailability() {
    const product = view.products.find(row => row.key === el('calcProduct').value)?.item;
    const amount = number(el('juiceNumber'));
    const positive = Number.isFinite(amount) && amount > 0 && amount <= 200;
    el('lowProductName').textContent = product?.name ?? 'Выберите продукт';
    el('lowUnit').textContent = product?.unit ?? '—';
    el('juiceNumber').disabled = !product;
    el('juice').disabled = !product;
    for (const preset of doc.querySelectorAll('[data-juice]')) {
      preset.textContent = preset.dataset.juice + (product ? ' ' + product.unit : '');
      preset.disabled = !product;
    }
    for (const [index, tick] of [...doc.querySelectorAll('.scale span')].entries()) {
      tick.textContent = String(index * 100) + (product ? ' ' + product.unit : '');
    }
    el('carbs').textContent = product && positive ? fmt(product.carbs * amount / product.amount) + ' г' : '—';
    el('journal').disabled = busy || !product || !positive || view.revision === null;
    el('applyResult').disabled = true;
  }

  function render() {
    if (!doc || !frame.offsetParent) return;
    const host = GPApp.getStorage(), mode = GPApp.mode();
    if (host !== mountedHost) {
      mountedHost = host;
      productsKey = '';
      el('calcProduct').value = '';
      el('goal').value = '';
      el('calcResult').hidden = true;
      el('journalText').textContent = 'Сохраните продукт через «Мою тарелку».';
      clearUse();
    }
    const nowMs = Date.now();
    view = GFLOWStorage.inspect({host, mode, nowMs,
      foodOptions: globalThis.GFCOBStudyPanel?.optionsForRevision(host, nowMs)});
    const list = view.products;
    const key = JSON.stringify(list.map(row => [row.key, row.item.name]));
    if (key !== productsKey) {
      const select = el('calcProduct'), previous = select.value;
      select.replaceChildren(new Option(list.length ? 'Выберите продукт' : 'Нет подтверждённого продукта', ''),
        ...list.map(row => new Option(row.item.name + ' · ' + row.item.unit, row.key)));
      if (list.some(row => row.key === previous)) select.value = previous;
      else clearUse();
      productsKey = key;
    }
    doc.querySelector('.tag').textContent = mode === 'demo' ? 'Синтетический журнал' : 'Локальный журнал';
    const reading = view.glucose;
    const g = reading?.value;
    const zone = !Number.isFinite(g) ? '' : g < 3.9 ? 'Red' : g < 4.5 ? 'Orange' : g <= 10 ? 'Green' : '';
    for (const color of ['Red', 'Orange', 'Green'])
      el('zone' + color).classList.toggle('selected', zone === color);
    el('heroGlucose').textContent = fmt(g);
    el('heroArrow').textContent = reading?.trend || '—';
    el('lowSource').textContent = (reading?.source === 'SYNTHETIC' ? 'Синтетический CGM' :
      reading?.source === 'XDRIP_LOCAL' ? 'xDrip+ · показание' : 'CGM') + ' · ' + (reading?.code ?? view.code);
    el('dataAge').textContent = Number.isFinite(reading?.age) ? fmt(reading.age, 0) + ' мин назад' : 'Свежесть неизвестна';
    el('statusLabel').className = 'state ' + (zone === 'Orange' ? 'amber' : zone === 'Green' ? 'green' : zone ? '' : 'neutral');
    const label = {Red: 'Низкое показание', Orange: 'Близко к нижней границе', Green: 'В диапазоне LOW'};
    el('statusLabel').textContent = label[zone] ?? (Number.isFinite(g) ? 'Вне диапазона LOW' : 'Нет свежего CGM');
    el('ispadBox').hidden = !reading?.low;
    if (reading?.low) {
      el('lowWarning').textContent = g < 3 ? 'Критически низкое показание CGM' : 'Низкое показание CGM';
      el('ispadCarbs').textContent = fmt(g) + ' ммоль/л';
      el('ispadJuice').textContent = view.syntheticReference?.visible
        ? 'Синтетическая справка ISPAD · ' + fmt(view.syntheticReference.initialCarbsG) + ' г углеводов'
        : 'Следуйте индивидуальному плану помощи.';
    }
    el('dataChip').textContent = 'CGM ' + fmt(g) + ' · ' + el('heroArrow').textContent;
    if (reading?.alert?.status === 'VERIFY_READING') el('dataChip').textContent += ' · проверьте показание';
    if (reading?.alert?.status === 'RISK_WITHIN_WINDOW') el('dataChip').textContent += ' · тенденция к снижению';
    el('iobChip').textContent = 'РинФаст IOB ' + fmt(view.iob, 2) + ' ЕД модели';
    const lower = view.food?.lowerG, upper = view.food?.upperG;
    el('cobChip').textContent = 'COB ' + (Number.isFinite(lower) && Number.isFinite(upper) ?
      fmt(lower) + '–' + fmt(upper) + ' г модели' : '—');
    el('activityChip').textContent = 'Активность: ' + (view.activity ?? '—') + (view.illness ? ' · болезнь' : '');
    el('eta').textContent = 'Траектория недоступна · ' + (view.code ?? 'GFSTORAGE_UNAVAILABLE');
    el('resultMl').textContent = 'Расчёт недоступен';
    el('resultExplain').textContent = 'Оценка использует один снимок GFStorage.';
    el('lowBlockers').replaceChildren(...(view.blockers ?? [view.code]).map(code => {
      const item = doc.createElement('li');
      item.dataset.code = code;
      item.textContent = messages[code] ?? code;
      return item;
    }));
    el('lowTrace').textContent = [
      'GFStorage · ревизия ' + (view.revision ?? '—'), 'CGM · ' + (reading?.source ?? '—') + ' · ' + (reading?.measuredAt ?? '—'),
      'УК · ' + fmt(view.rates?.uk?.value) + ' г/ЕД · ' + (view.rates?.uk?.id ?? 'неизвестно'),
      'ФЧИ · ' + fmt(view.rates?.isf?.value) + ' ммоль/л/ЕД · ' + (view.rates?.isf?.id ?? 'неизвестно'),
      el('iobChip').textContent, el('cobChip').textContent, el('activityChip').textContent,
      'Модель еды · ' + (view.food?.model?.id ?? '—') + ' ' + (view.food?.model?.version ?? '') +
        ' · ' + (view.food?.code ?? '—'),
      'Архивный LOW · F(t, τ) = 1 − (1 + t/τ) × exp(−t/τ). Параметр τ и численный прогноз недоступны.',
    ].join('\n');
    renderAvailability();
    size();
  }

  function record() {
    if (busy || !view || el('journal').disabled) return;
    const host = GPApp.getStorage();
    const ref = view.products.find(row => row.key === el('calcProduct').value);
    const amount = number(el('juiceNumber'));
    const identity = JSON.stringify([ref?.reference, ref?.key, amount]);
    busy = true;
    try {
      if (pending?.host !== host || pending.identity !== identity) {
        const id = 'low-' + Array.from(crypto.getRandomValues(new Uint32Array(4)),
          value => value.toString(16).padStart(8, '0')).join('');
        const fact = GFLOWStorage.prepareFact({view, productKey: ref?.key, amount, id, decidedAt: new Date().toISOString()});
        pending = {host, identity, fact};
      }
      const revision = view.revision;
      if (!window.confirm('Подтвердите, что еда уже съедена. ' + ref.item.name + ' · ' + amount + ' ' + ref.item.unit)) {
        pending = null;
        el('journalText').textContent = 'Запись отменена.';
        return;
      }
      if (host !== GPApp.getStorage()) throw Error('Журнал переключился. Повторите подтверждение.');
      GFLOWStorage.recordFact({host, pending: pending.fact, expectedRevision: revision, confirmation: true});
      clearUse();
      el('journalText').textContent = 'Одна подтверждённая порция сохранена в дневнике.';
    } catch (error) {
      el('journalText').textContent = String(error.message || error);
    } finally {
      busy = false;
      render();
    }
  }

  function amountChanged(raw) {
    if (raw === '') { clearUse(); renderAvailability(); return; }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 200) { renderAvailability(); return; }
    el('juiceNumber').value = raw;
    el('juice').value = String(amount);
    renderAvailability();
  }

  function mount() {
    const loaded = frame.contentDocument;
    if (!loaded || loaded === doc || loaded.location.href !== frame.src || !loaded.getElementById('journal')) return;
    observer?.disconnect();
    doc = loaded;
    mountedHost = null;
    el('calculate').addEventListener('click', () => { el('calcResult').hidden = false; render(); });
    el('lowCatalog').addEventListener('click', () => GPApp.open('approved-nutrition'));
    el('journal').addEventListener('click', record);
    el('calcProduct').addEventListener('change', () => {
      clearUse();
      el('journalText').textContent = 'Введите фактически съеденное количество.';
      renderAvailability();
    });
    for (const id of ['juice', 'juiceNumber']) el(id).addEventListener('input', e => amountChanged(e.target.value));
    for (const preset of doc.querySelectorAll('[data-juice]'))
      preset.addEventListener('click', () => amountChanged(preset.dataset.juice));
    if (globalThis.ResizeObserver) {
      observer = new ResizeObserver(size);
      observer.observe(doc.body);
    }
    globalThis.GFCOBStudyPanel?.render();
    render();
  }
  frame.addEventListener('load', mount);
  mount();
  globalThis.GFLOWView = Object.freeze({render});
})();
