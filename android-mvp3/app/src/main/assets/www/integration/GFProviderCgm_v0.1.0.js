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
    const {measuredAtMs, receivedAtMs, mgdl, direction, stale, transport, device, deltaMgdl} = payload;
    if (!Number.isSafeInteger(measuredAtMs) || !Number.isSafeInteger(receivedAtMs) ||
        receivedAtMs < measuredAtMs || receivedAtMs > now) {
      throw Error('CGM_PROVIDER_TIMESTAMP');
    }
    const port = host.connect('cgmAdapter');
    const result = port.ingestXDripObservation({
      ts: measuredAtMs, mgdl, direction, staleAtReceipt: stale, receivedAt: new Date(receivedAtMs).toISOString(),
      ...(transport===undefined?{}:{transport,device,deltaMgdl}),
    }, port.getRevision());
    return {status: stale === true ? 'STALE' : stale === false ? 'OBSERVED' : 'FRESHNESS_UNKNOWN',
      revision: result.revision, measuredAtMs, idempotent: result.idempotent === true};
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

  return Object.freeze({ingest,ingestHistory});
});
