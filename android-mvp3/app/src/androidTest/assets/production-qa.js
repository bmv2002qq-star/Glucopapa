(() => {
    'use strict';
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const byId = id => document.getElementById(id);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    window.__glucopapaQA = null;
    (async () => {
        assert(location.pathname.endsWith('/index.html') && !window.GFTestJournal, 'Fixture entrypoint installed');
        assert(GPApp.mode() === 'local', 'Fresh install is not a local journal');
        GPApp.open('system');
        for (const id of ['modeDemo', 'seedDemo', 'resetDemo', 'syntheticCgmTools']) {
            assert(!byId(id), 'Visible fixture entrypoint: ' + id);
        }
        assert(!GFShellPreferences.write('GFV2SHELL_MODE_v1', 'demo'), 'Native mode switch is active');
        const read = key => JSON.parse(GFNativeStorage.readSnapshot(key));
        const localKey = 'GFV2SHELL_DATA_v1_local';
        assert(read('GFV2SHELL_DATA_v1_demo').ok === false, 'Test journal is accessible');
        assert(read(localKey).code === 'ABSENT', 'Fresh local SQLite contains a snapshot');
        const host = GPApp.getStorage();
        const before = host.exportState();
        const cgm = host.connect('cgmAdapter');
        let rejected = false;
        try {
            cgm.setSourceMetadata({sourceDeviceId:'qa-isolation',sourceType:'synthetic',samplingMinutes:5,qualityScore:1},0);
        } catch (error) {
            rejected = error.message === 'GF_LOCAL_SYNTHETIC_DATA';
        }
        assert(rejected && host.diagnostics().revision === 0, 'GFStorage accepted synthetic data into local');
        const synthetic = JSON.stringify({...before,cgmMetadata:{sourceType:'synthetic'}});
        assert(JSON.parse(GFNativeStorage.importIfAbsent(localKey, synthetic)).ok === false,
            'Native import accepted synthetic CGM');
        assert(JSON.parse(GFNativeStorage.writeIfRevision(localKey, JSON.stringify({...JSON.parse(synthetic),revision:1}), 0)).ok === false,
            'Native save accepted synthetic CGM');
        GFNativeXDrip.pollLatest();
        const cutoff = Date.now() + 6000;
        let source;
        do {
            source = JSON.parse(GFNativeXDrip.peekLatest()).status;
            if (source !== 'READING') break;
            await sleep(125);
        } while (Date.now() < cutoff);
        assert(source === 'NO_PROVIDER', 'Unexpected local provider: ' + source);
        GPApp.open('home');
        const state = host.exportState();
        assert(state.revision === 0 && !state.cgm.length && !state.events.length && read(localKey).code === 'ABSENT',
            'Fresh local journal acquired data');
        assert(byId('homeGlucose').textContent === '—', 'Unknown CGM was displayed as a measurement');
        return {status:'PASS', variant:'debug', sqlite:'ABSENT', provider:source};
    })().then(result => { window.__glucopapaQA = result; }, error => {
        window.__glucopapaQA = {status:'FAIL', error:String(error.message || error)};
    });
})();
