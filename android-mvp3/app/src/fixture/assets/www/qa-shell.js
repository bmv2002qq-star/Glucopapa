/* Test-only build entrypoint. Kept out of the ordinary debug and release APKs. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  function setup({change, reload, port, current, wrap, notify}) {
    byId('notice').insertAdjacentHTML('beforebegin',
      '<div id="banner" class="alert" hidden>Тестовый журнал. Вымышленные данные сохраняются отдельно.</div>');
    byId('moduleTable').parentElement.insertAdjacentHTML('beforebegin',
      '<article class="panel"><h3>Режим данных</h3><div class="mode-buttons">' +
      '<button class="btn primary" id="modeLocal">Локальный журнал</button>' +
      '<button class="btn secondary" id="modeDemo">Тестовый журнал</button></div></article>');
    byId('screen-cgm').insertAdjacentHTML('beforeend',
      '<article id="syntheticCgmTools" class="card" hidden><h3>Проверка CGM</h3>' +
      '<button id="seedDemo" class="btn secondary full">Загрузить 24 вымышленных измерения</button></article>');
    byId('exportState').insertAdjacentHTML('afterend',
      '<button id="resetDemo" class="btn danger" hidden>Очистить тестовый журнал в браузере</button>');
    byId('modeLocal').addEventListener('click', wrap(() => change('local')));
    byId('modeDemo').addEventListener('click', wrap(() => {
      if (current()!=='demo' && confirm('Открыть отдельный тестовый журнал? Ввод в нём сохраняется как тестовый.')) {
        change('demo');
      }
    }));
    byId('resetDemo').addEventListener('click', wrap(() => {
      if (current()!=='demo' || globalThis.GFNativeStorage) throw Error('Сброс недоступен');
      if (!confirm('Удалить тестовый журнал?')) return;
      localStorage.removeItem('GFV2SHELL_DATA_v1_demo');
      reload();
      notify('Тестовая база очищена');
    }));
    byId('seedDemo').addEventListener('click', wrap(() => {
      if (current()!=='demo') throw Error('Вымышленные данные только в тестовом режиме');
      const cgm=port('cgmAdapter');
      if (cgm.read('cgmMetadata')) throw Error('Тестовый датчик уже задан');
      const sensor='gs1-demo';
      const base=Math.floor(Date.now()/300000)*300000-300000;
      const rows=Array.from({length:24},(_,i)=>{
        const ts=base-(23-i)*300000;
        return {ts, mmol:Math.round((7.3+1.7*Math.sin(i/3.8)+0.4*Math.cos(i/2))*10)/10,
          sourceDeviceId:sensor, receivedAt:new Date(ts+60000).toISOString()};
      });
      cgm.setSourceMetadata({sourceDeviceId:sensor,sourceType:'synthetic',samplingMinutes:5,qualityScore:1},cgm.getRevision());
      cgm.ingestReadings(rows,cgm.getRevision());
      notify('Добавлены 24 вымышленных измерения в отдельный тестовый журнал');
    }));
  }
  function render(mode, source) {
    const demo=mode==='demo';
    byId('modeBadge').textContent=demo?'Тестовые данные':'Локальный журнал';
    byId('modeBadge').className='chip '+(demo?'demo':'local');
    byId('banner').hidden=!demo;
    byId('syntheticCgmTools').hidden=!demo;
    byId('seedDemo').disabled=!demo||!!source;
    byId('resetDemo').hidden=!demo||!!globalThis.GFNativeStorage;
  }
  globalThis.GFTestJournal=Object.freeze({initialMode:mode=>mode==='demo'?'demo':'local', setup, render});
})();
