"""Exercise the two new routes on ordinary loopback resources with Chromium sandbox enabled."""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect,sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def open_high(page):
    page.evaluate("GPApp.open('approved-high')")
    page.wait_for_function("""()=>document.getElementById('iframeHighTarget')
        .contentDocument?.getElementById('status')?.dataset.code""")
    return page.frame_locator('#iframeHighTarget')


def persisted(page):
    return page.evaluate('GPApp.getStorage().exportState()')


def layout_and_fact(browser, origin, output):
    page = browser.new_page(viewport={'width':390,'height':900},locale='ru-RU',timezone_id='UTC')
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(origin+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    ui=open_high(page)
    for width in [320,390,428,1280]:
        page.set_viewport_size({'width':width,'height':900})
        assert ui.locator('#act option').all_text_contents()==['Обычная','Высокая','Спорт']
        assert ui.locator('#activityEnabled').is_checked()
        assert ui.locator('#preview').input_value()==''
        assert ui.locator('#dose').inner_text()=='— ЕД'
        assert ui.locator('#record').is_disabled()
        assert ui.locator('script').count()==0 and ui.locator('#oldDose,#glucose,#carbs').count()==0
        assert ui.locator('html').evaluate('node=>node.scrollWidth<=innerWidth')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        ys=[ui.locator(id).evaluate('el=>el.getBoundingClientRect().top') for id in [
            '#target','#activityEnabled','#compute','#dose','#preview','#chart','#site','#record']]
        assert ys==sorted(ys) and len(set(ys))==len(ys)
        page.locator('#iframeHighTarget').scroll_into_view_if_needed()
        page.screenshot(path=output/f'high-{width}.png',full_page=True)
    page.set_viewport_size({'width':390,'height':900})
    assert ui.locator('#status').get_attribute('data-code')=='CGM_SOURCE_UNKNOWN'
    ui.locator('#compute').click()
    assert ui.locator('#dose').inner_text()=='Недоступно'
    assert persisted(page)['events']==[]
    ui.locator('#target').fill('5')
    ui.locator('#target').press('Tab')
    ui.locator('#act').select_option('high')
    ui.locator('#activityEnabled').uncheck()
    ui.locator('#scenarioSettings summary').click()
    ui.locator('#coeffHigh').fill('1.07')
    ui.locator('#coeffHigh').press('Tab')
    assert persisted(page)['profile']['highTarget']['valueMmol']==5
    assert persisted(page)['profile']['highActivity']['coefficients']['high']==1.07
    ui.locator('#preview').fill('0.5')
    ui.locator('#site').select_option('abdomen')
    old=persisted(page)
    page.once('dialog',lambda dialog:dialog.dismiss())
    ui.locator('#record').click()
    assert persisted(page)==old
    asked=[]
    def accept(dialog):
        asked.append(dialog.message)
        dialog.accept()
    page.once('dialog',accept)
    ui.locator('#record').click()
    assert len(asked)==1 and '0,5 ЕД' in asked[0] and 'живот' in asked[0]
    assert ui.locator('#record').is_disabled()
    saved=persisted(page)
    assert len(saved['events'])==1 and saved['events'][0]['injectionSite']=={'region':'abdomen'}
    assert saved['events'][0]['status']=='confirmed'
    assert ui.locator('#preview').input_value()==''
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    ui=open_high(page)
    assert persisted(page)==saved
    assert ui.locator('#target').input_value()=='5'
    assert ui.locator('#act').input_value()=='high'
    assert not ui.locator('#activityEnabled').is_checked()
    page.evaluate("GPApp.open('approved-journal')")
    page.frame_locator('#iframeApprovedJournal').get_by_text('РинФаст',exact=False).first.wait_for()
    assert not errors,errors
    page.close()
    return {'widths':[320,390,428,1280],'no_hypothetical_fact':True,'confirmed_only':True,
            'revision':saved['revision'],'reloaded_settings_and_site':True,'protected_markup_order':True}


def synthetic_preview(browser,origin,output):
    page=browser.new_page(viewport={'width':390,'height':900})
    page.clock.set_fixed_time(datetime(2026,11,19,12,0,tzinfo=timezone.utc))
    page.goto(origin+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    page.once('dialog',lambda dialog:dialog.accept())
    page.evaluate("document.getElementById('modeDemo').click()")
    assert page.evaluate('GPApp.mode()')=='demo'
    page.evaluate("""()=>{
      const h=GPApp.getStorage(),now=Date.now(),m=60000,iso=x=>new Date(x).toISOString();
      const p=h.connect('settings'),s=GFSettings.createSettingsService({settingsPort:p});
      s.saveProfile({timeZone:'UTC'},p.getRevision());
      s.setHighSettings({targetMmol:6},p.getRevision());
      for(const [kind,value] of [['carb_g_per_u',12],['isf_mmol_per_u',3]])s.addCoefficient({
         kind,value,source:'manual',effectiveFrom:iso(now-m),windowLocal:{from:'12:00',to:'18:00'}},p.getRevision());
      const writer=h.connect('actionWriter');
      writer.setCoverage({confirmedComplete:true,declaredBy:'parent',startIso:iso(now-49*60*m),endIso:iso(now+10*m)},writer.getRevision());
      const sensor=h.connect('cgmAdapter');
      sensor.setSourceMetadata({sourceDeviceId:'SYNTHETIC-HIGH-WEB',sourceType:'synthetic',samplingMinutes:5,qualityScore:1},sensor.getRevision());
      sensor.ingestReadings([20,15,10,5,0].map(offset=>({ts:now-offset*m,receivedAt:iso(now-offset*m),
          sourceDeviceId:'SYNTHETIC-HIGH-WEB',mmol:12,valid:true,qualityFlag:'ok'})),sensor.getRevision());
    }""")
    ui=open_high(page)
    page.get_by_text('Подтверждение истории еды',exact=True).click()
    page.locator('#w06cStudyHigh button').first.click()
    ui.locator('#preview').fill('1')
    curve=ui.locator('#chart [data-curve=preview]')
    curve.wait_for()
    first=curve.get_attribute('d')
    ui.locator('#preview').fill('2')
    assert first!=curve.get_attribute('d')
    ui.locator('#compute').click()
    assert ui.locator('#dose').inner_text()!='— ЕД'
    assert ui.locator('.headBadge').inner_text()=='Синтетический журнал'
    assert persisted(page)['events']==[]
    assert ui.locator('#site').input_value()==''
    page.screenshot(path=output/'high-synthetic-preview.png')
    page.close()
    return {'preview_recomputed':True,'mode':'SYNTHETIC','no_injection_record':True}


def timing_panel(browser,origin,output):
    page=browser.new_page(viewport={'width':390,'height':900})
    page.clock.set_fixed_time(datetime(2026,11,19,12,0,tzinfo=timezone.utc))
    page.goto(origin+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("""()=>{
      const host=GPApp.getStorage(),now=Date.now(),iso=x=>new Date(x).toISOString();
      const plate={schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:iso(now),
          containsEstimatedValues:false,items:[{kind:'manual',foodId:null,name:'Синтетическая порция',amount:75,
            unit:'г',carbs:15,fat:0,protein:0,kcal:60,glycemicIndex:49,glycemicIndexStatus:'verified',nutritionStatus:'label_verified'}],
          totals:{amount:75,count:1,carbs:15,fat:0,protein:0,kcal:60}};
      const c=GFMealController.createController(host);
      c.createFromFood(plate,'fact');c.ready('fact');c.startMeal('fact',iso(now-60000),{actuallyStarted:true});
      c.actualFood('fact',plate,{parentConfirmed:true});c.finishMeal('fact',iso(now),{confirmed:true});
      c.createFromFood(plate,'plan-only');
      GPApp.open('injection-sites');
    }""")
    before=persisted(page)
    page.locator('#timingHistoryPanel summary').click()
    select=page.locator('#timingHistorySession')
    expect(select.locator('option')).to_have_count(2)
    select.select_option('fact')
    page.locator('#timingHistoryRun').click()
    result=json.loads(page.locator('#timingHistoryResult').text_content())
    assert result['code']=='CONFIRMED_MEAL_INJECTION_REQUIRED'
    assert result['descriptiveLagMinutes'] is None
    assert page.evaluate('GFInjectionAnalytics.VERSION').startswith('0.1.1')
    assert page.evaluate('GFInjectionAnalyticsV2.VERSION')=='0.2.1-history-only'
    assert persisted(page)==before
    page.screenshot(path=output/'timing-history-no-data.png')
    page.close()
    return {'statuses':['NO_DATA'],'draft_excluded':True,'read_only':True,'legacy_sites_available':True}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    web=Path(__file__).resolve().parents[2]/'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=web)) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as engine:
                browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
                try:
                    origin=f'http://127.0.0.1:{server.server_port}'
                    report={'status':'PASS','high':layout_and_fact(browser,origin,args.output),
                            'synthetic_preview':synthetic_preview(browser,origin,args.output),
                            'timing':timing_panel(browser,origin,args.output)}
                finally:
                    browser.close()
        finally:
            server.shutdown()
    text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    (args.output/'report.json').write_text(text)
    print(text,end='')


if __name__=='__main__':
    main()
