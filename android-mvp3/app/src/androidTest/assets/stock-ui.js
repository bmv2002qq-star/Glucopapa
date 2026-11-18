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
            const previous = window.confirm;
            try {
                window.confirm = () => true;
                click('modeDemo');
            } finally { window.confirm = previous; }
            assert(GPApp.mode() === 'demo' && snapshot().revision === 0, 'Synthetic fixture failed to open');
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
