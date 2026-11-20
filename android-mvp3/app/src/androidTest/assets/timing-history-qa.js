/* Synthetic history in a fresh Chromium profile or the disposable Android QA emulator. */
(() => {
    'use strict';
    const check = (value, detail) => { if (!value) throw Error(detail); };
    const by = id => document.getElementById(id);
    const minute = 60_000, hour = 60 * minute, day = 24 * hour;
    const RealDate = Date;
    const native = globalThis.GFNativeStorage;
    const key = 'GFV2SHELL_DATA_v1_local';
    const end = Math.floor(RealDate.now() / day) * day - 12 * hour;
    const targetId = 'SYNTHETIC-CL047-0';
    let epoch = end - 10 * day - 4 * hour;
    const iso = timestamp => new RealDate(timestamp).toISOString();

    function seed(host) {
        const settings = host.connect('settings');
        const sensor = host.connect('cgmAdapter');
        const writer = host.connect('actionWriter');
        const meals = GFMealController.createController(host);
        const source = 'SYNTHETIC-CL047-REPLAY';
        settings.updateProfile({timeZone: 'UTC'}, settings.getRevision());
        sensor.setSourceMetadata({sourceDeviceId: source, sourceType: 'device_recorded',
            samplingMinutes: 5, qualityScore: 1}, sensor.getRevision());

        const observed = [];
        for (const days of [10, 8, 6, 4, 0]) {
            const start = end - days * day - 4 * hour;
            const id = 'SYNTHETIC-CL047-' + days;
            epoch = start;
            const portion = {kind: 'manual', foodId: null, name: 'Синтетическая порция', amount: 75,
                unit: 'г', carbs: 15, fat: 0, protein: 0, kcal: 60, glycemicIndex: 49,
                glycemicIndexStatus: 'verified', nutritionStatus: 'label_verified'};
            const plate = {schema: 'GFPlate.v1', source: 'GFFoodOnly', createdAt: iso(start),
                containsEstimatedValues: false, items: [portion],
                totals: {amount: 75, count: 1, carbs: 15, fat: 0, protein: 0, kcal: 60}};
            meals.createFromFood(plate, id);
            meals.ready(id);
            writer.recordSessionInjection({sessionId: id, expectedVersion: meals.lookup(id).version,
                opId: 'op-' + id, injectionId: 'shot-' + id, insulinId: 'rinfast', units: 0.5,
                administeredAt: iso(start), injectionSite: {region: 'abdomen'},
                injectionContext: {activity: 'usual', illness: 'no', carbsG: 15, iobU: 0.1,
                    mealGroup: 'with_meal', mealLagMinutes: 15, settingRevision: 6,
                    localHour: 8, utcOffsetMinutes: 0}}, writer.getRevision());
            epoch = start + 20 * minute;
            meals.startMeal(id, iso(start + 15 * minute), {actuallyStarted: true});
            meals.actualFood(id, plate, {parentConfirmed: true});
            meals.finishMeal(id, iso(epoch), {confirmed: true});
            for (let offset = -30; offset <= 195; offset += 5) {
                const ts = start + offset * minute;
                observed.push({ts, mmol: 7, sourceDeviceId: source, receivedAt: iso(ts),
                    valid: true, qualityFlag: 'ok'});
            }
        }
        epoch = end;
        sensor.ingestReadings(observed, sensor.getRevision());
    }

    window.__glucopapaQA = null;
    (async () => {
        const deadline = RealDate.now() + 8_000;
        while (!window.GFInjectionTimingPanel && RealDate.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        check(window.GFInjectionTimingPanel, 'Timing panel did not initialize');
        if (native) {
            const local = JSON.parse(native.readSnapshot(key));
            const empty = local.code === 'ABSENT' || (local.code === 'FOUND' && local.revision === 0);
            check(GPApp.mode() === 'demo' && empty,
                'Expected the dedicated emulator with an empty local journal');
            by('modeLocal').click();
        }
        const host = GPApp.getStorage();
        const initial = host.exportState();
        check(GPApp.mode() === 'local' && initial.revision === 0 && !initial.events.length &&
            !initial.mealSessions.length && !initial.cgm.length, 'Fresh test profile required');
        window.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [epoch])); }
            static now() { return epoch; }
        };
        seed(host);
        const state = host.exportState();
        const before = JSON.stringify(state);
        const disk = native?.readSnapshot(key);
        if (native) {
            const persisted = JSON.parse(disk);
            check(persisted.code === 'FOUND' && persisted.revision === state.revision &&
                JSON.stringify(JSON.parse(persisted.data)) === before, 'Synthetic history is missing in SQLite');
        }
        GPApp.open('injection-sites');
        by('timingHistoryPanel').open = true;
        GFInjectionTimingPanel.refresh();
        const control = by('timingHistorySession');
        check(control.options.length === 6, 'Unexpected meal list');
        control.value = targetId;
        control.dispatchEvent(new Event('change', {bubbles: true}));
        by('timingHistoryRun').click();
        const result = JSON.parse(by('timingHistoryResult').textContent);
        check(result.status === 'HISTORICAL_ESTIMATE' && result.descriptiveLagMinutes === 15 &&
            result.matchedCases === 4, 'Unexpected retrospective result');
        check(result.clinicalUse === false && result.automaticInjectionTiming === false &&
            result.sourceRevision === state.revision, 'Retrospective result has the wrong scope or revision');
        check(JSON.stringify(host.exportState()) === before && (!native || native.readSnapshot(key) === disk),
            'Analysis changed the journal');
        return {status: 'PASS', fixture: 'SYNTHETIC_ISOLATED', result: result.status,
            matchedCases: result.matchedCases, snapshot_unchanged: true, sqlite: Boolean(native)};
    })().then(result => { window.__glucopapaQA = result; }, error => {
        window.__glucopapaQA = {status: 'FAIL', error: String(error), stack: String(error.stack)};
    }).finally(() => { window.Date = RealDate; });
})();
