from hashlib import sha256
from pathlib import Path
import argparse
import re

root = Path(__file__).resolve().parents[2]
reference = root / 'docs/mvp3-low/originals/LOW_UI_v0.2.html'
destination = root / 'android-mvp3/app/src/main/assets/www/integration/approved_routes/LOW_v0.2_VIEW.html'


def render():
    raw = reference.read_bytes()
    assert sha256(raw).hexdigest() == 'b48cab570dce046ffa87fd87fa2546efe64850ea6f5b4ece32f9a205a43c1633'
    source = raw.decode('utf-8')
    for pattern, new in [
        (r'<script>.*?</script>', ''),
        (r'<details id="testData".*?</details>', ''),
        (r'<details><summary>Расчёт · показать формулы макета</summary>.*?</details>',
         '<details id="lowTracePanel"><summary>Расчёт</summary><div class="inside">'
         '<pre id="lowTrace" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>'
         '<div id="w06cStudyLow"></div></div></details>'),
        (r'<footer class="disclaimer">.*?</footer>',
         '<footer class="disclaimer">Исследовательские модели. Текущее измерение и фактически съеденная еда доступны через GFStorage.</footer>'),
    ]:
        source, count = re.subn(pattern, new, source, flags=re.S)
        assert count == 1, pattern
    edits = [
        ('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
         'content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'),
        ('HTML-макет · офлайн', 'Локальный журнал'),
        ('<div class="sub">Данные на экране — пример для согласования</div>',
         '<div class="sub" id="lowSource">Источник CGM проверяется.</div>'),
        ('id="dataAge">→ ровный тренд', 'id="dataAge">—'),
        ('id="heroGlucose">3,0', 'id="heroGlucose">—'),
        ('id="heroArrow">→', 'id="heroArrow">—'),
        ('id="statusLabel">Гипогликемия', 'id="statusLabel">Нет свежего CGM'),
        ('class="zone red selected"', 'class="zone red"'),
        ('id="ispadBox" role="note"', 'id="ispadBox" role="note" hidden'),
        ('<div class="name">● ГИПОГЛИКЕМИЯ · ПЕРВОНАЧАЛЬНЫЙ ОРИЕНТИР ISPAD</div>',
         '<div class="name" id="lowWarning">Низкое показание CGM</div>'),
        ('<div class="dose"><strong id="ispadCarbs">6 г</strong><span>быстрых углеводов</span></div>',
         '<div class="dose"><strong id="ispadCarbs">—</strong></div>'),
        ('<div class="equivalent"><strong id="ispadJuice">≈ 57 мл яблочного сока</strong> · 10,5 г У на 100 мл</div>',
         '<div class="equivalent" id="ispadJuice"></div>'),
        ('<option value="apple">Яблочный сок</option>', '<option value="">Нет подтверждённого продукта</option>'),
        ('step="0.1" value="6.0"', 'step="0.1" value=""'),
        ('id="dataChip">CGM 3,0 · →', 'id="dataChip">CGM —'),
        ('id="iobChip">РинФаст IOB 0 ЕД', 'id="iobChip">РинФаст IOB —'),
        ('id="cobChip">COB 0 г', 'id="cobChip">COB —'),
        ('id="activityChip">Активность: обычная', 'id="activityChip">Активность —'),
        ('<div class="detail" id="resultExplain">—</div>', '<div class="detail" id="resultExplain">—</div>'
         '<ul id="lowBlockers" aria-live="polite"></ul>'),
        ('Какой объём сока в условной модели соответствует выбранной цели к 120-й минуте.',
         'Исследовательский расчёт до цели к 120-й минуте.'),
        ('Калькулятор показывает результат математической модели, а не объём для лечения гипогликемии. Первоначальный ориентир ISPAD вынесен отдельно наверх.',
         'Доступность расчёта зависит от полноты истории и подтверждённых параметров продукта.'),
        ('Выбери объём сока — кривая изменится сразу. Пунктир показывает тот же сценарий без дополнительного сока.',
         'Укажите действительно съеденное количество для записи факта. График требует подтверждённой модели.'),
        ('<strong>Яблочный сок · 10,5 г У / 100 мл</strong>', '<strong id="lowProductName">Выберите продукт</strong>'),
        ('value="60" aria-label="Объём сока в миллилитрах"', 'value="" aria-label="Фактически съеденное количество"'),
        ('<span>мл</span></label>', '<span id="lowUnit">—</span></label>'),
        ('value="60" aria-label="Объём яблочного сока на графике"', 'value="0" aria-label="Количество продукта"'),
        ('id="carbs">6,3 г', 'id="carbs">—'),
        ('id="eta">Цель 6,0: —', 'id="eta">Траектория недоступна'),
        ('>С соком</span>', '>С продуктом</span>'),
        ('>Без нового сока</span>', '>Без нового продукта</span>'),
        ('<th>Без сока</th><th>С выбранным соком</th>', '<th>Без продукта</th><th>С продуктом</th>'),
        ('<p id="journalText">В макете кнопка не записывает события: GFStorage не подключён.</p>',
         '<p id="journalText" aria-live="polite">Сохраните продукт через «Мою тарелку».</p>'
         '<button id="lowCatalog" class="button ghost small" type="button">Моя тарелка</button>'),
    ]
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    assert 'id="testData"' not in source and '<script' not in source.lower()
    return re.sub(r'(?m)^[ \t]+$', '', source).encode('utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    expected = render()
    if parser.parse_args().check:
        assert destination.read_bytes() == expected
    else:
        destination.write_bytes(expected)
    print(sha256(expected).hexdigest())
