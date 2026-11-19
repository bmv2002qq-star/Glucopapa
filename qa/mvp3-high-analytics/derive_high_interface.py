"""Derive the inert HIGH view from the approved, byte-locked standalone source."""
import argparse
import hashlib
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs/mvp3-high-analytics/originals/HIGH_v0.1.3.html'
VIEW = ROOT / 'android-mvp3/app/src/main/assets/www/integration/approved_routes/GFHighTarget_v0.1.3_VIEW.html'
APPROVED = 'd82001e180b561f759a7d464813f6057c67991e22c90660b49954e02d9a6c26b'


def render():
    raw = SOURCE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == APPROVED
    body, count = re.subn(r'<script\b[^>]*>.*?</script>', '', raw.decode('utf-8'), flags=re.DOTALL)
    assert count == 3
    body, count = re.subn(r'<details id="scenarioSettings">.*?(?=<div class="coeffSettings">)',
                          '<details id="scenarioSettings"><summary>Коэффициенты активности</summary>',
                          body, flags=re.DOTALL)
    assert count == 1
    changes = [
        ('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
         'content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'),
        ('<div class="headBadge">Тестовый сценарий</div>', '<div class="headBadge">Локальный журнал</div>'),
        ('id="gNow">12,0', 'id="gNow">—'),
        ('step="0.5" value="2.0"', 'step="0.5" value=""'),
        ('Измени количество — кривая ниже перестроится автоматически. Укол не записывается.',
         'Введите фактическое количество вручную. Запись создаётся после подтверждения.'),
        ('После подключения к приложению только подтверждённый укол будет записан в дневник.',
         'Подтвердите, что РинФаст уже введён.'),
        ('В автономном HTML запись отключена: здесь только тестирование интерфейса и математических сценариев.',
         'Ожидается подтверждение.'),
        ('Изменения в этом HTML действуют до закрытия страницы. В программе эти три значения хранятся в GFSettings через GFStorage.',
         'Значения сохраняются через GFSettings в GFStorage.'),
        ('При включённой активности её вклад меняет тестовую прогнозную кривую. Левемир не используется.',
         'Численная поправка активности проверяется на синтетических данных.'),
        ('Числа получены только из вымышленных сценариев; медицинская корректность доз не подтверждена.',
         'Клиническая пригодность формулы дозы не подтверждена.'),
    ]
    for old, new in changes:
        assert body.count(old) == 1, old
        body = body.replace(old, new)
    for pattern, value in [
        (r'(id="target"[^>]*?)\s+value="[^"]+"', r'\1 value=""'),
        (r'(id="trend"[^>]*>)[^<]+', r'\1—'),
        (r'(<div class="src">)[^<]+', r'\1Источник CGM проверяется.'),
    ]:
        body, count = re.subn(pattern, value, body)
        assert count == 1
    return body.encode('utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    expected = render()
    if args.check:
        assert VIEW.read_bytes() == expected
    else:
        VIEW.write_bytes(expected)
    print(hashlib.sha256(expected).hexdigest())
