(() => {
    'use strict';
    const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const ensure = (value,msg) => { if(!value) throw Error(msg); };
    window.__glucopapaQA = null;
    (async () => {
        ensure(GPApp.mode()==='local','Expected isolated fixture in its local journal');
        const store=GPApp.getStorage();
        const phase=window.__glucopapaQAAction;
        window.__glucopapaQAStage='timing-fixture';
        const now=Math.floor(Date.now()/60000)*60000;
        if(phase==='write')GFMealTimingQACase.prepare(store,now);
        GPApp.open('approved-meal');
        let doc=null;
        for(let attempt=0;attempt<120;attempt++){
            doc=document.getElementById('iframeApprovedMeal').contentDocument;
            if(doc?.getElementById('chooseMeal')?.options.length)break;
            await wait(100);
        }
        const get=id=>doc.getElementById(id);
        ensure(get('chooseMeal').options.length===7,'Meal form not mounted');
        const id='qa-current-meal';
        get('chooseMeal').value=id;
        get('chooseMeal').dispatchEvent(new Event('change',{bubbles:true}));
        if(phase==='write'){
            window.__glucopapaQAStage='historical-preview';
            get('doseChosen').value='2';
            // The shot is confirmed after the synthetic activity settings were stored.
            // A backdated form must not claim that newer settings were effective.
            get('shotTime').value='';
            get('shotSite').value='abdomen';
            get('shotSite').dispatchEvent(new Event('input',{bubbles:true}));
            const proposed=store.connect('mealTiming').readPreview(id);
            if(!get('minutesChosen').readOnly||Number(get('minutesChosen').value)<10||
                !get('minutesExplain').textContent.includes('6 случаев')){
                const reference=GFMealTimingService.refresh(store,{sessionId:id,units:2,site:'abdomen',
                    atIso:new Date().toISOString(),mode:'local'});
                throw Error('Meal timing preview: '+JSON.stringify({computed:reference.code||reference.estimate?.matchedCases,
                    shown:get('minutesChosen').value,reason:proposed?.code,explanation:get('minutesExplain').textContent,
                    time:get('shotTime').value,validDose:get('doseChosen').checkValidity(),selected:get('chooseMeal').value}));
            }
            ensure(get('timerText').textContent==='--:--'&&store.exportState().events.length===6,
                'Proposal modified the journal');
            window.__glucopapaQAStage='atomic-save';
            const confirm=window.confirm;
            try {
                window.confirm=()=>true;
                get('confirmInjection').click();
                get('confirmInjection').click();
            } finally { window.confirm=confirm; }
        }
        window.__glucopapaQAStage='snapshot-validation';
        const state=store.exportState(), shot=state.events.at(-1), timing=shot.mealTiming;
        ensure(state.events.length===7&&shot.linkedMealSessionId===id&&timing?.injectionId===shot.id&&
            timing.estimate.version==='0.2.1-history-only'&&timing.referenceAt===shot.administeredAt,
            'Fact or timing evidence missing: '+get('mealOperationStatus').textContent);
        ensure(get('confirmInjection').disabled&&get('timerText').textContent!=='--:--','Restored timer unavailable');
        const raw=JSON.parse(GFNativeStorage.readSnapshot('GFV2SHELL_DATA_v1_local'));
        ensure(raw.code==='FOUND'&&raw.data===JSON.stringify(state),'SQLite missed the same revision');
        return {status:'PASS',data:'SYNTHETIC_ONLY',phase,revision:state.revision,matchedCases:timing.estimate.matchedCases,
            estimateMinutes:timing.estimate.minutes,timer:get('timerText').textContent,confirmedWrites:1,sqlite:true};
    })().then(result=>window.__glucopapaQA=result).catch(err=>window.__glucopapaQA={status:'FAIL',error:String(err)});
})();
