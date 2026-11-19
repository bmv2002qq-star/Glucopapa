/* CL-HIGH candidate: project one GFStorage revision; calculations and confirmed writes are separate. */
(function (root) {
  'use strict';
  const VERSION='0.1.1-candidate', MIN=60_000, HOUR=60*MIN;
  const SITE=Object.freeze({Живот:'abdomen',Плечо:'arm',Бедро:'thigh',Ягодица:'buttock'});
  const DEFAULT_ACTIVITY=Object.freeze({version:1,enabled:true,selectedLevel:'normal',source:'project_default',editedAt:null});
  const finite=Number.isFinite;
  const at=Date.parse;
  const fail=(code,message,view=null)=>({status:'BLOCKED',code,reasons:[message],candidate:null,
    clinicalUse:false,baseline:[],sourceRevision:view?.revision??null,view});
  const boundedHalf=(amount,max=200)=>finite(amount)&&amount>0&&amount<=max&&Number.isInteger(amount*2);

  function preferences(profile) {
    const activity=profile.highActivity??{...DEFAULT_ACTIVITY,
      selectedLevel:profile.activityBaseLevel==='high'?'high':'normal',
      coefficients:root.GFStorage.HIGH_ACTIVITY_DEFAULTS};
    return {target:profile.highTarget??null,activity};
  }

  function selectCoefficient(timeline,profile,kind) {
    const entries=timeline.filter(row=>row.kind===kind&&row.isEffectiveAt);
    if(profile.coefficientModes?.[kind]!=='manual'||entries.length!==1)return null;
    const row=entries[0];
    return ['manual','doctor'].includes(row.source)&&root.GFTimeGrid.slotOf(row.windowLocal)&&
      finite(row.value)&&row.value>0?{id:row.id,value:row.value,source:row.source,window:row.windowLocal}:null;
  }

  // Original v0.1.3 synthetic activity curve, applied only to the isolated synthetic journal.
  function scenarioModifier(coefficient,isf) {
    return {version:'HIGH_ACTIVITY_SCENARIO_V1',includesCurrentTrend:false,points:[{t:0,delta:0},
      {t:120,delta:-(coefficient-1)*isf*0.4},{t:300,delta:-(coefficient-1)*isf},{t:900,delta:-(coefficient-1)*isf}]};
  }

  function inspect({host,mode='local',nowMs=Date.now(),foodOptions={},previewDose=null}={}) {
    if(!Number.isSafeInteger(nowMs))return fail('CLOCK_INVALID','Время расчёта неизвестно.');
    if(host?.getSchemaVersion?.()!==5)return fail('GFSTORAGE_SCHEMA','Требуется GFStorage schema 5.');
    const nowIso=new Date(nowMs).toISOString();
    const research=host.connect('research'), settings=host.connect('settings');
    const snapshot=research.getSnapshot(), set=settings.getSnapshot(), revision=snapshot.revision;
    const cgm=root.GFCgmEvidencePolicy.inspect(host,{nowMs});
    if(set.revision!==revision||cgm.revision!==revision||research.getRevision()!==revision)
      return fail('REVISION_CHANGED','Данные изменились при чтении.');
    const prefs=preferences(set.profile);
    const active=kind=>snapshot.conditionPeriods.some(p=>p.kind===kind&&at(p.start)<=nowMs&&
      (p.end===null||nowMs<at(p.end)));
    const level=active('sport')?'sport':prefs.activity.selectedLevel;
    const activity={...prefs.activity,effectiveLevel:level,effectiveCoefficient:prefs.activity.enabled?
      prefs.activity.coefficients[level]:1,sportActive:active('sport')};
    const timeline=root.GFSettings.coefficientTimeline(set.coefficients,nowIso,set.profile.timeZone);
    const isf=selectCoefficient(timeline,set.profile,'isf_mmol_per_u');
    const uk=selectCoefficient(timeline,set.profile,'carb_g_per_u');
    const trend=root.GFCgmEvidencePolicy.forEvent(cgm,at(cgm.latestAt),{journal:root.GFJournal});
    const stale=cgm.ageMinutes>10;
    const flow={revision,nowIso,target:prefs.target,activity,sourceId:cgm.sourceDeviceId,
      cgm:{status:stale?'STALE':cgm.status,code:stale?'CGM_STALE':cgm.code,source:cgm.sourceStatus,
        mmol:stale?null:cgm.currentMmol??cgm.reportedMmol??null,
        measuredAt:cgm.latestAt,ageMinutes:cgm.ageMinutes??null,trend:stale?null:trend.direction??null},
      coefficients:{isf,uk,zone:set.profile.timeZone},illness:{active:active('illness')},
      foodModel:root.GFMealAbsorption.selected(set.profile)};
    const synthetic=mode==='demo'&&cgm.sourceType==='synthetic';
    if(flow.cgm.status!=='OK')return fail(flow.cgm.code,'Для прогноза требуется свежий CGM с известным качеством.',flow);
    const readings=cgm.readings.filter(x=>x.ts>=nowMs-35*MIN);
    if(readings.some(x=>!Number.isFinite(at(x.receivedAt))))
      return fail('CGM_RECEIPT_UNKNOWN','У части показаний отсутствует время получения.',flow);
    if(!synthetic&&(mode!=='local'||cgm.sourceType!=='device_recorded'))
      return fail('CGM_SOURCE_NOT_ELIGIBLE','Локальный и синтетический журналы используют разные источники.',flow);
    if(!prefs.target||at(prefs.target.editedAt)>nowMs||!isf||!uk)
      return fail('SETTINGS_INCOMPLETE','Укажите цель HIGH и действующие ручные УК и ФЧИ для этого времени.',flow);

    const coverage=snapshot.coverage;
    if(coverage?.declaredBy!=='parent'||coverage.confirmedComplete!==true||
       !(at(coverage.startIso)<=nowMs-48*HOUR&&at(coverage.endIso)>=nowMs))
      return fail('INJECTION_COVERAGE_UNKNOWN','Подтвердите полноту истории инъекций за 48 часов.',flow);
    const food=root.GFMealAbsorption.inspect({host,snapshot,nowMs,options:foodOptions});
    if(research.getRevision()!==revision||food.sourceRevision!==revision)
      return fail('REVISION_CHANGED','Данные изменились при чтении.');
    flow.food={status:food.status,code:food.code,lowerG:food.lowerG,upperG:food.upperG};
    if(!food.forecastReady)
      return fail(food.forecastCode??food.code,'Выбранная модель еды пока не дала точечного вклада для прогноза.',flow);

    const engine=root.RinfastEngine, profile=snapshot.models?.rinfast?.profile;
    if(!profile||profile.modelVersion!==engine?.ENGINE_VERSION)
      return fail('RINFAST_PROFILE_UNKNOWN','Источник профиля РинФаста не подтверждён.',flow);
    const rinfastEngine={ENGINE_VERSION:engine.ENGINE_VERSION,DEFAULT_PROFILE:engine.validateProfile(profile),
      getCurve:age=>engine.getCurve(age,profile)};
    const injections=snapshot.events.filter(e=>e.type==='insulin_injection'&&e.insulinId==='rinfast'&&
      e.status==='confirmed'&&at(e.administeredAt)>=nowMs-48*HOUR);
    const neutral=level==='normal'&&activity.effectiveCoefficient===1;
    const activityApplies=activity.enabled&&(!neutral||synthetic);
    const illnessView=root.GFSettings.createSettingsService({settingsPort:settings}).getView(nowIso).illness;
    flow.illness=illnessView;

    const result=root.GFHighTarget.analyse({nowIso,revision,rinfastEngine,
      readings,injections,meals:[],
      origin:synthetic?'synthetic_fixture':'live',fixtureTag:synthetic?'SYNTHETIC_TEST_ONLY':undefined,
      coverage:{injectionsConfirmed:true,mealsConfirmed:true},
      settings:{target:prefs.target.valueMmol,isf:isf.value,uk:uk.value,foodModel:food.model.id,
        previewDose,step:.5,maxDose:6},
      context:{activity:activityApplies?level:'low',illness:illnessView.active,physioApplied:false},
      modifiers:synthetic&&activityApplies?{activity:scenarioModifier(activity.effectiveCoefficient,isf.value)}:undefined});
    return research.getRevision()===revision?{...result,candidate:result.candidate??null,view:flow,synthetic}:
      fail('REVISION_CHANGED','Данные изменились во время вычисления.');
  }

  function recordActualInjection({host,record,confirmation,expectedRevision}) {
    if(confirmation!==true)return fail('NO_FACT_CONFIRMATION','Подтвердите уже выполненную инъекцию.');
    if(host?.getSchemaVersion?.()!==5)return fail('GFSTORAGE_SCHEMA','Требуется GFStorage schema 5.');
    if(!record||!boundedHalf(record.units)||!Object.values(SITE).includes(record.injectionSite?.region))
      return fail('FACT_INVALID','Требуются фактическое количество с шагом 0,5 ЕД и место укола.');
    const writer=host.connect('actionWriter');
    try {
      const receipt=writer.recordInjection({id:record.id,insulinId:'rinfast',units:record.units,
        administeredAt:record.administeredAt,injectionSite:record.injectionSite},expectedRevision);
      return {status:'RECORDED',id:record.id,revision:receipt.revision,idempotent:receipt.idempotent===true};
    } catch (error) {
      return fail(writer.getRevision()!==expectedRevision?'REVISION_CHANGED':'STORAGE_WRITE_REJECTED',
        String(error.message||error));
    }
  }

  const api=Object.freeze({VERSION,SITE,boundedHalf,preferences,inspect,recordActualInjection});
  root.GFHighTargetBridge=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
