'use strict';
const fail = () => { throw Object.assign(Error('job_claim_lost'), { code: 'job_claim_lost' }); };
// The monotonically increasing attempt is persisted by claimNextJob/claimJobById.
// This object is passed internally, never read from the job payload or HTTP input.
function createJobClaim(job, { isActive, models = () => require('../../models'),
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE } = {}) {
  const id = Number(job?.id), attempt = Number(job?.attempts);
  const capturedNamespace = job?.payload?.__runtime_namespace;
  const claimedAt = Math.floor(new Date(job?.last_attempt_at).getTime() / 1000);
  return Object.freeze({ id, attempt, namespace: capturedNamespace,
    async assert({ transaction, executionId } = {}) {
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(attempt) || attempt < 1
        || !Number.isFinite(claimedAt) || claimedAt <= 0 || typeof isActive !== 'function' || !isActive()
        || typeof capturedNamespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(capturedNamespace)
        || capturedNamespace !== namespace()) fail();
      const db = typeof models === 'function' ? models() : models;
      const row = await db.JobRequest.findByPk(id, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
        attributes: ['id', 'type', 'status', 'attempts', 'last_attempt_at', 'payload'], logging: false });
      if (!row || row.status !== 'running' || Number(row.attempts) !== attempt
        || Math.floor(new Date(row.last_attempt_at).getTime() / 1000) !== claimedAt
        || row.payload?.__runtime_namespace !== capturedNamespace || !isActive() || namespace() !== capturedNamespace
        || executionId != null && (row.type !== 'automations_v2_execute'
          || Number(row.payload?.execution_id || row.payload?.executionId) !== Number(executionId))) fail();
      return true;
    },
  });
}
module.exports = { createJobClaim };
