/* GFAPS Research v0.1.0. Independent JS research implementation; no pump control or dosing advice. */
(function(root,factory){ const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSUtils=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MIN=60000,MMOL_TO_MGDL=18.0182;
const finite=(x)=>typeof x==='number'&&Number.isFinite(x);
const round=(x,n=3)=>Number.isFinite(x)?Number(x.toFixed(n)):null;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const ts=(x)=>typeof x==='number'&&Number.isSafeInteger(x)?x:typeof x==='string'?Date.parse(x):NaN;
const assert=(b,message)=>{if(!b)throw new Error(message);};
const requireFinite=(v,label,lower=-Infinity,upper=Infinity)=>{assert(finite(v)&&v>=lower&&v<=upper,`Недопустимо ${label}`);return v;};
const median=(a)=>{if(!a.length)return null;const b=a.slice().sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const mean=(a)=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const utcDay=(t)=>new Date(t).toISOString().slice(0,10);
return {MIN,MMOL_TO_MGDL,finite,round,clamp,ts,assert,requireFinite,median,mean,utcDay};
});
