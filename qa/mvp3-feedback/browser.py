"""Exercise the approved screens through the existing shell, with synthetic inputs."""
import argparse
from datetime import datetime
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
    if baseline:
        settings.locator('[data-tab=measurements]').click()
    else:
        expect(settings.locator('#measurementForm')).to_be_visible()
    settings.locator('#mWeight').fill('20')
    settings.locator('#mHeight').fill('120')
    settings.locator('#mDate').fill('')
    settings.locator('#measurementForm button[type=submit]').click()
    page.wait_for_function('()=>GPApp.getStorage().exportState().measurements.length===1')
    visible = '120 см' in settings.locator('#measurementsList').inner_text()
    if not baseline:
        assert visible
        expect(settings.locator('#growthValues')).to_contain_text('ИМТ 13,9')
        expect(settings.locator('nav')).to_be_hidden()
        expect(settings.locator('.warning')).to_be_hidden()
        expect(page.locator('.app-header .brand-title')).to_have_text('ГлюкоПапа')
        expect(page.locator('#screen-approved-settings [data-screen=cgm]')).to_have_count(0)
        expect(page.locator('#screen-approved-settings #gfCarbMode')).to_have_count(0)
        expect(page.locator('#nav button')).to_have_count(6)
        assert page.locator('#nav').evaluate("(n)=>getComputedStyle(n).position")=='fixed'
        settings.locator('#mHeight').fill('12')
        assert not settings.locator('#mHeight').evaluate('(node)=>node.checkValidity()')
        expect(settings.locator('#tab-history')).to_be_visible()
        expect(settings.locator('#historyList')).to_contain_text('Измерение')
        page.reload()
        page.evaluate("GPApp.open('approved-settings')")
        expect(settings.locator('#measurementForm')).to_be_visible()
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
    expect(food.locator('.brand h1')).to_have_text('Продукты')
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
    expect(food.locator('#gpFoodReference')).to_contain_text('норма')
    food.locator('#openPantry').click()
    expect(food.locator('#pantryModal')).to_be_visible()
    expect(page.locator('#nav')).to_be_visible()
    food.locator('#donePantry').click()
    food.locator('#balanceFood').click()
    expect(food.locator('#suggestionResults')).to_contain_text('норма этого приёма пищи')
    expect(food.locator('#plateItems')).to_contain_text('Драник деревенский с мясом')
    assert not state()['events']
    food.locator('#mealType').select_option('breakfast')
    page.locator('#approvedSavePlate').click()
    page.wait_for_function("()=>GPApp.getStorage().exportState().mealSessions.some(row=>row.mealType==='breakfast')")
    draft=next(row for row in state()['mealSessions'] if row.get('mealType')=='breakfast')
    food.locator('#mealType').select_option('lunch')
    food.locator('#plateCalculate').click()
    try:
        expect(page.locator('#screen-approved-meal.active')).to_be_visible(timeout=4000)
    except AssertionError as error:
        raise AssertionError(page.locator('#notice').text_content()) from error
    workflow=page.frame_locator('#iframeApprovedMeal')
    expect(workflow.locator('#doseSuggested')).to_have_text('—')
    assert not state()['events']
    workflow.locator('#confirmPlate').click()
    workflow.locator('#doseChosen').fill('0.5')
    workflow.locator('#shotSite').select_option('abdomen')
    page.once('dialog', lambda dialog: dialog.accept())
    workflow.locator('#confirmInjection').click()
    page.wait_for_function('()=>GPApp.getStorage().exportState().events.length===1')
    saved=state()
    event,=saved['events']
    assert event['linkedMealSessionId'] and event['status']=='confirmed'
    assert event['units']==.5 and event['insulinId']=='rinfast'
    meal=next(row for row in saved['mealSessions'] if row['id']==event['linkedMealSessionId'])
    assert not meal['actualPlate'] and meal['mealType']=='lunch' and meal['id']==draft['id']

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
    page.evaluate('''() => {
      const port=GPApp.getStorage().connect('actionWriter');
      for(const [id,at] of [['synthetic-oct','2026-10-31T09:00:00+03:00'],['synthetic-nov','2026-11-01T09:00:00+03:00']])
        port.recordInjection({id,insulinId:'rinfast',units:.5,administeredAt:at},port.getRevision());
    }''')
    journal.locator('#journalStart').fill('2026-10-31')
    journal.locator('#journalEnd').fill('2026-11-01')
    expect(journal.locator('tbody tr')).to_have_count(2)
    expect(journal.locator('#dailyStats')).to_contain_text('1 ЕД')
    expect(journal.locator('#monthLabel')).to_have_text('2026-11-01 — 2026-11-01')
    journal.locator('#journalEnd').fill('2026-10-31')
    expect(journal.locator('#monthLabel')).to_have_text('2026-10-01 — 2026-10-31')
    expect(journal.locator('#dailyStats')).to_contain_text('0,5 ЕД')

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
    assert len(state()['events'])==3


