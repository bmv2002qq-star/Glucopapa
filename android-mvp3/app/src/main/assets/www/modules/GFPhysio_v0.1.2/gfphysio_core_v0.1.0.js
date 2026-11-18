/*
 * ГлюкоПапа Физиология — experimental research-only mathematical model.
 * Independent JavaScript port of Simglucose T1DPatient (13 differential states).
 * Derived from Simglucose MIT-licensed code. Preserve upstream LICENSE.
 * NOT a clinical prediction or dose recommendation engine.
 */
(function(root, factory){
  const model=factory();
  if(typeof module === 'object' && module.exports) module.exports=model;
  else root.GlucoPapaPhysio=model;
})(typeof globalThis !== 'undefined'?globalThis:this,function(){
  'use strict';
  const STATE_COUNT=13;
  const MGDL_PER_MMOL=18.0182;
  const EAT_RATE_G_PER_MIN=5;

  function derivative(t,x,action,p,lastQsto,lastFoodTaken){
    const dx=new Array(13).fill(0);
    const d=action.CHO*1000;
    const insulin=action.insulin*6000/p.BW;
    const qsto=x[0]+x[1];
    const Dbar=lastQsto+lastFoodTaken*1000;
    dx[0]=-p.kmax*x[0]+d;
    let kgut;
    if(Dbar>0){
      const aa=5/(2*Dbar*(1-p.b));
      const cc=5/(2*Dbar*p.d);
      kgut=p.kmin+(p.kmax-p.kmin)/2*(Math.tanh(aa*(qsto-p.b*Dbar))-Math.tanh(cc*(qsto-p.d*Dbar))+2);
    } else kgut=p.kmax;
    dx[1]=p.kmax*x[0]-x[1]*kgut;
    dx[2]=kgut*x[1]-p.kabs*x[2];
    const Rat=p.f*p.kabs*x[2]/p.BW;
    const EGPt=p.kp1-p.kp2*x[3]-p.kp3*x[8];
    const Et=x[3]>p.ke2?p.ke1*(x[3]-p.ke2):0;
    dx[3]=Math.max(EGPt,0)+Rat-p.Fsnc-Et-p.k1*x[3]+p.k2*x[4];
    if(x[3]<0) dx[3]=0;
    const Vmt=p.Vm0+p.Vmx*x[6];
    const Uidt=Vmt*x[4]/(p.Km0+x[4]);
    dx[4]=-Uidt+p.k1*x[3]-p.k2*x[4];
    if(x[4]<0) dx[4]=0;
    dx[5]=-(p.m2+p.m4)*x[5]+p.m1*x[9]+p.ka1*x[10]+p.ka2*x[11];
    const It=x[5]/p.Vi;
    if(x[5]<0) dx[5]=0;
    dx[6]=-p.p2u*x[6]+p.p2u*(It-p.Ib);
    dx[7]=-p.ki*(x[7]-It);
    dx[8]=-p.ki*(x[8]-x[7]);
    dx[9]=-(p.m1+p.m30)*x[9]+p.m2*x[5];
    if(x[9]<0) dx[9]=0;
    dx[10]=insulin-(p.ka1+p.kd)*x[10];
    if(x[10]<0) dx[10]=0;
    dx[11]=p.kd*x[10]-p.ka2*x[11];
    if(x[11]<0) dx[11]=0;
    dx[12]=-p.ksc*x[12]+p.ksc*x[3];
    if(x[12]<0) dx[12]=0;
    return dx;
  }

  function rk4integrate(state, t, action, params, lastQsto, lastFoodTaken, substeps){
    let x=state.slice();
    const h=1/substeps;
    for(let s=0;s<substeps;s++){
      const tt=t+s*h;
      const k1=derivative(tt,x,action,params,lastQsto,lastFoodTaken);
      const a=x.map((v,i)=>v+h*k1[i]/2);
      const k2=derivative(tt+h/2,a,action,params,lastQsto,lastFoodTaken);
      const b=x.map((v,i)=>v+h*k2[i]/2);
      const k3=derivative(tt+h/2,b,action,params,lastQsto,lastFoodTaken);
      const c=x.map((v,i)=>v+h*k3[i]);
      const k4=derivative(tt+h,c,action,params,lastQsto,lastFoodTaken);
      x=x.map((v,i)=>v+h/6*(k1[i]+2*k2[i]+2*k3[i]+k4[i]));
      if(x.some(v=>!Number.isFinite(v))) throw new Error('Numerical integration generated non-finite state');
    }
    return x;
  }

  class T1DPatientResearch {
    constructor(params,{substeps=40,initState=null}={}){
      if(!params || !Number.isFinite(params.BW)||params.BW<=0) throw new TypeError('Valid patient parameter set required');
      if(!Number.isInteger(substeps)||substeps<1||substeps>2000) throw new RangeError('substeps must be integer 1..2000');
      this.params=params;
      this.substeps=substeps;
      // Source CSV uses keys 'x0_ 1'... 'x0_ 9', then 'x0_10' etc.
      this.originalInitState=initState?initState.slice():Array.from({length:STATE_COUNT},(_,i)=>params[`x0_${String(i+1).padStart(2,' ')}`]);
      if(this.originalInitState.length!==STATE_COUNT||this.originalInitState.some(v=>!Number.isFinite(v))) throw new TypeError('Invalid 13-state initialization');
      this.reset();
    }
    reset(){
      this.state=this.originalInitState.slice();
      this.time=0;
      this.lastQsto=this.state[0]+this.state[1];
      this.lastFoodTaken=0;
      this.lastAction={CHO:0,insulin:0};
      this.isEating=false;
      this.plannedMeal=0;
      return this;
    }
    get BG_mg_dL(){return this.state[12]/this.params.Vg;}
    get BG_mmol_L(){return this.BG_mg_dL/MGDL_PER_MMOL;}
    get basal_U_min(){return this.params.u2ss*this.params.BW/6000;}
    step({CHO=0,insulin=this.basal_U_min}={}){
      if(!Number.isFinite(CHO)||CHO<0 || !Number.isFinite(insulin)||insulin<0) throw new TypeError('Nonnegative finite CHO (g) and insulin (U/min) required');
      this.plannedMeal+=CHO;
      const toEat=this.plannedMeal>0?Math.min(EAT_RATE_G_PER_MIN,this.plannedMeal):0;
      this.plannedMeal=Math.max(0,this.plannedMeal-toEat);
      const action={CHO:toEat,insulin};
      if(action.CHO>0&&this.lastAction.CHO<=0){
        this.lastQsto=this.state[0]+this.state[1];
        this.lastFoodTaken=0;
        this.isEating=true;
      }
      if(this.isEating) this.lastFoodTaken+=action.CHO;
      if(action.CHO<=0&&this.lastAction.CHO>0) this.isEating=false;
      this.lastAction=action;
      this.state=rk4integrate(this.state,this.time,action,this.params,this.lastQsto,this.lastFoodTaken,this.substeps);
      this.time+=1;
      return {t:this.time,state:this.state.slice(),BG_mg_dL:this.BG_mg_dL,BG_mmol_L:this.BG_mmol_L};
    }
  }

  return Object.freeze({T1DPatientResearch,derivative,rk4integrate,MGDL_PER_MMOL,EAT_RATE_G_PER_MIN});
});
