(() => {
    'use strict';
    const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const ensure = (value,msg) => { if(!value) throw Error(msg); };
    const localInput = value => {
        const date = new Date(value);
        return new Date(value-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
    };
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
            get('shotTime').value=localInput(now);
            get('shotSite').value='abdomen';
            get('shotSite').dispatchEvent(new Event('input',{bubbles:true}));
            ensure(get('minutesChosen').readOnly&&Number(get('minutesChosen').value)>=10&&
                get('minutesExplain').textContent.includes('6 случаев'),'Native WebView got no actual GFIA result');
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
            'Fact or timing evidence missing');
        ensure(get('confirmInjection').disabled&&get('timerText').textContent!=='--:--','Restored timer unavailable');
        const raw=JSON.parse(GFNativeStorage.readSnapshot('GFV2SHELL_DATA_v1_local'));
        ensure(raw.code==='FOUND'&&raw.data===JSON.stringify(state),'SQLite missed the same revision');
        return {status:'PASS',data:'SYNTHETIC_ONLY',phase,revision:state.revision,matchedCases:timing.estimate.matchedCases,
            estimateMinutes:timing.estimate.minutes,timer:get('timerText').textContent,confirmedWrites:1,sqlite:true};
    })().then(result=>window.__glucopapaQA=result).catch(err=>window.__glucopapaQA={status:'FAIL',error:String(err)});
})();
