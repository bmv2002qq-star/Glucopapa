/* Native xDrip+ observations enter the active local journal through GFStorage only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GFProviderCgm = api;
})(globalThis, function () {
  'use strict';

  function ingest(host, mode, payload, now = Date.now()) {
    if (mode !== 'local') return {status: 'LOCAL_ONLY'};
    if (!payload || typeof payload.status !== 'string') throw Error('CGM_PROVIDER_RESPONSE');
    if (payload.status !== 'MEASUREMENT') return {status: payload.status};
    const row = observation(payload, now);
    const port = host.connect('cgmAdapter');
    const result = port.ingestXDripObservation(row, port.getRevision());
    return {...observed(payload), revision: result.revision, idempotent: result.idempotent === true};
  }

  function observation(payload, now) {
    const {measuredAtMs, receivedAtMs, mgdl, direction, stale, transport, device, deltaMgdl} = payload;
    if (!Number.isSafeInteger(measuredAtMs) || !Number.isSafeInteger(receivedAtMs) ||
        receivedAtMs < measuredAtMs || receivedAtMs > now) {
      throw Error('CGM_PROVIDER_TIMESTAMP');
    }
    return {ts: measuredAtMs, mgdl, direction, staleAtReceipt: stale, receivedAt: new Date(receivedAtMs).toISOString(),
      ...(transport===undefined?{}:{transport,device,deltaMgdl})};
  }

  function observed({measuredAtMs, stale}) {
    return {status: stale === true ? 'STALE' : stale === false ? 'OBSERVED' : 'FRESHNESS_UNKNOWN', measuredAtMs};
  }

  function ingestWindow(host, mode, payload, now = Date.now()) {
    if (mode !== 'local') return {status: 'LOCAL_ONLY'};
    if (!payload || typeof payload.status !== 'string') throw Error('CGM_PROVIDER_RESPONSE');
    if (payload.status !== 'WEB_WINDOW_READY') return {status: payload.status};
    const {latest, items} = payload;
    if (latest?.status !== 'MEASUREMENT' || !Array.isArray(items) || items.length > 287) {
      throw Error('CGM_XDRIP_HISTORY_FORMAT');
    }
    const port = host.connect('cgmAdapter');
    const result = port.ingestXDripWindow({
      latest: observation(latest, now),
      items: items.map(({measuredAtMs,mgdl,direction})=>({ts:measuredAtMs,mgdl,direction})),
    }, port.getRevision());
    return {...observed(latest), revision: result.revision,
      historyAdded: result.idempotent?0:Number(result.recordId.split(':')[1])};
  }

  function ingestHistory(host, mode, payload, now = Date.now()) {
    if (mode !== 'local') return {status: 'LOCAL_ONLY'};
    if (!payload || typeof payload.status !== 'string') throw Error('CGM_PROVIDER_RESPONSE');
    if (payload.status !== 'HISTORY_READY') return {status: payload.status};
    const {anchorTs,anchorSgv,receivedAtMs,items} = payload;
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs > now || !Array.isArray(items) || items.length > 287)
      throw Error('CGM_XDRIP_HISTORY_FORMAT');
    const port = host.connect('cgmAdapter');
    const result = port.ingestXDripHistory({
      anchorTs,anchorSgv,receivedAt:new Date(receivedAtMs).toISOString(),
      items:items.map(({measuredAtMs,mgdl,direction})=>({ts:measuredAtMs,mgdl,direction}))
    },port.getRevision());
    return {status:'HISTORY_IMPORTED',revision:result.revision,
      added:result.idempotent?0:Number(result.recordId.split(':')[1])};
  }

  return Object.freeze({ingest,ingestHistory,ingestWindow});
});
