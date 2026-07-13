const { Op } = require('sequelize');
const crypto = require('crypto');
const db = require('../../models');

const { JobRequest, sequelize, Sequelize } = db;

const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low'];
const CLAIMABLE_JOB_STATUSES = ['pending', 'queued', 'waiting'];
const PRIORITY_CASE_SQL = `(CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END)`;
const DEFAULT_MAX_ATTEMPTS = Number(process.env.JOB_REQUESTS_MAX_ATTEMPTS || 5);
const configuredUniqueEnqueueTransactionRetries = Number(
  process.env.JOB_REQUEST_ENQUEUE_UNIQUE_TRANSACTION_RETRIES || 3
);
const UNIQUE_ENQUEUE_TRANSACTION_RETRIES = Number.isInteger(configuredUniqueEnqueueTransactionRetries)
  && configuredUniqueEnqueueTransactionRetries > 0
  ? configuredUniqueEnqueueTransactionRetries
  : 3;
const RUNTIME_NAMESPACE_PAYLOAD_KEY = '__runtime_namespace';
const DEDUPE_SCOPE_PAYLOAD_KEY = '__dedupe_scope';
const ACTIVE_JOB_STATUSES = ['pending', 'queued', 'running', 'waiting'];

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

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

const typeListToWhere = (typeList) => {
  if (!Array.isArray(typeList) || !typeList.length) {
    return undefined;
  }
  const normalized = typeList
    .map((type) => String(type || '').trim())
    .filter((value, index, array) => value && array.indexOf(value) === index);
  return normalized.length ? { [Op.in]: normalized } : undefined;
};

const cleanString = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const detectCurrentRuntimeNamespace = () => {
  const explicit = cleanString(process.env.JOB_RUNTIME_NAMESPACE)
    || cleanString(process.env.RUNTIME_NAMESPACE);
  if (explicit) return explicit;

  const port = cleanString(process.env.PORT);
  if (port) return `port:${port}`;

  const cwd = cleanString(process.cwd());
  if (cwd) return `cwd:${cwd}`;

  return 'runtime:unknown';
};

const parseRuntimeNamespaceAliases = () => {
  return String(process.env.JOB_RUNTIME_NAMESPACE_ALIASES || '')
    .split(',')
    .map((value) => cleanString(value))
    .filter(Boolean);
};

const CURRENT_RUNTIME_NAMESPACE = detectCurrentRuntimeNamespace();
const RUNTIME_NAMESPACE_ALIASES = parseRuntimeNamespaceAliases()
  .filter((value, index, array) => value !== CURRENT_RUNTIME_NAMESPACE && array.indexOf(value) === index);
const CLAIM_RUNTIME_NAMESPACES = [CURRENT_RUNTIME_NAMESPACE, ...RUNTIME_NAMESPACE_ALIASES];
const HAS_EXPLICIT_RUNTIME_NAMESPACE = Boolean(
  cleanString(process.env.JOB_RUNTIME_NAMESPACE) || cleanString(process.env.RUNTIME_NAMESPACE)
);
const CLAIM_UNSCOPED_JOBS = parseBoolean(
  process.env.JOB_RUNTIME_CLAIM_UNSCOPED,
  !HAS_EXPLICIT_RUNTIME_NAMESPACE
);

const stableSerialize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).sort().join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

const normalizeScopeValue = (value, key = '') => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeScopeValue(item, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        normalizeScopeValue(nestedValue, nestedKey),
      ])
    );
  }
  if (/(clinic|clinica|group|grupo|customer|account|property|location)ids?$/i.test(key)) {
    return String(value ?? '').trim();
  }
  return typeof value === 'string' ? value.trim() : value;
};

const deriveDedupeScope = (payload = {}, explicitScope = null) => {
  const explicit = cleanString(explicitScope) || cleanString(payload?.[DEDUPE_SCOPE_PAYLOAD_KEY]);
  if (explicit) return explicit;

  const scopeKeys = [
    'clinicId', 'clinicaId', 'clinicIds',
    'groupId', 'grupoId', 'groupIds',
    'customerId', 'customerIds', 'accountId', 'accountIds',
    'siteMappings', 'mappings', 'siteUrls',
    'propertyIds', 'propertyNames', 'locationIds',
  ];
  const scopePayload = scopeKeys.reduce((acc, key) => {
    if (payload && payload[key] !== undefined && payload[key] !== null) {
      acc[key] = normalizeScopeValue(payload[key], key);
    }
    return acc;
  }, {});
  if (!Object.keys(scopePayload).length) return 'global';

  return `scope:${crypto.createHash('sha256').update(stableSerialize(scopePayload)).digest('hex')}`;
};

