// Synthetic data only. All scenario rows use the normal GFStorage ports.
(function (root) {
  'use strict';

  const minute = 60_000, day = 24 * 60 * minute;
  const iso = value => new Date(value).toISOString();

  function prepare(host, at) {
    const write = (role, method, data) => {
      const port = host.connect(role);
      return port[method](data, port.getRevision());
    };
    const settings = host.connect('settings');
    root.GFSettings.createSettingsService({settingsPort:settings}).saveProfile({timeZone:'UTC'},settings.getRevision());
    write('activityUi','setBaseLevel','usual');
    const mealId = 'qa-current-meal', units = 2, site = 'abdomen', sensor = 'qa-meal-sensor';
    const plate = {schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:iso(at),containsEstimatedValues:false,
      items:[{kind:'manual',name:'SYNTHETIC PLATE',foodId:'qa-grains',unit:'г',amount:100,carbs:20,fat:8,protein:12,
        kcal:250,nutritionStatus:'label_verified',glycemicIndex:55,glycemicIndexStatus:'verified'}],
      totals:{amount:100,count:1,carbs:20,fat:8,protein:12,kcal:250}};

    const controller = root.GFMealController.createController(host);
    const cgm = [];
    const glucose = (ts, mmol) => cgm.push({ts,mmol,sourceDeviceId:sensor,receivedAt:iso(ts)});
    const previous = [4,5,6,7,8,9];
    const today = Math.floor(at/day)*day;
    const nearSlotStart = (Math.floor(new Date(at).getUTCHours()/6)*6+1)*60*minute;
    for (const [i, days] of previous.entries()) {
      const shotTime = today - days*day + nearSlotStart, lag = 10 + i;
      const sessionId = 'qa-meal-'+i, injectionId = 'qa-injection-'+i;
      const startedAt = iso(shotTime+lag*minute);

      controller.createFromFood(plate,sessionId);
      controller.ready(sessionId);
      write('actionWriter','recordSessionInjection',{
        sessionId,expectedVersion:controller.lookup(sessionId).version,opId:'qa-confirm-'+i,injectionId,
        insulinId:'rinfast',units,administeredAt:iso(shotTime),injectionSite:{region:site},
        injectionContext:{illness:'no',activity:'usual',carbsG:20,iobU:0.1,mealLagMinutes:lag,mealGroup:'with_meal',
          settingRevision:5,localHour:new Date(shotTime).getUTCHours(),utcOffsetMinutes:0},
      });
      controller.startMeal(sessionId,startedAt,{actuallyStarted:true});
      controller.actualFood(sessionId,plate,{parentConfirmed:true});
      controller.finishMeal(sessionId,iso(shotTime+(lag+35)*minute),{confirmed:true});
      for (let dt=-25;dt<=lag+185;dt+=5) {
        const after = dt-lag;
        const value = after<=0 ? 7 : 7+Math.sin(Math.PI*Math.min(after,180)/180)-0.004*after;
        glucose(shotTime+dt*minute,+value.toFixed(3));
      }
    }
    for (let dt=-25;dt<=0;dt+=5) glucose(at+dt*minute,7);
    write('cgmAdapter','setSourceMetadata',{sourceDeviceId:sensor,sourceType:'device_recorded',samplingMinutes:5,qualityScore:0.95});
    write('cgmAdapter','ingestReadings',cgm);
    write('actionWriter','setCoverage',{startIso:iso(at-4*day),endIso:iso(at+2*minute),declaredBy:'parent',confirmedComplete:true});
    controller.createFromFood(plate,mealId,'breakfast');
    controller.ready(mealId);
    return {mealId,units,site,atIso:iso(at),plate};
  }

  const api = Object.freeze({prepare});
  root.GFMealTimingQACase = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
