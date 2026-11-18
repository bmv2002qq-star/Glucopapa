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
    const {measuredAtMs, receivedAtMs, mgdl, direction, stale} = payload;
    if (!Number.isSafeInteger(measuredAtMs) || !Number.isSafeInteger(receivedAtMs) ||
        receivedAtMs < measuredAtMs || receivedAtMs > now) {
      throw Error('CGM_PROVIDER_TIMESTAMP');
    }
    const port = host.connect('cgmAdapter');
    const result = port.ingestXDripObservation({
      ts: measuredAtMs, mgdl, direction, staleAtReceipt: stale, receivedAt: new Date(receivedAtMs).toISOString()
    }, port.getRevision());
    return {status: stale === true ? 'STALE' : stale === false ? 'OBSERVED' : 'FRESHNESS_UNKNOWN',
      revision: result.revision, measuredAtMs, idempotent: result.idempotent === true};
  }

  return Object.freeze({ingest});
});