const buildScopedPayload = (payload = {}, { dedupeScope = null } = {}) => {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : {};

  if (!base[RUNTIME_NAMESPACE_PAYLOAD_KEY]) {
    base[RUNTIME_NAMESPACE_PAYLOAD_KEY] = CURRENT_RUNTIME_NAMESPACE;
  }
  if (dedupeScope && !base[DEDUPE_SCOPE_PAYLOAD_KEY]) {
    base[DEDUPE_SCOPE_PAYLOAD_KEY] = dedupeScope;
  }

  return base;
};

const buildRuntimeScopeWhere = ({
  includeUnscoped = CLAIM_UNSCOPED_JOBS,
  sequelizeInstance = sequelize,
  namespaces = CLAIM_RUNTIME_NAMESPACES,
} = {}) => {
  const jsonPath = `$."${RUNTIME_NAMESPACE_PAYLOAD_KEY}"`;
  const extractedNamespace = sequelizeInstance.literal(
    `JSON_UNQUOTE(JSON_EXTRACT(payload, '${jsonPath}'))`
  );
  const rawNamespace = sequelizeInstance.literal(
    `JSON_EXTRACT(payload, '${jsonPath}')`
  );

  const clauses = [
    sequelize.where(extractedNamespace, { [Op.in]: namespaces }),
  ];

  if (includeUnscoped) {
    clauses.push(sequelize.where(rawNamespace, { [Op.is]: null }));
  }

  return { [Op.or]: clauses };
};

const buildDedupeScopeWhere = (dedupeScope, sequelizeInstance = sequelize) => {
  const jsonPath = `$."${DEDUPE_SCOPE_PAYLOAD_KEY}"`;
  const extractedScope = sequelizeInstance.literal(
    `JSON_UNQUOTE(JSON_EXTRACT(payload, '${jsonPath}'))`
  );
  const rawScope = sequelizeInstance.literal(
    `JSON_EXTRACT(payload, '${jsonPath}')`
  );
  const exact = sequelize.where(extractedScope, dedupeScope);
  if (dedupeScope !== 'global') return exact;

  // Jobs anteriores a este campo representan el barrido global.
  return {
    [Op.or]: [
      exact,
      sequelize.where(rawScope, { [Op.is]: null }),
    ],
  };
};

const payloadRuntimeNamespace = (payload = null) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return cleanString(payload[RUNTIME_NAMESPACE_PAYLOAD_KEY]);
};

const matchesCurrentRuntimeNamespace = (payload = null, { allowUnscoped = CLAIM_UNSCOPED_JOBS } = {}) => {
  const payloadNamespace = payloadRuntimeNamespace(payload);
  if (!payloadNamespace) {
    return allowUnscoped;
  }
  return CLAIM_RUNTIME_NAMESPACES.includes(payloadNamespace);
};

const queryRawConnection = async (connection, sql, values = []) => {
  if (connection && typeof connection.promise === 'function') {
    const [rows] = await connection.promise().query(sql, values);
    return rows;
  }
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
};

const destroyRawConnection = async (connectionManager, connection) => {
  if (typeof connectionManager.destroyConnection === 'function') {
    await connectionManager.destroyConnection(connection);
    return;
  }
  if (typeof connection?.destroy === 'function') {
    connection.destroy();
  }
};

/**
 * Lease distribuido del carril de integraciones.
 *
 * MySQL GET_LOCK pertenece a la conexión, por eso se reserva una conexión del
 * pool durante todo el drain y se libera explícitamente al terminar. Un crash
 * cierra la conexión y MySQL suelta el lock sin necesitar tabla/migración.
 */
