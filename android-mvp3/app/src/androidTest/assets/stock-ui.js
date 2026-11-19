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
            by('screen-approved-high').querySelector('button[data-screen="injections"]').click();
            assert(by('screen-injections').classList.contains('active'), 'Injection route did not open');
            by('injectionUnits').value = '0.5';
            by('injectionRegion').value = 'abdomen';
            assert(!by('injectionConfirm').checked, 'New injection was already confirmed');
            if (action === 'confirmed') click('injectionConfirm');
            by('injectionForm').querySelector('button[type="submit"]').click();
            const state = snapshot();
            if (action === 'confirmed') {
                assert(state.revision === revision + 1 && state.events.length === 1, 'Fact was not saved exactly once');
            } else {
                assert(state.revision === revision && !state.events.length, 'Unconfirmed action modified GFStorage');
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
