(() => {
    const assert = (value, message) => { if (!value) throw Error(message); };
    const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 75));
    const until = async (predicate, message) => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const result = predicate();
            if (result) return result;
            await yieldFrame();
        }
        throw Error(message);
    };
    const by = id => document.getElementById(id);
    const click = id => by(id).click();
    const snapshot = () => GPApp.getStorage().exportState();
    const select = (node, value) => {
        node.value = value;
        node.dispatchEvent(new Event('input', {bubbles: true}));
        node.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const stage = async name => {
        window.__glucopapaQAStage = name;
        GPApp.open(name);
        await yieldFrame();
        assert(by('screen-' + name).classList.contains('active'), 'Route ' + name);
    };

    const originalConfirm = window.confirm;
    const expectedPrompts = [
        'Подтвердить, что еда действительно началась?',
        'Подтвердить завершение приёма пищи?',
    ];
    const prompts = [];
    window.__glucopapaQA = null;
    (async () => {
        await until(() => window.GPApp?.getStorage(), 'GFStorage unavailable');
        assert(GPApp.mode() === 'demo', 'Disposable synthetic journal required');
        // Test-APK-only acceptance of the two prompts in this named synthetic meal.
        // The actual-quantity checkbox and all GFStorage validation remain active.
        window.confirm = message => {
            assert(message === expectedPrompts[prompts.length], 'Unexpected confirmation prompt');
            prompts.push(message);
            return true;
        };
        const baseline = snapshot();
        assert(baseline.events.length === 1 && baseline.mealSessions.length === 0, 'Expected injection smoke snapshot');

        for (const name of ['home', 'approved-low', 'approved-high', 'cgm', 'approved-settings',
            'modules', 'analytics', 'approved-journal', 'approved-nutrition']) {
            await stage(name);
        }
        for (const name of ['approved-low', 'approved-high']) {
            assert(!by('screen-' + name).querySelector('#calcDose, #calcFood'),
                'Treatment calculator is exposed');
        }
        assert(snapshot().revision === baseline.revision, 'Navigation wrote to GFStorage');

        const plate = await until(() => by('iframeApprovedNutrition').contentDocument?.getElementById('catalogSearch'),
            'Plate catalog failed to load');
        const plateDocument = plate.ownerDocument;
        select(plate, 'гречка');
        const food = await until(() => plateDocument.querySelector('#productCards button.food-main'),
            'Synthetic food fixture absent');
        food.click();
        assert(plateDocument.getElementById('foodModal').classList.contains('on'), 'Food modal did not open');
        select(plateDocument.getElementById('portionAmount'), '100');
        plateDocument.getElementById('addToPlate').click();
        click('approvedSavePlate');
        const planned = await until(() => snapshot().mealSessions[0], 'Meal plan not persisted');
        assert(planned.status === 'draft' && planned.plannedPlate.items[0].amount === 100 && planned.actualPlate === null,
            'Plan became factual food');

        await stage('meals');
        click('mealReady');
        window.__glucopapaQAStage = 'start confirmation';
        click('mealStart');
        await until(() => snapshot().mealSessions[0].status === 'started', 'Confirmed meal did not start');
        const actualAmount = await until(() => document.querySelector('#gfMealActualRows [data-actual-index="0"]'),
            'Actual quantity field unavailable');
        select(actualAmount, '75');
        const before = snapshot().revision;
        click('gfMealActualSave');
        assert(snapshot().revision === before, 'Unconfirmed food modified GFStorage');
        click('gfMealActualConfirm');
        click('gfMealActualSave');
        const unfinished = GFAutoCOBProfile.inspect({host: GPApp.getStorage()});
        assert(unfinished.code === 'MEAL_NOT_COMPLETED' && unfinished.rows.length === 0,
            'The research COB window accepted an unfinished meal');
        window.__glucopapaQAStage = 'finish confirmation';
        click('mealFinish');
        await until(() => snapshot().mealSessions[0].status === 'completed', 'Meal did not finish');

        const checkMeal = async (amount, carbs) => {
            const state = snapshot();
            const record = state.mealSessions[0];
            const factual = record.actualPlate;
            assert(state.mealSessions.length === 1 && record.id === planned.id, 'Meal session duplicated');
            assert(factual.items[0].amount === amount && factual.items[0].glycemicIndex === 49, 'Wrong meal fact or GI');
            assert(Math.abs(factual.totals.carbs - carbs) < 1e-8, 'Incorrect carbohydrate fixture');
            for (const key of ['carbs', 'fat', 'protein', 'kcal']) {
                const expected = planned.plannedPlate.totals[key] * amount / 100;
                assert(Math.abs(factual.totals[key] - expected) < 1e-8, 'Incorrect nutrient ' + key);
            }
            const exported = JSON.parse(GFAuditExportStorageAdapter.exportJson(GPApp.getStorage()));
            assert(JSON.stringify(exported.mealSessions[0].actualPlate) === JSON.stringify(factual),
                'Export and storage disagree');
            const cob = GFAutoCOBProfile.inspect({host: GPApp.getStorage()});
            assert(cob.sourceRevision === state.revision && Math.abs(cob.rows[0].recordedCarbsG - carbs) < 1e-8,
                'COB read an inconsistent snapshot');
            await stage('approved-journal');
            const diary = by('iframeApprovedJournal').contentDocument;
            assert(diary.querySelectorAll('thead th').length === 3, 'Diary column count');
            await until(() => diary.querySelector('#tbody')?.innerText.includes(amount + ' г'), 'Diary quantity differs');
            return {amount, carbs, revision: state.revision};
        };
        const actual = await checkMeal(75, 14.925);
        await stage('meals');
        select(document.querySelector('#gfMealActualRows [data-actual-index="0"]'), '50');
        select(by('gfMealActualCorrectionReason'), 'SYNTHETIC correction');
        click('gfMealActualConfirm');
        click('gfMealActualSave');
        const corrected = await checkMeal(50, 9.95);
        assert(snapshot().workflowLog.filter(row => row.action === 'record_actual_plate').length === 2,
            'Meal correction did not retain the audit trail');
        assert(prompts.length === 2, 'Expected both meal lifecycle confirmation prompts');
        return {status: 'PASS', fixture: 'SYNTHETIC', actual, corrected, synthetic_confirmations: prompts.length};
    })().then(result => { window.__glucopapaQA = result; }, error => {
        window.__glucopapaQA = {status: 'FAIL', error: String(error), stack: String(error.stack)};
    }).finally(() => { window.confirm = originalConfirm; });
})();