async function acquireBackgroundIntegrationLease(options = {}) {
  const sequelizeInstance = options.sequelizeInstance || sequelize;
  const connectionManager = options.connectionManager || sequelizeInstance.connectionManager;
  const dialect = typeof sequelizeInstance.getDialect === 'function'
    ? sequelizeInstance.getDialect()
    : 'mysql';
  if (!['mysql', 'mariadb'].includes(dialect)) {
    return { acquired: false, reason: `unsupported_dialect:${dialect}`, release: async () => {} };
  }

  const runtimeNamespace = cleanString(options.runtimeNamespace) || CURRENT_RUNTIME_NAMESPACE;
  const databaseName = cleanString(sequelizeInstance?.config?.database) || 'clinicaclick';
  const digest = crypto
    .createHash('sha256')
    .update(`${databaseName}:${runtimeNamespace}`)
    .digest('hex')
    .slice(0, 40);
  const lockName = `cc:bg:${digest}`;
  let connection = null;

  try {
    connection = await connectionManager.getConnection({ type: 'WRITE', useMaster: true });
    const rows = await queryRawConnection(
      connection,
      'SELECT GET_LOCK(?, 0) AS acquired',
      [lockName]
    );
    const acquired = Number(rows?.[0]?.acquired) === 1;
    if (!acquired) {
      await connectionManager.releaseConnection(connection);
      return { acquired: false, reason: 'contended', lockName, release: async () => {} };
    }

    let released = false;
    return {
      acquired: true,
      lockName,
      connectionId: connection.threadId || null,
      async release() {
        if (released) return;
        released = true;
        let lockReleased = false;
        try {
          const releaseRows = await queryRawConnection(
            connection,
            'SELECT RELEASE_LOCK(?) AS released',
            [lockName]
          );
          lockReleased = Number(releaseRows?.[0]?.released) === 1;
        } finally {
          if (lockReleased) {
            await connectionManager.releaseConnection(connection);
          } else {
            // Nunca se devuelve al pool una sesión que pueda conservar el lock.
            await destroyRawConnection(connectionManager, connection);
          }
        }
      },
    };
  } catch (error) {
    if (connection) {
      await destroyRawConnection(connectionManager, connection).catch(() => undefined);
    }
    throw error;
  }
}

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
  const scopedPayload = buildScopedPayload(payload);

  const job = await JobRequest.create({
    type,
    priority: normalizedPriority,
    status: normalizedStatus,
    origin,
    payload: scopedPayload,
    requested_by: requestedBy,
    requested_by_name: requestedByName,
    requested_by_role: requestedByRole,
    max_attempts: maxAttempts,
    next_run_at: nextRunAt,
    result_summary: resultSummary
  });

  return job;
}

/**
 * Encola una sola ejecución activa por tipo y runtime namespace.
 *
 * La transacción SERIALIZABLE evita que dos disparos concurrentes del líder
 * creen el mismo barrido periódico antes de que el worker reclame el primero.
 * Los jobs terminales no bloquean el siguiente ciclo.
 */
