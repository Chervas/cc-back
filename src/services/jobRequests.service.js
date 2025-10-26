const { Op } = require('sequelize');
const db = require('../../models');

const { JobRequest, sequelize, Sequelize } = db;

const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low'];
const STATUS_WAIT_LIST = ['pending', 'waiting'];
const PRIORITY_CASE_SQL = `(CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END)`;
const DEFAULT_MAX_ATTEMPTS = Number(process.env.JOB_REQUESTS_MAX_ATTEMPTS || 5);

const normalizePriority = (priority = 'normal') => {
  const normalized = String(priority || '').toLowerCase();
  return PRIORITY_ORDER.includes(normalized) ? normalized : 'normal';
};

const normalizeStatus = (status = 'pending') => {
  const normalized = String(status || '').toLowerCase();
  const allowed = ['pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
  return allowed.includes(normalized) ? normalized : 'pending';
};

const priorityListToWhere = (priorityList) => {
  if (!Array.isArray(priorityList) || !priorityList.length) {
    return undefined;
  }
  const normalized = priorityList
    .map((priority) => normalizePriority(priority))
    .filter((value, index, array) => PRIORITY_ORDER.includes(value) && array.indexOf(value) === index);
  return normalized.length ? { [Op.in]: normalized } : undefined;
};

const baseOrder = [
  [sequelize.literal(PRIORITY_CASE_SQL), 'ASC'],
  [sequelize.literal("(CASE WHEN next_run_at IS NULL THEN 0 ELSE 1 END)"), 'ASC'],
  ['next_run_at', 'ASC'],
  ['created_at', 'ASC']
];

async function enqueueJobRequest({
  type,
  payload = {},
  priority = 'normal',
  status = 'pending',
  origin = 'manual',
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  nextRunAt = null,
  resultSummary = null
}) {
  if (!type) {
    throw new Error('type is required to enqueue a job request');
  }

  const normalizedPriority = normalizePriority(priority);
  const normalizedStatus = normalizeStatus(status);

  const job = await JobRequest.create({
    type,
    priority: normalizedPriority,
    status: normalizedStatus,
    origin,
    payload,
    requested_by: requestedBy,
    requested_by_name: requestedByName,
    requested_by_role: requestedByRole,
    max_attempts: maxAttempts,
    next_run_at: nextRunAt,
    result_summary: resultSummary
  });

  return job;
}

async function updateJob(id, patch = {}) {
  await JobRequest.update(
    {
      ...patch,
      updated_at: new Date()
    },
    { where: { id } }
  );

  return JobRequest.findByPk(id);
}

function buildWaitingScope(now) {
  return {
    [Op.or]: [
      { status: 'pending' },
      { status: 'waiting', next_run_at: { [Op.eq]: null } },
      { status: 'waiting', next_run_at: { [Op.lte]: now } }
    ]
  };
}

async function claimNextJob(priorityList) {
  const now = new Date();
  return sequelize.transaction(
    {
      isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
    },
    async (transaction) => {
      const where = buildWaitingScope(now);
      const priorityWhere = priorityListToWhere(priorityList);
      if (priorityWhere) {
        where.priority = priorityWhere;
      }

      const job = await JobRequest.findOne({
        where,
        order: baseOrder,
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true
      });

      if (!job) {
        return null;
      }

      const previousStatus = job.status;
      const allowedStatuses = STATUS_WAIT_LIST;

      if (!allowedStatuses.includes(previousStatus)) {
        return null;
      }

      const [updated] = await JobRequest.update(
        {
          status: 'running',
          last_attempt_at: now,
          attempts: job.attempts + 1
        },
        {
          where: { id: job.id, status: previousStatus },
          transaction
        }
      );

      if (!updated) {
        return null;
      }

      job.status = 'running';
      job.last_attempt_at = now;
      job.attempts += 1;
      return job;
    }
  );
}

async function claimJobById(jobId) {
  const now = new Date();
  return sequelize.transaction(
    {
      isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
    },
    async (transaction) => {
      const job = await JobRequest.findByPk(jobId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true
      });

      if (!job) {
        return null;
      }

      if (!STATUS_WAIT_LIST.includes(job.status)) {
        return null;
      }

      const [updated] = await JobRequest.update(
        {
          status: 'running',
          last_attempt_at: now,
          attempts: job.attempts + 1
        },
        {
          where: { id: job.id, status: job.status },
          transaction
        }
      );

      if (!updated) {
        return null;
      }

      job.status = 'running';
      job.last_attempt_at = now;
      job.attempts += 1;
      return job;
    }
  );
}

async function markWaiting(jobId, { nextRunAt, errorMessage = null, resultSummary = null } = {}) {
  return updateJob(jobId, {
    status: 'waiting',
    next_run_at: nextRunAt,
    error_message: errorMessage,
    result_summary: resultSummary
  });
}

async function markCompleted(jobId, { syncLogId = null, resultSummary = null } = {}) {
  const now = new Date();
  return updateJob(jobId, {
    status: 'completed',
    completed_at: now,
    next_run_at: null,
    error_message: null,
    sync_log_id: syncLogId,
    result_summary: resultSummary
  });
}

async function markFailed(jobId, { errorMessage, nextRunAt = null, resultSummary = null } = {}) {
  return updateJob(jobId, {
    status: 'failed',
    error_message: errorMessage,
    next_run_at: nextRunAt,
    result_summary: resultSummary
  });
}

async function markCancelled(jobId, { errorMessage = null } = {}) {
  return updateJob(jobId, {
    status: 'cancelled',
    error_message: errorMessage,
    next_run_at: null
  });
}

async function setPending(jobId, { nextRunAt = null, priority } = {}) {
  const patch = {
    status: 'pending',
    next_run_at: nextRunAt,
    error_message: null
  };

  if (priority) {
    patch.priority = normalizePriority(priority);
  }

  return updateJob(jobId, patch);
}

async function setSyncLog(jobId, syncLogId) {
  return updateJob(jobId, { sync_log_id: syncLogId });
}

async function resetRunningJobs() {
  await JobRequest.update(
    {
      status: 'waiting',
      next_run_at: new Date(),
      error_message: 'Reprogramado automáticamente después de reinicio del servicio'
    },
    {
      where: { status: 'running' }
    }
  );
}

async function listJobRequests({ statuses, priorities, limit = 50, offset = 0, order = [['created_at', 'DESC']] } = {}) {
  const where = {};
  if (Array.isArray(statuses) && statuses.length) {
    where.status = { [Op.in]: statuses };
  }
  if (Array.isArray(priorities) && priorities.length) {
    where.priority = { [Op.in]: priorities.map((priority) => normalizePriority(priority)) };
  }

  const { rows, count } = await JobRequest.findAndCountAll({
    where,
    limit,
    offset,
    order
  });

  return { rows, count };
}

async function findJobById(jobId) {
  return JobRequest.findByPk(jobId);
}

module.exports = {
  PRIORITY_ORDER,
  enqueueJobRequest,
  claimNextJob,
  claimJobById,
  markWaiting,
  markCompleted,
  markFailed,
  markCancelled,
  setPending,
  setSyncLog,
  resetRunningJobs,
  listJobRequests,
  findJobById
};
