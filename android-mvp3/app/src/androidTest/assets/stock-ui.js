(() => {
    'use strict';
    const assert = (test, message) => { if (!test) throw Error(message); };
    const by = id => document.getElementById(id);
    const snapshot = () => GPApp.getStorage().exportState();
    const click = id => by(id).click();

    window.__glucopapaQA = null;
    (async () => {
        const action = window.__glucopapaQAAction;
        if (action === 'select-demo') {
            assert(GPApp.mode() === 'local', 'Fresh install must open local journal');
            assert(snapshot().revision === 0 && !snapshot().cgm.length && by('syntheticCgmTools').hidden,
                'Fresh journal must not contain test readings');
            assert(globalThis.GFNativeXDrip && !by('xdripEnabled').checked, 'xDrip+ must initially be disabled');
            assert(by('backupControls').hidden === false && typeof AndroidExporter.openBackup === 'function',
                'Native backup controls are unavailable');
            GFNativeXDrip.pollLatest();
            const cutoff = Date.now() + 6000;
            let source;
            do {
                source = JSON.parse(GFNativeXDrip.peekLatest()).status;
                if (source !== 'READING') break;
                await new Promise(resolve => setTimeout(resolve, 125));
            } while (Date.now() < cutoff);
            assert(source === 'NO_PROVIDER' && snapshot().revision === 0,
                'An AVD with no xDrip+ should not create a CGM record');
            const previous = window.confirm;
            try {
                window.confirm = () => true;
                click('modeDemo');
            } finally { window.confirm = previous; }
            assert(GPApp.mode() === 'demo' && snapshot().revision === 0, 'Synthetic fixture failed to open');
            assert(GFShellPreferences.read('GFV2SHELL_MODE_v1') === 'demo' &&
                !GFShellPreferences.write('GFV2SHELL_DATA_v1_demo', '{}'), 'Preference bridge must be scoped');
            return {status: 'PASS', fixture: 'SYNTHETIC', step: action, fresh_local: true};
        }
        assert(GPApp.mode() === 'demo', 'Expected synthetic journal');
        if (action === 'home' || action === 'restored') {
            assert(by('modeBadge').textContent.includes('Тестовые данные'), 'Missing synthetic label');
            if (action === 'restored') assert(snapshot().revision === 1, 'Missing persisted revision');
        } else if (action === 'unconfirmed' || action === 'confirmed') {
            const revision = snapshot().revision;
            click('openHigh');
            assert(by('screen-approved-high').classList.contains('active'), 'HIGH route did not open');
            const deadline=Date.now()+10_000;
            const frame=by('iframeHighTarget');
            while ((!window.GFHighTargetView || !frame.contentDocument?.getElementById('record')) && Date.now()<deadline) {
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            assert(window.GFHighTargetView, 'HIGH bridge did not load');
            const ui=frame.contentDocument;
            const dose=ui.getElementById('preview'), site=ui.getElementById('site'), record=ui.getElementById('record');
            dose.value='0.5';
            dose.dispatchEvent(new Event('input',{bubbles:true}));
            site.value='abdomen';
            site.dispatchEvent(new Event('change',{bubbles:true}));
            assert(snapshot().revision === revision && !snapshot().events.length, 'Manual amount wrote a fact');
            assert(!record.disabled, 'Confirmed fact control is unavailable');
            const ask=window.confirm;
            let prompts=0;
            try{
                window.confirm=message=>{
                    assert(message.includes('уже введён')&&message.includes('живот'), 'Wrong fact confirmation');
                    prompts++;
                    return action==='confirmed';
                };
                record.click();
                if(action==='confirmed')record.click();
            } finally {window.confirm=ask;}
            const state=snapshot();
            if(action==='confirmed') {
                assert(prompts===1 && state.revision===revision+1 && state.events.length===1, 'Fact did not save exactly once');
                assert(state.events[0].injectionSite.region==='abdomen', 'Wrong HIGH site');
            } else {
                assert(state.revision===revision&&!state.events.length, 'Cancelled action modified the journal');
            }
        } else if (action.startsWith('ai-export:')) {
            const [, period, outcome] = action.split(':');
            const before = JSON.stringify(snapshot());
            GPApp.open('system');
            assert(!by('aiExportControls').hidden, 'Native JSONL controls unavailable');
            by('aiExportPeriod').value = period;
            assert(by('aiExportPeriod').value === period, 'Requested export period unavailable');
            click('saveAiExport');
            assert(by('saveAiExport').disabled, 'Export request did not enter pending state');
            const deadline = Date.now() + 65_000;
            while (by('saveAiExport').disabled && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            const message = by('aiExportStatus').textContent;
            assert(message === (outcome === 'cancel' ? 'Выгрузка отменена' : 'Выгрузка сохранена'), message);
            assert(JSON.stringify(snapshot()) === before, 'Export changed GFStorage');
            return {status: 'PASS', fixture: 'SYNTHETIC', step: action, revision: snapshot().revision, outcome};
        } else if (action === 'meal-model-save' || action === 'meal-model-restored') {
            GPApp.open('approved-settings');
            const selector = by('gfMealAbsorptionModel');
            const expectedModel = action === 'meal-model-save' ? 'GFForecast' : 'GFCOB';
            // GPApp is published before the final settings scripts are loaded on a cold WebView.
            const initialized = Date.now()+10_000;
            while ((!window.GFSettingsPanel || selector.value !== expectedModel) && Date.now()<initialized) {
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            assert(window.GFSettingsPanel && selector.value === expectedModel, 'Settings panel did not reflect the saved model');
            const original = snapshot();
            if (action === 'meal-model-save') {
                assert(selector.value === 'GFForecast', 'Unexpected default model');
                selector.value = 'GFCOB';
                selector.dispatchEvent(new Event('change', {bubbles:true}));
                GFSettingsPanel.refresh();
                assert(selector.value === 'GFCOB', 'Refresh discarded the selected model');
                click('gfMealAbsorptionSave');
            }
            const state = snapshot();
            assert(state.profile.mealAbsorptionModel?.id === 'GFCOB' &&
                state.profile.mealAbsorptionModel.version === '0.1.1', 'Selected version missing in GFStorage');
            assert(selector.value === 'GFCOB', 'UI and GFStorage do not agree');
            const key='GFV2SHELL_DATA_v1_demo';
            const saved=JSON.parse(GFNativeStorage.readSnapshot(key));
            assert(saved.code === 'FOUND' && saved.revision === state.revision, 'No SQLite confirmation');
            assert(JSON.parse(saved.data).profile.mealAbsorptionModel.version === '0.1.1',
                'Model version missing in native record');
            assert(JSON.stringify(state.events) === JSON.stringify(original.events) &&
                JSON.stringify(state.mealSessions) === JSON.stringify(original.mealSessions), 'Setting changed facts');
            if (action === 'meal-model-save') {
                assert(state.revision === original.revision+1, 'Duplicate or missing revision');
            }
            return {status:'PASS',fixture:'SYNTHETIC',step:action,revision:state.revision,
                model:state.profile.mealAbsorptionModel,sqlite:true};
        } else if(action==='high-settings-save'||action==='high-settings-restored'){
            GPApp.open('approved-high');
            const frame=by('iframeHighTarget');
            const until=Date.now()+10_000;
            while(!frame.contentDocument?.getElementById('status')?.dataset.code&&Date.now()<until){
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            const form=frame.contentDocument;
            assert(form.getElementById('status').dataset.code==='CGM_SOURCE_UNKNOWN','HIGH placeholder gate missing');
            const state=snapshot();
            if(action==='high-settings-save'){
                for(const [id,value] of [['target','5'],['act','high'],['coeffHigh','1.07']]){
                    const field=form.getElementById(id);
                    field.value=value;
                    field.dispatchEvent(new Event('change',{bubbles:true}));
                }
                const toggle=form.getElementById('activityEnabled');
                toggle.checked=false;
                toggle.dispatchEvent(new Event('change',{bubbles:true}));
            }
            const current=snapshot(), profile=current.profile;
            assert(profile.highTarget?.valueMmol===5&&profile.highActivity?.selectedLevel==='high'&&
                profile.highActivity.enabled===false&&profile.highActivity.coefficients.high===1.07,
                'HIGH preferences missing from GFStorage');
            assert(profile.activityBaseLevel===state.profile.activityBaseLevel, 'HIGH reset global activity');
            assert(form.getElementById('target').value==='5'&&!form.getElementById('activityEnabled').checked,
                'HIGH UI did not reflect its preferences');
            assert(JSON.stringify(current.events)===JSON.stringify(state.events), 'HIGH settings wrote a medical fact');
            const disk=JSON.parse(GFNativeStorage.readSnapshot('GFV2SHELL_DATA_v1_demo'));
            assert(disk.code==='FOUND'&&disk.revision===current.revision&&
                JSON.parse(disk.data).profile.highActivity.coefficients.high===1.07,'HIGH preferences missing from SQLite');
            return {status:'PASS',fixture:'SYNTHETIC',step:action,revision:current.revision,sqlite:true};
        } else if (action === 'low-fact-write' || action === 'low-fact-restored') {
            GPApp.open('approved-low');
            const frame = by('iframeLowTarget');
            const deadline = Date.now() + 10_000;
            while (!frame.contentDocument?.getElementById('lowTrace')?.textContent && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const doc = frame.contentDocument;
            const previous = snapshot();
            if (action === 'low-fact-write') {
                assert(previous.mealSessions.length === 1 && previous.mealSessions[0].status === 'completed',
                    'Expected the earlier synthetic catalog meal');
                const product = doc.getElementById('calcProduct');
                assert(product.options.length === 2, 'LOW did not read the confirmed catalog item');
                product.selectedIndex = 1;
                product.dispatchEvent(new Event('change', {bubbles: true}));
                const amount = doc.getElementById('juiceNumber');
                amount.value = '25';
                amount.dispatchEvent(new Event('input', {bubbles: true}));
                doc.getElementById('calculate').click();
                assert(snapshot().revision === previous.revision && doc.getElementById('applyResult').disabled,
                    'Calculation created a fact or offered a quantity');
                const record = doc.getElementById('journal');
                const confirm = window.confirm;
                let accept = false;
                try {
                    window.confirm = message => {
                        assert(message.includes('уже съедена') && message.includes('25 г'), 'Wrong LOW prompt');
                        return accept;
                    };
                    record.click();
                    assert(snapshot().revision === previous.revision, 'Cancelled LOW operation modified GFStorage');
                    accept = true;
                    record.click();
                    record.click();
                } finally { window.confirm = confirm; }
                assert(snapshot().revision === previous.revision + 1, 'LOW did not store one new revision');
            }
            const current = snapshot();
            const facts = current.mealSessions.filter(meal => meal.id.startsWith('low-'));
            assert(facts.length === 1 && facts[0].status === 'completed', 'LOW created missing or duplicate portions');
            const fact = facts[0];
            assert(fact.actualPlate.items[0].amount === 25 && fact.actualPlate.items[0].glycemicIndex === 49 &&
                Math.abs(fact.actualPlate.totals.carbs - 4.975) < 1e-8, 'LOW changed the factual portion');
            const saved = JSON.parse(GFNativeStorage.readSnapshot('GFV2SHELL_DATA_v1_demo'));
            assert(saved.code === 'FOUND' && saved.revision === current.revision &&
                JSON.stringify(JSON.parse(saved.data).mealSessions.find(row => row.id === fact.id)) === JSON.stringify(fact),
                'LOW fact missing from native SQLite');
            const exported = JSON.parse(GFAuditExportStorageAdapter.exportJson(GPApp.getStorage()));
            assert(JSON.stringify(exported.mealSessions.find(row => row.id === fact.id)) === JSON.stringify(fact),
                'LOW fact differs from export');
            GPApp.open('approved-journal');
            const diary = by('iframeApprovedJournal');
            const ready = Date.now() + 10_000;
            while (!diary.contentDocument?.querySelector('#tbody')?.textContent.includes('25 г') && Date.now() < ready) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert(diary.contentDocument.querySelector('#tbody').textContent.includes('25 г'), 'LOW fact missing from journal');
            return {status: 'PASS', fixture: 'SYNTHETIC', step: action, id: fact.id,
                revision: current.revision, amount: 25, carbs: 4.975, gi: 49, sqlite: true};
        } else if (action === 'export') {
            GPApp.open('system');
            assert(by('screen-system').classList.contains('active'), 'System route did not open');
            assert(globalThis.AndroidExporter, 'Native export bridge missing');
            click('exportState');
        } else if (action === 'journal') {
            by('nav').querySelector('[data-screen="journal"]').click();
            const diary = by('iframeApprovedJournal');
            for (let count = 0; count < 100; count++) {
                const rows = diary.contentDocument?.querySelector('#tbody')?.textContent || '';
                if (rows.includes('РинФаст') && rows.includes('Живот')) break;
                if (count === 99) throw Error('Persisted injection missing in diary');
                await new Promise(resolve => setTimeout(resolve, 75));
            }
        } else {
            throw Error('Unknown QA action');
        }
        return {status: 'PASS', fixture: 'SYNTHETIC', step: action};
    })().then(result => { window.__glucopapaQA = result; }, error => {
        window.__glucopapaQA = {status: 'FAIL', error: String(error)};
    });
})();
