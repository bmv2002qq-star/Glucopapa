"""Derive an inert GFMealCalc view from the five cards in the approved source."""
import argparse
from hashlib import sha256
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs/mvp3-unified-feedback/originals/GFMealCalc_UI_v0.3.0_APPROVED_SOURCE.html'
VIEW = ROOT / 'android-mvp3/app/src/main/assets/www/integration/approved_routes/GFMealCalc_v0.3.0_VIEW.html'
APPROVED_SHA = 'a075d83b1fe750ae37a971ec66796b2342e2d8ca7d90e274ae362a6e332242dc'


def replace(body, pattern, replacement=''):
    body, count = re.subn(pattern, replacement, body, flags=re.DOTALL)
    assert count == 1, pattern
    return body


def render():
    source = SOURCE.read_bytes()
    assert sha256(source).hexdigest() == APPROVED_SHA
    original = source.decode('utf-8')
    css = re.search(r'<style>.*?</style>', original, re.DOTALL).group()
    steps = re.search(r'<nav class="stepbar".*?</nav>', original, re.DOTALL).group()
    ids = ('plateCard', 'calcCard', 'timerCard', 'mealCard', 'endCard')
    plate, calc, timer, meal, end = [
        re.search(r'<section class="card" id="'+name+r'">.*?</section>', original, re.DOTALL).group()
        for name in ids
    ]
    plate = replace(plate, r'<p class="hint">.*?</p>')
    plate = replace(plate, r'<p class="fine" id="plateNote">.*?</p>')
    plate = replace(plate, r'(<div class="contents" id="foodFields">).*?(?=<div class="row")',
                    r'\1<div id="plannedFoods"></div>')
    plate = plate.replace('28 г углеводов','—').replace('id="savePlan">Сохранить изменения',
                                                        'id="savePlan">Вернуться к продуктам')
    calc = replace(calc, r'<p class="hint">.*?</p>')
    calc = replace(calc, r'<button id="fillDemoDose".*?</button>')
    for old, new in {
        'Условная оценка по тарелке':'Рассчитывает программа',
        'Пример интервала до еды':'Интервал по похожим случаям',
        'По синтетической истории':'—',
        'Похожие синтетические случаи появятся после подтверждения тарелки.':'',
        'Моя тестовая доза, ЕД':'Моя доза, ЕД',
        'max="10" step="0.5"':'max="50" step="0.5"',
        'Мой интервал таймера, мин':'Интервал по истории, мин',
        'id="minutesChosen" type="number" min="0" max="30" step="1" placeholder="Например: 8"':
            'id="minutesChosen" type="number" readonly',
    }.items():
        assert old in calc
        calc = calc.replace(old,new)
    calc = replace(calc, r'<div class="actions"><button id="confirmInjection".*?</p>',
        '<div class="twocol"><label>Время укола<input id="shotTime" type="datetime-local"></label>'
        '<label>Место укола<select id="shotSite"><option value="">Не выбрано</option>'
        '<option value="abdomen">Живот</option><option value="thigh">Бедро</option>'
        '<option value="arm">Рука</option><option value="buttock">Ягодица</option>'
        '</select></label></div>'
        '<svg id="chartSvg" viewBox="0 0 620 226" role="img" aria-label="Кривая действия РинФаста"></svg>'
        '<p class="fine">Модель действия РинФаста</p>'
        '<div class="actions"><button id="confirmInjection">Сделал укол</button></div>'
        '<p class="fine" id="injectionHint"></p>')
    timer = replace(timer, r'<div class="actions">.*?</div><p class="fine">.*?</p>')
    timer = timer.replace('Оставшееся условное время','Осталось по историческому интервалу')
    timer = timer.replace('Таймер включится после подтверждения учебной инъекции','Ожидание подтверждения укола.')
    meal = meal.replace('Ожидает укола','Ожидание').replace('28 г углеводов','—')
    meal = meal.replace('Подтвердите учебный укол, затем отметьте фактическое начало еды.',
                        'Отметьте фактическое начало и завершение еды.')
    meal = meal.replace('<button id="startMeal">',
        '<label>Время начала<input id="mealStartTime" type="datetime-local"></label><button id="startMeal">')
    meal = meal.replace('Редактирование съеденного · GFNutrition (учебная тарелка)','Фактически съедено')
    meal = replace(meal, r'<p class="hint">Укажите фактически.*?</p>', '<p>Укажите количество каждого продукта.</p>')
    meal = replace(meal, r'<div class="twocol"><div><label for="newFood">.*?<div class="notice" id="balanceWarning"[^>]*>.*?</div>')
    meal = meal.replace('<input id="editReason"','<input id="editReason" maxlength="300"')
    end = replace(end,r'<div class="actions"><button class="secondary" id="simulateOutcome".*?</p>')
    end = replace(end,r'<div class="notice">При исправлении.*?</div>')
    end = end.replace('Реальный интервал в демо','Фактический интервал')
    end = end.replace('Новый учебный приём','Вернуться к продуктам')
    return (
        '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'
        '<title>ГлюкоПапа</title>'+css+'\n</head><body><main>\n'
        '<h1>Инсулин и приём пищи</h1><label>Приём пищи<select id="chooseMeal"></select></label>\n'
        +steps+'\n'+'\n'.join((plate,calc,timer,meal,end))+
        '\n<details><summary>Расчёт и исходные данные</summary><div id="mealCalculationDetails"></div></details>'
        '<p role="status" id="mealOperationStatus"></p>\n</main></body></html>\n'
    ).encode('utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    expected = render()
    if parser.parse_args().check:
        assert VIEW.read_bytes() == expected
    else:
        VIEW.write_bytes(expected)
    print(sha256(expected).hexdigest())
