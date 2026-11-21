(() => {
  'use strict';
  const check=(condition,code)=>{if(!condition)throw Error(code);};
  const key='GFV2SHELL_DATA_v1_local';
  const measurementId='qa-first-boot-measurement';
  window.__glucopapaQAStage='read seed and SQLite';
  try{
    const scope=GFNativeStorage.seedScope();
    const research=scope==='research';
    const step=window.__glucopapaQAAction;
    const host=GPApp.getStorage();
    const seed=JSON.parse(GFNativeStorage.readPrivateSeed());
    check(seed.code==='FOUND'&&['main','research'].includes(scope),'PRIVATE_SEED_MISSING');
    const input=JSON.parse(seed.data);
    const readNative=()=>JSON.parse(GFNativeStorage.readSnapshot(key));
    let state=host.exportState();
    check(GPApp.mode()==='local'&&!window.GFTestJournal,'WRONG_ENTRYPOINT');
    check(state.profile.displayName===input.profile.displayName&&state.profile.birthDate===input.profile.birthDate,
        'PROFILE_CHANGED');
    check(readNative().data===JSON.stringify(state),'WEBVIEW_SQLITE_MISMATCH');
    check(Boolean(state.privateHistory)===research,'PRIVATE_JOURNAL_SCOPE');
    check(Boolean(window.AndroidExporter)===!research,'EXPORT_SCOPE');
    check(state.events.length===input.events.length&&state.mealSessions.length===input.mealSessions.length,
        'FACTS_MISMATCH');
    check(research||(!state.events.length&&!state.mealSessions.length&&!state.cgm.length),'MAIN_HAS_HISTORY');
    const archive=host.connect('archive').summary();
    if(research){
      check(archive.cgmCount===input.privateHistory.points.length&&
        archive.meterCount===input.privateHistory.meter.length,'ARCHIVE_COUNTS');
      check(host.connect('archive').replay()?.provenance==='synthetic_replay','REPLAY_MISSING');
      check(host.connect('research').read('events').length===0,'HYBRID_CONTAMINATION');
    }
    if(step==='first'){
      check(state.revision===seed.revision,'UNEXPECTED_FIRST_START_WRITE');
      const settings=host.connect('settings');
      const initial=input.measurements.at(-1),measuredAt=new Date().toISOString();
      window.__glucopapaQAStage='save measurement via GFStorage';
      settings.addMeasurement({id:measurementId,measuredAt,weightKg:initial.weightKg+1,
        heightCm:initial.heightCm},settings.getRevision());
      if(research){
        window.__glucopapaQAStage='test archive/provider boundary';
        const cgm=host.connect('cgmAdapter'), revision=cgm.getRevision();
        const ts=Math.floor(Date.now()/60000)*60000;
        check(ts>archive.lastAt+59999,'EMULATOR_CLOCK_PRECEDES_ARCHIVE');
        const item={ts,mgdl:153,receivedAt:new Date().toISOString(),direction:'Flat',staleAtReceipt:false};
        check(cgm.ingestXDripObservation({...item,ts:archive.lastAt+30000},revision).idempotent,
            'ARCHIVE_DUPLICATE_SAVED');
        check(cgm.ingestXDripObservation(item,revision).revision===revision+1,'PROVIDER_WRITE_FAILED');
        check(cgm.ingestXDripObservation(item,revision+1).idempotent,'PROVIDER_DUPLICATE_SAVED');
      }
      state=host.exportState();
      check(readNative().data===JSON.stringify(state),'WRITE_NOT_IN_SQLITE');
    }else{
      check(step==='reopened','UNKNOWN_PRIVATE_TEST_STEP');
      check(state.revision===seed.revision+(research?2:1),'REVISION_AFTER_RESTART');
      check(state.measurements.filter(x=>x.id===measurementId).length===1,'EDIT_LOST_OR_RESEEDED');
      check(state.measurements.at(-1).weightKg===input.measurements.at(-1).weightKg+1,'EDIT_REVERTED');
      if(research)check(state.cgm.length===1&&state.cgm[0].mgdl===153,'PROVIDER_LOST_OR_DUPLICATED');
    }
    window.__glucopapaQA={status:'PASS',scope,step,sqlite:'MATCH',archivePoints:archive?.cgmCount??0,
      observedRows:state.cgm.length,realFollower:'NOT_TESTED'};
  }catch(error){
    window.__glucopapaQA={status:'FAIL',step:window.__glucopapaQAStage,error:String(error.message)};
  }
})();
