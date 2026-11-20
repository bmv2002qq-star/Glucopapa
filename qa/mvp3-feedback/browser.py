"""Exercise the approved screens through the existing shell, with synthetic inputs."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def check_ui(browser, origin, output, baseline):
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    page.goto(origin + '/index.html')
    page.wait_for_function('()=>window.GPApp?.getStorage()')
    page.evaluate("GPApp.open('approved-low')")
    low = page.frame_locator('#iframeLowTarget')
    low.locator('#calculate').wait_for()
    state = lambda: page.evaluate('GPApp.getStorage().exportState()')
    assert not state()['mealSessions']
    if not baseline:
        expect(low.locator('#calcProduct option')).to_have_count(7)
        low.locator('#calcProduct').select_option(label='Яблоко · г')
        low.locator('#juiceNumber').fill('50')
        low.locator('#calculate').click()
        assert not state()['mealSessions']
        expect(low.locator('#calcResult')).to_be_visible()
        page.once('dialog', lambda dialog: dialog.accept())
        low.locator('#journal').click()
        page.wait_for_function('()=>GPApp.getStorage().exportState().mealSessions.length===1')
        fact, = state()['mealSessions']
        assert fact['status'] == 'completed' and fact['actualPlate']['items'][0]['amount'] == 50
        assert page.evaluate('GPApp.back()')
        assert page.locator('.screen.active').get_attribute('id') == 'screen-home'
        page.screenshot(path=output / 'feedback-home.png')
    products = low.locator('#calcProduct option').count()
    page.evaluate("GPApp.open('approved-settings')")
    settings = page.frame_locator('#iframeApprovedSettings')
    settings.locator('#pName').fill('SYNTHETIC_PROFILE')
    birth = page.evaluate('new Date().getUTCFullYear()-7')
    settings.locator('#pBirth').fill(f'{birth}-01-01')
    settings.locator('#pSex').select_option('male')
    settings.locator('#pZone').fill('Europe/Minsk')
    settings.locator('#profileForm button[type=submit]').click()
    page.wait_for_function("()=>GPApp.getStorage().exportState().profile.displayName==='SYNTHETIC_PROFILE'")
    settings.locator('[data-tab=measurements]').click()
    settings.locator('#mWeight').fill('20')
    settings.locator('#mHeight').fill('120')
    settings.locator('#mDate').fill('')
    settings.locator('#measurementForm button[type=submit]').click()
    page.wait_for_function('()=>GPApp.getStorage().exportState().measurements.length===1')
    visible = '120 см' in settings.locator('#measurementsList').inner_text()
    if not baseline:
        assert visible
        settings.locator('#mHeight').fill('12')
        assert not settings.locator('#mHeight').evaluate('(node)=>node.checkValidity()')
        settings.locator('[data-tab=history]').click()
        expect(settings.locator('#historyList')).to_contain_text('Измерение')
        page.reload()
        page.evaluate("GPApp.open('approved-settings')")
        settings.locator('[data-tab=measurements]').click()
        expect(settings.locator('#measurementsList')).to_contain_text('20 кг')
        expect(settings.locator('#measurementsList')).to_contain_text('120 см')
        assert state()['profile']['dailyNutritionReference']['groupId'] == '7-10'
        page.screenshot(path=output / 'feedback-measurements.png')
        check_food_diary_coefficients(page, output, state)
    assert state()['measurements'][0]['heightCm'] == 120
    return dict(status='PASS', baseline=baseline, lowOptions=products, measurementsPersist=True,
                writtenMeasurementVisible=visible, backMethod=page.evaluate("typeof GPApp.back"), foodDiaryCoefficients=not baseline)


def check_food_diary_coefficients(page, output, state):
    page.evaluate("GPApp.open('approved-nutrition')")
    food=page.frame_locator('#iframeApprovedNutrition')
    expect(food.locator('.brand h1')).to_have_text('ГлюкоПапа Еда')
    food.locator('[data-tab=restaurants]').click()
    food.locator('[data-venue=batski]').click()
    food.locator('[data-venuecat="Драники"]').click()
    food.locator('#venueFoods button.food-main').get_by_text('Драник деревенский с мясом', exact=True).click()
    expect(food.locator('#foodModal')).to_be_visible()
    assert page.evaluate('GPApp.back()')
    expect(food.locator('#foodModal')).to_be_hidden()
    food.locator('#venueFoods button.food-main').get_by_text('Драник деревенский с мясом', exact=True).click()
    food.locator('#portionAmount').fill('75')
    food.locator('#addToPlate').click()
    expect(food.locator('#tab-plate')).to_be_visible()
    expect(food.locator('#plateItems')).to_contain_text('Драник деревенский с мясом')
    assert not state()['events']
    food.locator('#plateCalculate').click()
    expect(page.locator('#mealModelDose')).to_have_value('Недоступно')
    assert not state()['events']
    assert page.locator('#injectionConfirm').count() == 0
    page.locator('#injectionUnits').fill('0.5')
    page.locator('#saveActualInjection').click()
    page.wait_for_function('()=>GPApp.getStorage().exportState().events.length===1')
    saved=state()
    event,=saved['events']
    assert event['linkedMealSessionId'] and event['status']=='confirmed'
    assert event['units']==.5 and event['insulinId']=='rinfast'
    assert not next(row for row in saved['mealSessions'] if row['id']==event['linkedMealSessionId'])['actualPlate']

    page.evaluate("GPApp.open('approved-journal')")
    journal=page.frame_locator('#iframeApprovedJournal')
    journal.locator('#journalSpan').select_option('3')
    expect(journal.locator('#dailyStats')).to_contain_text('РинФаст')
    expect(journal.locator('#dailyStats')).to_contain_text('0,5 ЕД')
    expect(journal.locator('#dailyStats')).to_contain_text('Съедено 6,9 г')
    assert journal.locator('thead th').count()==3
    journal.locator('#journalSpan').select_option('7')
    expect(journal.locator('#dailyStats')).to_contain_text('0,5 ЕД')
    journal.locator('#journalSpan').select_option('custom')
    day=journal.locator('#date').input_value()
    journal.locator('#journalStart').fill(day)
    journal.locator('#journalEnd').fill(day)
    expect(journal.locator('#dailyStats')).to_contain_text('0,5 ЕД')
    assert state()==saved
    page.screenshot(path=output/'feedback-journal.png')

    page.evaluate("GPApp.open('coefficients')")
    expect(page.locator('#coefficientWindow option')).to_have_count(4)
    page.locator('#coefficientValue').fill('10')
    page.locator('#coefficientApply').click()
    expect(page.locator('#coefficientHistory')).to_contain_text('10')
    page.locator('#coefficientMode').select_option('auto')
    expect(page.locator('#coefficientApply')).to_be_disabled()
    page.locator('#coefficientRecalculate').click()
    expect(page.locator('#coefficientMessage')).to_contain_text('сопоставленных пар')
    assert len(state()['coefficients'])==1
    page.reload()
    page.evaluate("GPApp.open('coefficients')")
    expect(page.locator('#coefficientMode')).to_have_value('auto')
    assert len(state()['events'])==1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--web',type=Path,default=Path(__file__).resolve().parents[2]/'android-mvp3/app/src/main/assets/www')
    parser.add_argument('--baseline',action='store_true')
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=args.web))
    thread=Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True)
            result=check_ui(browser,f'http://127.0.0.1:{server.server_port}',args.output,args.baseline)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    text=json.dumps(result,indent=2)+'\n'
    (args.output/'report.json').write_text(text)
    print(text,end='')


if __name__=='__main__':
    main()