def check_cgm_controls(browser, origin, output):
    page=browser.new_page(viewport={'width':390,'height':850})
    page.add_init_script('''(() => {
      const at=Date.now()-5*60*1000;
      const point=()=>({status:'MEASUREMENT',measuredAtMs:at,receivedAtMs:Date.now(),
        direction:'Flat',stale:false});
      window.qaWebUp=true;
      window.GFNativeXDrip={
        pollLatest(){},peekLatest(){return JSON.stringify({...point(),mgdl:150.7});}
      };
      window.GFNativeXDripHistory={
        requestLatest(){return JSON.stringify({status:'HISTORY_FETCHING'});},
        takeLatest(){return JSON.stringify(qaWebUp?{...point(),mgdl:150,deltaMgdl:-1.002,
          device:'Follower',transport:'xdrip_loopback_live'}:{status:'HISTORY_UNAVAILABLE'});}
      };
    })();''')
    page.goto(origin+'/index.html')
    page.evaluate("GPApp.open('cgm')")
    expect(page.locator('#xdripStatus')).to_have_text('Чтение выключено')
    page.locator('#xdripEnabled').check()
    expect(page.locator('#xdripStatus')).to_contain_text('Локальный Web Service')
    expect(page.locator('#xdripStatus')).to_contain_text('8,3 ммоль/л')
    expect(page.locator('#xdripStatus')).to_contain_text('получено')
    assert page.evaluate("GPApp.getStorage().exportState().cgm[0].transport")=='xdrip_loopback_live'
    page.evaluate('window.qaWebUp=false')
    page.locator('#refreshXdrip').click()
    expect(page.locator('#xdripStatus')).to_contain_text('ContentProvider')
    expect(page.locator('#xdripStatus')).to_contain_text('8,4 ммоль/л')
    cgm=page.evaluate('GPApp.getStorage().exportState().cgm')
    assert len(cgm)==1 and cgm[0]['mgdl']==150.7
    page.locator('#xdripSourceMode').select_option('web')
    expect(page.locator('#xdripStatus')).to_have_text('Web Service выключен или недоступен')
    assert page.evaluate('GPApp.getStorage().exportState().cgm')==cgm
    page.locator('#xdripEnabled').uncheck()
    expect(page.locator('#xdripStatus')).to_have_text('Чтение выключено')
    page.screenshot(path=output/'feedback-cgm.png')
    page.close()



def check_cgm_window(browser, origin):
    page=browser.new_page(viewport={'width':390,'height':850})
    page.add_init_script("""(() => {
      const now=Date.now(), at=now-300000;
      const newest={status:'MEASUREMENT',measuredAtMs:at,receivedAtMs:now,mgdl:150,
        direction:'Flat',stale:false,device:'Follower',transport:'xdrip_loopback_live',deltaMgdl:-1.002};
      window.qaRequested=0;
      window.GFNativeXDrip={pollLatest(){},peekLatest(){return JSON.stringify({status:'NO_PROVIDER'})}};
      window.GFNativeXDripHistory={
        requestWindow(){window.qaRequested++;return JSON.stringify({status:'HISTORY_FETCHING'})},
        take(){return JSON.stringify({status:'WEB_WINDOW_READY',latest:newest,futureCount:1,
          futureMeasuredAtMs:now+120000,items:[{measuredAtMs:at-300000,mgdl:145,direction:'Flat'}]})},
        requestLatest(){return JSON.stringify({status:'HISTORY_FETCHING'})},
        takeLatest(){return JSON.stringify({status:'WEB_FUTURE_MEASUREMENT',measuredAtMs:now+120000,receivedAtMs:now})}
      };
    })();""")
    page.goto(origin+'/index.html')
    page.evaluate("GPApp.open('cgm')")
    page.locator('#xdripEnabled').check()
    expect(page.locator('#xdripStatus')).to_contain_text('пропущено будущих: 1')
    expect(page.locator('#xdripStatus')).to_contain_text('опережение 120 с')
    assert page.evaluate("qaRequested") == 1
    rows=page.evaluate("GPApp.getStorage().exportState().cgm")
    assert [row['mgdl'] for row in rows]==[145,150]
    assert rows[0]['transport']=='xdrip_loopback_history'
    page.locator('#restoreXdripHistory').click()
    expect(page.locator('#xdripHistoryStatus')).to_contain_text('добавлено: 0')
    assert page.evaluate("GPApp.getStorage().exportState().cgm")==rows
    page.close()