async function enqueueUniqueJobRequest({
  type,
  payload = {},
  priority = 'normal',
  status = 'pending',
  origin = 'scheduled',
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  nextRunAt = null,
  resultSummary = null,
  dedupeScope = null,
}, options = {}) {
  if (!type) {
    throw new Error('type is required to enqueue a unique job request');
  }

  const JobRequestModel = options.JobRequestModel || JobRequest;
  const sequelizeInstance = options.sequelizeInstance || sequelize;
  const activeStatuses = Array.isArray(options.activeStatuses) && options.activeStatuses.length
    ? options.activeStatuses
    : ACTIVE_JOB_STATUSES;
  const resolvedDedupeScope = deriveDedupeScope(payload, dedupeScope);
  const scopedPayload = buildScopedPayload(payload, { dedupeScope: resolvedDedupeScope });
  const targetRuntimeNamespace = payloadRuntimeNamespace(scopedPayload) || CURRENT_RUNTIME_NAMESPACE;

  const transactionRetries = Number.isInteger(Number(options.transactionRetries))
    ? Math.max(1, Number(options.transactionRetries))
    : Math.max(1, UNIQUE_ENQUEUE_TRANSACTION_RETRIES);

  for (let attempt = 1; attempt <= transactionRetries; attempt += 1) {
    try {
      return await sequelizeInstance.transaction(
        { isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          const existing = await JobRequestModel.findOne({
            where: {
              type,
              status: { [Op.in]: activeStatuses },
              [Op.and]: [
                buildRuntimeScopeWhere({
                  sequelizeInstance,
                  namespaces: [targetRuntimeNamespace],
                  includeUnscoped: targetRuntimeNamespace === CURRENT_RUNTIME_NAMESPACE
                    ? CLAIM_UNSCOPED_JOBS
                    : false,
                }),
                buildDedupeScopeWhere(resolvedDedupeScope, sequelizeInstance),
              ],
            },
            order: [['created_at', 'ASC']],
            transaction,
            lock: transaction.LOCK.UPDATE,
          });

          if (existing) {
            return { job: existing, created: false };
          }

          const job = await JobRequestModel.create({
            type,
            priority: normalizePriority(priority),
            status: normalizeStatus(status),
            origin,
            payload: scopedPayload,
            requested_by: requestedBy,
            requested_by_name: requestedByName,
            requested_by_role: requestedByRole,
            max_attempts: maxAttempts,
            next_run_at: nextRunAt,
            result_summary: resultSummary,
          }, { transaction });

          return { job, created: true };
        }
      );
    } catch (error) {
      const retryableTransactionError = [1205, 1213].includes(Number(error?.errno))
        || ['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK'].includes(error?.code)
        || /deadlock|lock wait timeout/i.test(String(error?.message || ''));
      if (!retryableTransactionError || attempt === transactionRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }

  throw new Error('No se pudo encolar el JobRequest único');
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

/**
 * Persiste el resultado de un handler únicamente si el JobRequest continúa
 * siendo propiedad lógica del worker que lo reclamó (`status=running`).
 *
 * Un UPDATE con cero filas no se reintenta sin condición: significa que otro
 * camino durable (reset, cancelación o una escritura cuyo ACK se perdió) ya
 * cambió el estado. Se devuelve como conflicto resuelto para que un worker
 * atrasado no sobrescriba ese estado más reciente.
 */
async function settleRunningJob(jobId, patch = {}) {
  const [updated] = await JobRequest.update(
    {
      ...patch,
      updated_at: new Date(),
    },
    { where: { id: jobId, status: 'running' } }
  );

  if (updated > 0) {
    const job = await JobRequest.findByPk(jobId);
    return {
      updated,
      resolved: true,
      conflict: false,
      job,
    };
  }

  const job = await JobRequest.findByPk(jobId);
  return {
    updated: 0,
    resolved: true,
    conflict: true,
    job,
  };
}

function buildWaitingScope(now) {
  return {
    [Op.or]: [
      { status: 'pending' },
      { status: 'queued' },
      { status: 'waiting', next_run_at: { [Op.eq]: null } },
      { status: 'waiting', next_run_at: { [Op.lte]: now } }
    ]
  };
}

async function claimNextJob(priorityList, typeList) {
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
      const typeWhere = typeListToWhere(typeList);
      if (typeWhere) {
        where.type = typeWhere;
      }
      where[Op.and] = where[Op.and] || [];
      where[Op.and].push(buildRuntimeScopeWhere());

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
      const allowedStatuses = CLAIMABLE_JOB_STATUSES;

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

      if (!CLAIMABLE_JOB_STATUSES.includes(job.status)) {
        return null;
      }

      if (
        job.status === 'waiting'
        && job.next_run_at
        && new Date(job.next_run_at).getTime() > now.getTime()
      ) {
        return null;
      }

      if (!matchesCurrentRuntimeNamespace(job.payload)) {
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

async function markWaiting(jobId, {
  nextRunAt,
  errorMessage = null,
  resultSummary = null,
  syncLogId = null,
} = {}) {
  const patch = {
    status: 'waiting',
    next_run_at: nextRunAt,
    error_message: errorMessage,
    result_summary: resultSummary
  };
  if (syncLogId !== null && syncLogId !== undefined) {
    patch.sync_log_id = syncLogId;
  }
  return settleRunningJob(jobId, patch);
}

async function markCompleted(jobId, { syncLogId = null, resultSummary = null } = {}) {
  const now = new Date();
  const patch = {
    status: 'completed',
    completed_at: now,
    next_run_at: null,
    error_message: null,
    result_summary: resultSummary
  };
  if (syncLogId !== null && syncLogId !== undefined) {
    patch.sync_log_id = syncLogId;
  }
  return settleRunningJob(jobId, patch);
}

async function markFailed(jobId, {
  errorMessage,
  nextRunAt = null,
  resultSummary = null,
  syncLogId = null,
} = {}) {
  const patch = {
    status: 'failed',
    error_message: errorMessage,
    next_run_at: nextRunAt,
    result_summary: resultSummary
  };
  if (syncLogId !== null && syncLogId !== undefined) {
    patch.sync_log_id = syncLogId;
  }
  return settleRunningJob(jobId, patch);
}

async function markCancelled(jobId, { errorMessage = null } = {}) {
  return updateJob(jobId, {
    status: 'cancelled',
    error_message: errorMessage,
    next_run_at: null
  });
}

/**
 * Recuperación compare-and-set tras fallar la persistencia terminal.
 *
 * Solo toca un registro que siga realmente en running. Si el UPDATE anterior
 * llegó a aplicarse aunque el cliente recibiese un error de conexión, no
 * revierte completed/failed a waiting.
 */
async function recoverRunningJobAfterSettlementFailure(jobId, {
  status = 'failed',
  nextRunAt = null,
  errorMessage,
  resultSummary = null,
  syncLogId = null,
} = {}) {
  const recoveryStatus = ['completed', 'failed', 'waiting'].includes(status)
    ? status
    : 'failed';
  const patch = {
    status: recoveryStatus,
    next_run_at: recoveryStatus === 'waiting' ? nextRunAt : null,
    completed_at: recoveryStatus === 'completed' ? new Date() : null,
    error_message: recoveryStatus === 'completed'
      ? null
      : (errorMessage || 'Fallo al persistir el resultado del job'),
    result_summary: resultSummary,
    updated_at: new Date(),
  };
  if (syncLogId !== null && syncLogId !== undefined) {
    patch.sync_log_id = syncLogId;
  }

  const [updated] = await JobRequest.update(patch, {
    where: { id: jobId, status: 'running' },
  });
  const job = await JobRequest.findByPk(jobId);
  return {
    updated,
    resolved: updated > 0 || Boolean(job && job.status !== 'running'),
    job,
  };
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
  const runtimeScope = buildRuntimeScopeWhere();
  const [exhausted] = await JobRequest.update(
    {
      status: 'failed',
      next_run_at: null,
      error_message: 'El servicio se reinició después de agotar los intentos del job'
    },
    {
      where: {
        status: 'running',
        [Op.and]: [
          runtimeScope,
          sequelize.where(sequelize.col('attempts'), { [Op.gte]: sequelize.col('max_attempts') })
        ]
      }
    }
  );

  const [rescheduled] = await JobRequest.update(
    {
      status: 'waiting',
      next_run_at: new Date(),
      error_message: 'Reprogramado automáticamente después de reinicio del servicio'
    },
    {
      where: {
        status: 'running',
        [Op.and]: [
          runtimeScope,
          sequelize.where(sequelize.col('attempts'), { [Op.lt]: sequelize.col('max_attempts') })
        ]
      }
    }
  );

  return { rescheduled, exhausted };
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
  ACTIVE_JOB_STATUSES,
  CLAIMABLE_JOB_STATUSES,
  enqueueJobRequest,
  enqueueUniqueJobRequest,
  claimNextJob,
  claimJobById,
  markWaiting,
  markCompleted,
  markFailed,
  markCancelled,
  recoverRunningJobAfterSettlementFailure,
  setPending,
  setSyncLog,
  resetRunningJobs,
  listJobRequests,
  findJobById,
  getCurrentRuntimeNamespace: () => CURRENT_RUNTIME_NAMESPACE,
  getRuntimeNamespaceAliases: () => RUNTIME_NAMESPACE_ALIASES,
  shouldClaimUnscopedJobs: () => CLAIM_UNSCOPED_JOBS,
  matchesCurrentRuntimeNamespace,
  acquireBackgroundIntegrationLease,
  _buildWaitingScope: buildWaitingScope,
  _deriveDedupeScope: deriveDedupeScope,
  _buildDedupeScopeWhere: buildDedupeScopeWhere,
};
