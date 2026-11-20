'use strict';

/* Input contract for private parity runs with the unmodified GFxDrip engine.
 * The engine and this runner are outside the Android application. */
const {join}=require('node:path');
const web=join(__dirname,'../../android-mvp3/app/src/main/assets/www');
const Cgm=require(join(web,'integration/GFCgmEvidencePolicy_v0.1.0.js'));
const Food=require(join(web,'integration/GFMealCoverageStudy_v0.1.1.js'));
const Settings=require(join(web,'modules/GFSettings_v0.1.8/src/gfsettings.js'));
const MINUTE=60_000;
const ENGINE_SHA256='47aa8b35d95316d00c85d070a43721598a1ccc2c5fabb877b444ed457616760b';

const blocked=code=>({status:'BLOCKED',code,clinicalUse:false});
const at=Date.parse;
const known=x=>Number.isFinite(x)&&x>0;

function project({host, nowMs, foodHistory, absorption}) {
    if(host?.getSchemaVersion?.()!==5||!Number.isSafeInteger(nowMs))return blocked('STORAGE_OR_CLOCK');
    const port=host.connect('research'), snapshot=port.getSnapshot();
    const source=Cgm.inspect(host,{nowMs});
    const {revision,profile}=snapshot;
    if(source.revision!==revision)return blocked('REVISION_CHANGED');
    if(source.sourceStatus==='SYNTHETIC')return blocked('SYNTHETIC_CGM_EXCLUDED');
    if(source.status!=='OK'||source.sourceStatus!=='DEVICE_DECLARED')return blocked(source.code);
    if(source.ageMinutes>10)return blocked('CGM_STALE_10MIN');
    const points=source.rawReadings.filter(row=>row.ts>=nowMs-45*MINUTE);
    if(points.length<3||points.some((row,i)=>
        row.source!=='device_recorded'||row.kind!=='observed'||row.valid!==true||row.qualityFlag!=='ok'||
        !Number.isFinite(row.mmol)||row.mmol<1.5||row.mmol>30||
        !(at(row.receivedAt)>=row.ts&&at(row.receivedAt)<=nowMs)||
        (i>0&&(row.ts<=points[i-1].ts||row.ts-points[i-1].ts>15*MINUTE))))
        return blocked('CGM_RECEIPT_QUALITY_OR_GAP');
    const coverage=snapshot.coverage;
    if(coverage?.confirmedComplete!==true||coverage.declaredBy!=='parent'||
        !(at(coverage.startIso)<=nowMs-48*60*MINUTE&&at(coverage.endIso)>=nowMs))
        return blocked('RAPID_HISTORY_INCOMPLETE');
    const dia=snapshot.models?.rinfast?.profile?.diaMinutes;
    if(!known(dia))return blocked('RAPID_PROFILE_UNAVAILABLE');
    const now=new Date(nowMs).toISOString();
    if(!profile.timeZone)return blocked('TIMEZONE_UNAVAILABLE');
    const effective=Settings.coefficientTimeline(snapshot.coefficients,now,profile.timeZone);
    function coefficient(kind) {
        const matches=effective.filter(row=>row.kind===kind&&row.isEffectiveAt);
        return profile.coefficientModes?.[kind]==='manual'&&matches.length===1&&
            ['manual','doctor'].includes(matches[0].source)?matches[0].value:null;
    }
    const isf=coefficient('isf_mmol_per_u'), carbRatio=coefficient('carb_g_per_u');
    if(!known(isf)||!known(carbRatio))return blocked('COEFFICIENT_UNAVAILABLE');
    const active=snapshot.conditionPeriods.some(period=>['activity','sport','illness'].includes(period.kind)&&
        at(period.start)<=nowMs&&(period.end===null||nowMs<at(period.end)));
    if(active||profile.activityBaseLevel==='high')return blocked('UNMODELED_CONTEXT');
    const food=Food.inspect({host,nowMs,acknowledgement:foodHistory});
    if(!food.historyDeclaration)return blocked(food.code);
    const legacy=snapshot.events.some(row=>row.type==='meal'&&row.status==='recorded'&&
        (!Number.isFinite(at(row.startedAt))||at(row.startedAt)>=nowMs-Food.WINDOW_MS));
    if(legacy)return blocked('LEGACY_FOOD_COVERAGE_UNKNOWN');
    if(absorption?.scope!=='SYNTHETIC_PARITY'||absorption.revision!==revision||
        !known(absorption.rateGPerHour)||!Number.isFinite(absorption.delayMinutes)||absorption.delayMinutes<0||
        absorption.delayMinutes>180||typeof absorption.momentum!=='boolean')
        return blocked('FIXED_ABSORPTION_RULE_UNATTESTED');
    const maxWindow=(absorption.delayMinutes+250/absorption.rateGPerHour*60)*MINUTE;
    if(maxWindow>Food.WINDOW_MS)return blocked('ABSORPTION_WINDOW_NOT_COVERED');
    const confirmed=snapshot.events.filter(row=>row.type==='insulin_injection'&&row.status==='confirmed'&&row.insulinId==='rinfast');
    if(confirmed.some(row=>!Number.isFinite(at(row.administeredAt))||at(row.administeredAt)>nowMs))
        return blocked('RAPID_TIME_INVALID');
    const shots=confirmed.filter(row=>at(row.administeredAt)>=nowMs-dia*MINUTE);
    if(port.getRevision()!==revision)return blocked('REVISION_CHANGED');
    const relative=time=>(time-nowMs)/MINUTE;
    return {status:'READY_FOR_PRIVATE_PARITY',clinicalUse:false,sourceRevision:revision,sourceId:source.sourceDeviceId,
        timeZone:profile.timeZone,sourceTime:source.latestAt,injectionIds:shots.map(row=>row.id),mealIds:food.mealIds,
        config:{horizon:120,mode:'legacySum',momentum:absorption.momentum,isf,carbRatio,diaHours:dia/60,
            absorbRate:absorption.rateGPerHour,delayMin:absorption.delayMinutes,
            cgm:points.map(row=>({t:relative(row.ts),v:row.mmol})),
            insulins:shots.map(row=>({t:relative(at(row.administeredAt)),units:row.units})),
            meals:food.mealRows.map(row=>({t:relative(at(row.startedAt)),grams:row.carbsRecordedG}))}};
}

module.exports={project,ENGINE_SHA256};