def check_meal_time_defaults(browser, origin):
    for hour, minute, expected in [(7,59,''),(8,0,'breakfast'),(10,59,'breakfast'),
                                    (11,0,'lunch'),(16,59,'lunch'),(17,0,'dinner')]:
        page=browser.new_page(timezone_id='Europe/Minsk')
        page.clock.set_fixed_time(datetime.fromisoformat(f'2026-11-20T{hour:02d}:{minute:02d}:00+03:00'))
        page.goto(origin+'/index.html')
        page.evaluate("GPApp.open('approved-nutrition')")
        food=page.frame_locator('#iframeApprovedNutrition')
        expect(food.locator('.brand h1')).to_have_text('Продукты')
        expect(food.locator('#mealType')).to_have_value(expected)
        page.close()



def check_journal_periods(browser, origin, output):
    page = browser.new_page(viewport={'width': 390, 'height': 850}, timezone_id='Europe/Minsk')

    def moment(time):
        return '2026-11-20T' + time + ':00+03:00'

    page.clock.set_fixed_time(datetime.fromisoformat(moment('09:00')))
    page.goto(origin + '/index.html')
    page.wait_for_function('()=>window.GPApp?.getStorage()')
    for time, role, method, data in [
        ('09:00', 'sport', 'startSport', {'id': 'synthetic-qa-sport', 'start': moment('09:00')}),
        ('09:30', 'sport', 'finishSport', {'id': 'synthetic-qa-sport', 'end': moment('09:30')}),
        ('10:00', 'context', 'openPeriod', {'id': 'synthetic-qa-illness', 'kind': 'illness', 'start': moment('10:00')}),
        ('12:00', 'context', 'closePeriod', {'id': 'synthetic-qa-illness', 'end': moment('12:00')}),
    ]:
        page.clock.set_fixed_time(datetime.fromisoformat(moment(time)))
        page.evaluate('''([role, method, data]) => {
            const p = GPApp.getStorage().connect(role);
            p[method](data, p.getRevision());
        }''', [role, method, data])

    page.reload()
    page.evaluate("GPApp.open('approved-journal')")
    journal = page.frame_locator('#iframeApprovedJournal')
    sport = journal.locator('tr.sport-period')
    illness = journal.locator('tr.ill').filter(has_text='Начало периода болезни')
    illness_end = journal.get_by_role('row').filter(has_text='Завершение периода болезни')
    expect(sport).to_contain_text('09:00–09:30')
    expect(sport).to_contain_text('Длительность: 30 мин')
    expect(illness).to_contain_text('10:00')
    expect(illness_end).to_contain_text('12:00')
    expect(illness_end).to_contain_text('Длительность: 120 мин')
    expect(journal.locator('.legend')).to_contain_text('Период спорта')
    expect(journal.locator('.legend')).to_contain_text('Период болезни')
    sport_color = sport.locator('td').first.evaluate('(td)=>getComputedStyle(td).backgroundColor')
    illness_color = illness.locator('td').first.evaluate('(td)=>getComputedStyle(td).backgroundColor')
    assert sport_color != illness_color
    periods = page.evaluate('GPApp.getStorage().exportState().conditionPeriods')
    durations = {
        p['kind']: (datetime.fromisoformat(p['end']) - datetime.fromisoformat(p['start'])).total_seconds() / 60
        for p in periods
    }
    assert durations == {'sport': 30, 'illness': 120}
    page.screenshot(path=output / 'feedback-periods.png')
    page.close()
    return {
        'status': 'PASS_SCOPED', 'mode': 'SYNTHETIC_ONLY', 'environment': 'BROWSER_MULTI_FILE',
        'sport': {'start': '09:00', 'end': '09:30', 'minutesDisplayed': 30, 'background': sport_color},
        'illness': {'start': '10:00', 'end': '12:00', 'minutesDisplayed': 120, 'background': illness_color},
        'persistedDurationsMinutes': durations, 'bothIntervalsAfterReload': True, 'androidRendering': 'NOT_TESTED',
    }


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
            if not args.baseline:
                check_cgm_controls(browser,f'http://127.0.0.1:{server.server_port}',args.output)
                result['syntheticLiveSwitchAndDeduplication']=True
                check_cgm_window(browser, f'http://127.0.0.1:{server.server_port}')
                result['syntheticWebWindowAndClockDiagnostics']=True
                result['settingsWhoAndSingleLayout']=True
                result['pantryAndNorms']=True
                check_meal_time_defaults(browser,f'http://127.0.0.1:{server.server_port}')
                result['localMealTimeBoundaries']=['07:59','08:00','10:59','11:00','16:59','17:00']
                periods = check_journal_periods(browser, f'http://127.0.0.1:{server.server_port}', args.output)
                (args.output/'periods.json').write_text(json.dumps(periods, ensure_ascii=False, indent=2)+'\n')
                result['journalPeriods'] = periods['status']
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
