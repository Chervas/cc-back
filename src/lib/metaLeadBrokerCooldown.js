'use strict';

// In-process provenance, never a flag accepted from a webhook, queue payload or
// persisted result_summary. Only a broker cooldown or a locally verified need
// for renewed credentials may preserve a claim budget. attempts stays monotonic.
const TYPES = new Set(['campaign_meta_lead_receive', 'campaign_meta_page_reception']);
const waits = new WeakMap();
const proofs = new WeakMap();
const MAX_WAIT_MS = 86400000;
const MAX_BUDGET = 1000000;
const CREDENTIAL_WAIT_MS = 15 * 60000;
const fail = () => { throw Object.assign(Error('meta_lead_cooldown_invalid'), { code: 'meta_lead_cooldown_invalid' }); };
function createBrokerCooldownWait(type, retryAfterMs, now = Date.now()) {
  if (!TYPES.has(type) || !Number.isSafeInteger(now) || !Number.isSafeInteger(retryAfterMs)
    || retryAfterMs < 1 || retryAfterMs > MAX_WAIT_MS) fail();
  const at = now + retryAfterMs;
  const result = Object.freeze({ status: 'waiting', nextAllowedAt: new Date(at), reason: 'meta_broker_cooldown' });
  waits.set(result, { type, at });
  return result;
}
function createCredentialRenewalWait(type, now = Date.now(), credentialError = 'meta_credential_renewal_required') {
  if (type !== 'campaign_meta_lead_receive' || !Number.isSafeInteger(now)
    || !['meta_credential_renewal_required', 'credential_revoked'].includes(credentialError)) fail();
  const at = now + CREDENTIAL_WAIT_MS;
  const reason = 'meta_credential_renewal_required';
  const result = Object.freeze({ status: 'waiting', nextAllowedAt: new Date(at), reason, credentialError,
    error: Object.assign(Error(credentialError), { code: credentialError }) });
  waits.set(result, { type, at });
  return result;
}
function retryBudgetProof(job, execution, now = Date.now()) {
  const raw = execution?.result;
  const issued = raw && waits.get(raw);
  if (!issued) return null;
  const at = +new Date(execution.nextRunAt);
  if (execution.status !== 'waiting' || job?.type !== issued.type || at !== issued.at || at <= now || at - now > MAX_WAIT_MS
    || !Number.isSafeInteger(Number(job.id)) || Number(job.id) < 1
    || !Number.isSafeInteger(Number(job.attempts)) || Number(job.attempts) < 1
    || !Number.isSafeInteger(Number(job.max_attempts)) || Number(job.max_attempts) < Number(job.attempts)
    || Number(job.max_attempts) >= MAX_BUDGET) fail();
  const proof = Object.freeze({});
  proofs.set(proof, { jobId: Number(job.id), attempt: Number(job.attempts), maxAttempts: Number(job.max_attempts), type: job.type, at });
  return proof;
}
function inspectRetryBudgetProof(proof, jobId, expectedAttempt, nextRunAt, now = Date.now()) {
  const value = proofs.get(proof);
  if (!value || value.jobId !== Number(jobId) || value.attempt !== expectedAttempt
    || value.at !== +new Date(nextRunAt) || value.at <= now || value.at - now > MAX_WAIT_MS) fail();
  return { ...value };
}
module.exports = { createBrokerCooldownWait, createCredentialRenewalWait, retryBudgetProof, inspectRetryBudgetProof, MAX_WAIT_MS, MAX_BUDGET, CREDENTIAL_WAIT_MS };
