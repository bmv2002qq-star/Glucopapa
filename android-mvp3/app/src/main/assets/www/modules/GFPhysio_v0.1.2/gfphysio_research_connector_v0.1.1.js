/* GFPhysio research-only connector: GFStorage/GFSettings -> nearest COMPLETE synthetic profile -> GFPhysio 13-state core.
   No writing GFStorage; no real-person clinical adaptation; no automated dose calculations.
*/
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GFPhysioResearchConnector=api})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
function connect({source,database,profilesEngine,storageBridge,physioEngine,clock=()=>new Date().toISOString()}){
 if(!source||!database||!profilesEngine||!storageBridge||!physioEngine?.T1DPatientResearch)throw Error('Требуются GFSettings/GFStorage и оригинальное ядро GFPhysio');
 let current=null;let listeners=new Set();let unsubscribe=null;
 function refresh(){const at=clock(),demographics=storageBridge.fromSource(source,at),matched=profilesEngine.nearest(database,demographics),payload=profilesEngine.getSelectedParameters(database,matched);
 // Re-initialize the ENTIRE original synthetic profile — never use actual age/weight for integration without calibration.
 const virtualModel=new physioEngine.T1DPatientResearch(payload.params);
 current={demographics,matched,payload,virtualModel,modelVersion:'GFPhysio v0.1.0',connectorVersion:'0.1.1',researchOnly:true};
 for(const cb of listeners)cb(current);return current;
 }
 function subscribe(cb){if(typeof cb!=='function')throw Error('Ожидалась функция');listeners.add(cb);return ()=>listeners.delete(cb)}
 if(typeof source.subscribe==='function')unsubscribe=source.subscribe(()=>{try{refresh()}catch(e){for(const cb of listeners)cb({error:e.message,researchOnly:true})}});
 return Object.freeze({refresh,getCurrent:()=>current,subscribe,dispose:()=>{if(unsubscribe)unsubscribe();listeners.clear();current=null},status:'RESEARCH_ONLY_NOT_FOR_DOSING'});
}
return Object.freeze({version:'0.1.1',connect});
});
