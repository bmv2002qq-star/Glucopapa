/* Optional presentation layer over the unmodified CGM Chart A. */
(function (root) {
  'use strict';
  const IDS = Object.freeze(['GFForecast','GFxDrip','GFAPSEnhancer']);
  const COLORS = Object.freeze({GFForecast:'#2541a0',GFxDrip:'#26705e',GFAPSEnhancer:'#96428a',GFConsensus:'#243548'});
  const SVG = 'http://www.w3.org/2000/svg';
  const MAX_AGE = 12*60_000;
  const safePoint = p => Number.isFinite(Date.parse(p?.at)) && Number.isFinite(p?.glucoseMmol);
  const key = f => JSON.stringify([f.forecastAt,f.sourceTime,f.snapshot.sensorSourceId,f.sourceRevision,f.inputDigest,f.mealModel?.id??null,f.mealModel?.version??null]);
  const input = r => ({...r,sourceId:r.snapshot.sensorSourceId});

  function select({forecasts,cgm,sourceId,sourceTime,nowMs,preferences,minimumSourceRevision=0}) {
    const eligible = forecasts.map(x=>x.payload).filter(f=> f.contract==='glucopapa.research-forecast/2' &&
      IDS.includes(f.modelId) && f.sourceRevision>=minimumSourceRevision && f.snapshot.sensorSourceId===sourceId && Date.parse(f.sourceTime)===sourceTime &&
      Date.parse(f.forecastAt)<=nowMs && nowMs-Date.parse(f.forecastAt)<=MAX_AGE &&
      f.points.length===25 && f.points.every(safePoint));
    eligible.sort((a,b)=>Date.parse(b.forecastAt)-Date.parse(a.forecastAt)||b.sourceRevision-a.sourceRevision);
    const latest=eligible[0];
    if (!latest) return {status:'NO_CURRENT_FORECAST',lines:[]};
    const grouped=eligible.filter(f=>key(f)===key(latest));
    const visible=f=>preferences?.forecastVisibility?.[f.modelId]!==false;
    const original=(leader)=>grouped.filter(visible).map(f=>({modelId:f.modelId,points:f.points,
      highlight:f.modelId===leader,color:COLORS[f.modelId]}));
    if (preferences?.autoConsensus===false || new Set(grouped.map(f=>f.modelId)).size!==IDS.length) {
      return {status:grouped.length===IDS.length?'MANUAL':'INSUFFICIENT_MODELS',lines:original(null)};
    }
    const asOf=Date.parse(latest.forecastAt);
    const review=root.GFConsensusReview.evaluate({
      issued:forecasts.map(x=>x.payload)
        .filter(f=>f.contract==='glucopapa.research-forecast/2').map(input),
      actual:cgm.map(r=>({...r,sourceId:r.sourceDeviceId})),asOf,mealModel:latest.mealModel??null,
    });
    if (review.status==='COMPOSITE') {
      const curve=root.GFConsensusReview.compose(review,grouped.map(input));
      if (curve) {
        const points=Array.from({length:241},(_,i)=>{
          const p=curve.sample(i/2);
          return {at:new Date(p.at).toISOString(),glucoseMmol:p.glucoseMmol};
        });
        return {status:'COMPOSITE',lines:[{modelId:'GFConsensus',points,highlight:false,color:COLORS.GFConsensus}]};
      }
    }
    return {status:review.status,lines:original(review.leader)};
  }

  function overlay(svg, chart, window, lines) {
    if (!svg || !window || !lines.length) return;
    const {L,R,T,B}=chart.COORD;
    const x=t=>L+(t-window.start)/(window.end-window.start)*(R-L);
    const y=g=>B-(g-2)/11*(B-T); // Chart A uses the fixed 2–13 mmol/L axis.
    const group=root.document.createElementNS(SVG,'g');
    group.setAttribute('class','gp-research-forecast');
    group.setAttribute('clip-path','url(#gpPlotClip)');
    for (const line of lines) {
      const path=root.document.createElementNS(SVG,'path');
      path.setAttribute('data-forecast-model',line.modelId);
      path.setAttribute('d',line.points.map((p,i)=>(i?'L':'M')+
        x(Date.parse(p.at)).toFixed(2)+','+y(p.glucoseMmol).toFixed(2)).join(' '));
      path.setAttribute('fill','none');
      path.setAttribute('stroke',line.color);
      path.setAttribute('stroke-width',line.highlight?'3':'1.5');
      path.setAttribute('stroke-dasharray','5 3');
      const label=root.document.createElementNS(SVG,'title');
      label.textContent=(line.highlight?'★ ':'')+line.modelId+' · исследовательский прогноз';
      path.appendChild(label);
      group.appendChild(path);
    }
    svg.appendChild(group);
  }

  const api=Object.freeze({IDS,select,overlay});
  root.GFResearchForecastGraph=api;
  if (typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
