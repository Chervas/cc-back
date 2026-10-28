'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { uuid, id, stamp } = require('../../services/platform-audit/src/delegation-event');
const storage = new AsyncLocalStorage();
const PAYLOAD_KEY = '__cc_delegation_attribution';
const KEYS = ['delegationId', 'adminUserId', 'effectiveUserId', 'parentSessionRef', 'childSessionRef', 'expiresAt', 'runtimeNamespace'];
function fail() { throw Object.assign(Error('delegation_audit_invalid'), { code: 'delegation_audit_invalid', status: 503 }); }
function normalize(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(value, k))) fail();
  const result = Object.fromEntries(KEYS.map(k => [k, ['adminUserId', 'effectiveUserId'].includes(k) ? String(value[k]) : value[k]]));
  if (![result.delegationId, result.parentSessionRef, result.childSessionRef].every(uuid)
    || result.delegationId !== result.childSessionRef || result.parentSessionRef === result.childSessionRef
    || !id(result.adminUserId) || !id(result.effectiveUserId) || result.adminUserId === result.effectiveUserId
    || !stamp(result.expiresAt) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(result.runtimeNamespace || '')) fail();
  return Object.freeze(result);
}
function current() { const value = storage.getStore(); return value?.suppressed ? null : value || null; }
function run(value, work, { requestCorrelationId = randomUUID(), emitter = null } = {}) {
  if (!uuid(requestCorrelationId)) fail();
  return storage.run(Object.freeze({ delegation: normalize(value), requestCorrelationId, emitter }), work);
}
function suppress(work) { return storage.run({ suppressed: true }, work); }
function cleanPayload(payload) {
  const clean = { ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) };
  delete clean[PAYLOAD_KEY]; return clean;
}
function descriptor(value) {
  if (!value || !['native', 'bull'].includes(value.kind) || typeof value.type !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.type)) fail();
  return { kind: value.kind, type: value.type };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function createAttribution({ secret = () => process.env.JWT_SECRET,
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE } = {}) {
  const mac = body => {
    const key = secret(); if (typeof key !== 'string' || !key) fail();
    return createHmac('sha256', key).update('clinicaclick-delegation-job-attribution-v1\0').update(body).digest('hex');
  };
  return {
    attach(payload, job) {
      const context = current();
      if (!context && (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, PAYLOAD_KEY))) return payload;
      const clean = cleanPayload(payload);
      // This reserved envelope is always produced from verified server ALS, never from client JSON.
      delete clean[PAYLOAD_KEY];
      if (!context) return clean;
      const data = { version: 1, enqueueRef: randomUUID(), delegation: { ...context.delegation }, requestCorrelationId: context.requestCorrelationId, job: descriptor(job) };
      const body = canonical(data);
      clean[PAYLOAD_KEY] = { data, signature: mac(body) };
      return clean;
    },
    restore(payload, job) {
      if (!payload || !Object.hasOwn(payload, PAYLOAD_KEY)) return null;
      const envelope = payload[PAYLOAD_KEY];
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'data,signature' || !envelope.data
        || Object.keys(envelope.data).sort().join(',') !== 'delegation,enqueueRef,job,requestCorrelationId,version'
        || envelope.data.version !== 1 || !uuid(envelope.data.requestCorrelationId) || !uuid(envelope.data.enqueueRef)
        || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) fail();
      const expected = descriptor(job), actual = descriptor(envelope.data.job);
      if (actual.kind !== expected.kind || actual.type !== expected.type
        || !timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(mac(canonical(envelope.data)), 'hex'))) fail();
      const delegation = normalize(envelope.data.delegation);
      if (!namespace() || delegation.runtimeNamespace !== namespace()) fail();
      return { delegation, requestCorrelationId: envelope.data.requestCorrelationId, enqueueRef: envelope.data.enqueueRef };
    },
  };
}
const attribution = createAttribution();
module.exports = { normalize, current, run, suppress, cleanPayload, PAYLOAD_KEY, createAttribution,
  attachJob: (...args) => attribution.attach(...args), restoreJob: (...args) => attribution.restore(...args) };
