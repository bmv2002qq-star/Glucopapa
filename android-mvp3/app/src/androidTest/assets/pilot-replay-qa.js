(() => {
    'use strict';
    const check = (test, label) => { if (!test) throw Error(label); };
    const delay = () => new Promise(resolve => setTimeout(resolve, 0));
    const source = 'SYNTHETIC-ANDROID-90D';
    const key = 'GFV2SHELL_DATA_v1_demo';
    const localKey = 'GFV2SHELL_DATA_v1_local';
    const start = Date.parse('2025-06-01T00:00:00Z');
    const interval = 5 * 60 * 1000;
    const count = 90 * 288;
    window.__glucopapaQA = null;
    (async () => {
        await delay();
        const elapsed = performance.now();
        const native = window.GFNativeStorage;
        check(window.GFTestJournal && native, 'Expected native fixture package');
        const beforeLocal = native.readSnapshot(localKey);
        check(JSON.parse(beforeLocal).code === 'ABSENT', 'Expected untouched local journal on the disposable AVD');
        if (GPApp.mode() !== 'demo') {
            const confirm = window.confirm;
            try {
                window.confirm = message => message.startsWith('Открыть отдельный тестовый журнал?');
                document.getElementById('modeDemo').click();
            } finally { window.confirm = confirm; }
        }
        check(GPApp.mode() === 'demo', 'Synthetic journal is required');
        const host = GPApp.getStorage();
        const cgm = host.connect('cgmAdapter');
        if (window.__glucopapaQAAction === 'write') {
            check(host.diagnostics().revision === 0, 'Expected fresh fixture journal');
            cgm.setSourceMetadata({sourceType:'synthetic',sourceDeviceId:source,samplingMinutes:5,qualityScore:1},0);
            const batchSize = 15 * 288;
            for (let from = 0; from < count; from += batchSize) {
                window.__glucopapaQAStage = 'day ' + (from / 288);
                const rows = Array.from({length:batchSize}, (_, i) => {
                    const index = from + i;
                    const ts = start + index * interval;
                    return {ts, mmol:5 + (index % 37) / 10, sourceDeviceId:source,
                        receivedAt:new Date(ts + 60_000).toISOString()};
                });
                cgm.ingestReadings(rows, cgm.getRevision());
                check(cgm.ingestReadings(rows.slice(-1), cgm.getRevision()).idempotent,'Duplicate changed revision');
                await delay();
            }
        }
        window.__glucopapaQAStage = 'compare SQLite';
        const state = host.exportState();
        check(state.revision === 7 && state.cgm.length === count && state.cgm.every((row, i) =>
            row.ts === start + i * interval && row.mmol === 5 + (i % 37) / 10 &&
            row.source === 'synthetic' && row.sourceDeviceId === source), 'Missing, changed or duplicate CGM');
        const persisted = JSON.parse(native.readSnapshot(key));
        check(persisted.code === 'FOUND' && persisted.data === JSON.stringify(state), 'GFStorage and SQLite differ');
        const freshness = GFCgmEvidencePolicy.inspect(host,{nowMs:start + count * interval + 30 * 60_000});
        check(freshness.status === 'STALE' && freshness.currentMmol === null, 'Old data shown as current');
        GPApp.open('approved-journal');
        await delay();
        check(document.getElementById('screen-approved-journal').classList.contains('active'), 'Journal did not open');
        check(native.readSnapshot(localKey) === beforeLocal && host.diagnostics().revision === state.revision,
            'Long replay modified local data or navigation wrote a new revision');
        return {status:'PASS', fixture:'SYNTHETIC_ONLY', step:window.__glucopapaQAAction, virtualDays:90,
            samples:count, jsonChars:persisted.data.length, revision:persisted.revision,
            elapsedMs:Math.round(performance.now() - elapsed)};
    })().then(result => { window.__glucopapaQA = result; }, error => {
        window.__glucopapaQA = {status:'FAIL', error:String(error), stage:window.__glucopapaQAStage};
    });
})();
