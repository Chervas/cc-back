'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const OVERVIEW_CACHE_FRESH_TTL_MS = Math.max(
  60 * 60 * 1000,
  Math.min(7 * DAY_MS, Number(process.env.MARKETING_REPORT_OVERVIEW_CACHE_FRESH_TTL_MS || DAY_MS))
);
const OVERVIEW_CACHE_EXPIRES_TTL_MS = Math.max(
  OVERVIEW_CACHE_FRESH_TTL_MS,
  Math.min(14 * DAY_MS, Number(process.env.MARKETING_REPORT_OVERVIEW_CACHE_EXPIRES_TTL_MS || 3 * DAY_MS))
);
const OVERVIEW_CACHE_REFRESH_LEASE_MS = Math.max(
  5 * 60 * 1000,
  Math.min(2 * 60 * 60 * 1000, Number(process.env.MARKETING_REPORT_OVERVIEW_CACHE_REFRESH_LEASE_MS || 30 * 60 * 1000))
);
const OVERVIEW_CACHE_VERSION = process.env.MARKETING_REPORT_OVERVIEW_CACHE_VERSION || 'marketing-overview-v1';
const OVERVIEW_REFRESH_JOB_TYPE = 'marketing_reports_cache_refresh';

const {
  Clinica,
  MarketingReportOverviewCache,
} = db;

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanString(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function limitedString(value, maxLength) {
  const normalized = cleanString(value);
  return normalized ? normalized.slice(0, maxLength) : null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueSortedIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(positiveInt)
    .filter(Boolean))]
    .sort((left, right) => left - right);
}

function normalizeScope(scope = {}) {
  const clinicIds = uniqueSortedIds(scope.clinicIds);
  const groupId = positiveInt(scope.groupId);
  const type = cleanString(scope.scope) || (scope.isAll ? 'all' : (groupId ? 'group' : 'clinic'));
  const normalizedGroupId = type === 'group' ? groupId : null;
  return {
    type,
    all: !!scope.isAll || type === 'all',
    group_id: normalizedGroupId,
    clinic_ids: clinicIds,
  };
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateLabel(value) {
  const date = validDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function isoDate(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

function rowValue(row, key) {
  if (!row) return null;
  if (typeof row.get === 'function') return row.get(key);
  return row[key];
}

function payloadFromRow(row) {
  const value = rowValue(row, 'payload');
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function buildOverviewCacheIdentity({
  scope,
  range,
  section = 'overview',
  reportVersion = OVERVIEW_CACHE_VERSION,
}) {
  const normalizedScope = normalizeScope(scope);
  const normalized = {
    report_version: cleanString(reportVersion),
    section: cleanString(section) || 'overview',
    scope: normalizedScope,
    period_start: dateLabel(range?.start || range?.startLabel),
    period_end: dateLabel(range?.end || range?.endLabel),
    comparison_start: dateLabel(range?.previous?.start || range?.previous?.startLabel),
    comparison_end: dateLabel(range?.previous?.end || range?.previous?.endLabel),
  };
  if (!normalized.report_version || !normalized.period_start || !normalized.period_end) {
    throw new Error('La identidad persistente del informe está incompleta');
  }
  if (!normalized.comparison_start || !normalized.comparison_end) {
    throw new Error('La identidad persistente del informe necesita periodo comparativo');
  }

  return {
    cache_key: sha256(stableStringify(normalized)),
    report_version: limitedString(normalized.report_version, 96),
    section: limitedString(normalized.section, 32) || 'overview',
    scope_key: sha256(stableStringify(normalizedScope)),
    scope_type: limitedString(normalizedScope.type, 32),
    scope_payload: normalizedScope,
    primary_clinic_id: normalizedScope.clinic_ids.length === 1 ? normalizedScope.clinic_ids[0] : null,
    group_id: normalizedScope.group_id,
    period_start: normalized.period_start,
    period_end: normalized.period_end,
    comparison_start: normalized.comparison_start,
    comparison_end: normalized.comparison_end,
  };
}

function cacheDefaults(identity) {
  return {
    ...identity,
    payload: null,
    generated_at: null,
    data_cutoff_at: null,
    fresh_until: null,
    expires_at: null,
    refresh_state: 'idle',
    refresh_lock_token: null,
    refresh_locked_until: null,
    last_refresh_started_at: null,
    last_refresh_finished_at: null,
    last_refresh_error: null,
  };
}

function identityFromRow(row) {
  if (!row) return null;
  return {
    cache_key: rowValue(row, 'cache_key'),
    report_version: rowValue(row, 'report_version'),
    section: rowValue(row, 'section') || 'overview',
    scope_key: rowValue(row, 'scope_key'),
    scope_type: rowValue(row, 'scope_type'),
    scope_payload: rowValue(row, 'scope_payload') || {},
    primary_clinic_id: positiveInt(rowValue(row, 'primary_clinic_id')),
    group_id: positiveInt(rowValue(row, 'group_id')),
    period_start: rowValue(row, 'period_start'),
    period_end: rowValue(row, 'period_end'),
    comparison_start: rowValue(row, 'comparison_start'),
    comparison_end: rowValue(row, 'comparison_end'),
  };
}

function overviewCacheStatus(row, now = new Date()) {
  if (!payloadFromRow(row) || !validDate(rowValue(row, 'generated_at'))) return 'miss';
  const nowMs = validDate(now)?.getTime() ?? Date.now();
  const freshUntil = validDate(rowValue(row, 'fresh_until'));
  const expiresAt = validDate(rowValue(row, 'expires_at'));
  if (freshUntil && nowMs < freshUntil.getTime()) return 'fresh';
  if (expiresAt && nowMs < expiresAt.getTime()) return 'stale';
  return 'expired';
}

function refreshInProgress(row, now = new Date()) {
  const lockedUntil = validDate(rowValue(row, 'refresh_locked_until'));
  return rowValue(row, 'refresh_state') === 'refreshing'
    && !!lockedUntil
    && lockedUntil.getTime() > (validDate(now)?.getTime() ?? Date.now());
}

function withOverviewCacheMetadata(payload, row, {
  now = new Date(),
  status = overviewCacheStatus(row, now),
  refreshPending = null,
  refreshAvailable = null,
  reportVersion = null,
} = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const inProgress = refreshPending === null ? refreshInProgress(row, now) : !!refreshPending;
  return {
    ...source,
    cache: {
      type: 'marketing_report_overview',
      status,
      generated_at: isoDate(rowValue(row, 'generated_at')),
      data_cutoff_at: isoDate(rowValue(row, 'data_cutoff_at')),
      fresh_until: isoDate(rowValue(row, 'fresh_until')),
      expires_at: isoDate(rowValue(row, 'expires_at')),
      refresh_available: refreshAvailable === null
        ? status !== 'fresh' && !inProgress
        : !!refreshAvailable,
      refresh_in_progress: inProgress,
      report_version: cleanString(rowValue(row, 'report_version')) || cleanString(reportVersion) || OVERVIEW_CACHE_VERSION,
    },
  };
}

function isMissingCacheTableError(error) {
  const message = String(error?.message || '');
  return ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.original?.code || error?.parent?.code || error?.code)
    || /MarketingReportOverviewCaches|Unknown column|doesn't exist/i.test(message);
}

function createOverviewCacheCoordinator({
  model = MarketingReportOverviewCache,
  now = () => new Date(),
  randomToken = () => crypto.randomUUID(),
  scheduleRefresh = null,
  logger = console,
} = {}) {
  if (!model) throw new Error('MarketingReportOverviewCache model is required');

  async function find(identity, options = {}) {
    return model.findOne({
      where: { cache_key: identity.cache_key },
      ...(options.transaction ? { transaction: options.transaction } : {}),
      ...(options.lock ? { lock: options.lock } : {}),
    });
  }

  async function ensure(identity, options = {}) {
    try {
      const [row] = await model.findOrCreate({
        where: { cache_key: identity.cache_key },
        defaults: cacheDefaults(identity),
        ...(options.transaction ? { transaction: options.transaction } : {}),
      });
      return row;
    } catch (error) {
      if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
      return find(identity, options);
    }
  }

  async function acquire(identity, observedRow = null) {
    const current = observedRow || await ensure(identity);
    const acquiredAt = now();
    const token = randomToken();
    const lockedUntil = new Date(acquiredAt.getTime() + OVERVIEW_CACHE_REFRESH_LEASE_MS);
    const expectedGeneratedAt = validDate(rowValue(current, 'generated_at'));
    const where = {
      cache_key: identity.cache_key,
      generated_at: expectedGeneratedAt || null,
      [Op.or]: [
        { refresh_locked_until: null },
        { refresh_locked_until: { [Op.lte]: acquiredAt } },
      ],
    };
    const [updated] = await model.update({
      ...identity,
      refresh_state: 'refreshing',
      refresh_lock_token: token,
      refresh_locked_until: lockedUntil,
      last_refresh_started_at: acquiredAt,
      last_refresh_error: null,
    }, { where });
    const row = await find(identity);
    return { acquired: updated === 1, token: updated === 1 ? token : null, row };
  }

  async function release(identity, token, error = null) {
    const finishedAt = now();
    await model.update({
      refresh_state: error ? 'failed' : 'idle',
      refresh_lock_token: null,
      refresh_locked_until: null,
      last_refresh_finished_at: finishedAt,
      last_refresh_error: error ? String(error?.message || error).slice(0, 4000) : null,
    }, {
      where: { cache_key: identity.cache_key, refresh_lock_token: token },
    });
  }

  async function persist(identity, payload, token = null) {
    const generatedAt = now();
    const update = {
      ...identity,
      payload: payload || {},
      generated_at: generatedAt,
      data_cutoff_at: validDate(payload?.lastUpdated) || generatedAt,
      fresh_until: new Date(generatedAt.getTime() + OVERVIEW_CACHE_FRESH_TTL_MS),
      expires_at: new Date(generatedAt.getTime() + OVERVIEW_CACHE_EXPIRES_TTL_MS),
      refresh_state: 'idle',
      refresh_lock_token: null,
      refresh_locked_until: null,
      last_refresh_finished_at: generatedAt,
      last_refresh_error: null,
    };
    if (token) {
      const [updated] = await model.update(update, {
        where: { cache_key: identity.cache_key, refresh_lock_token: token },
      });
      const stored = await find(identity);
      if (updated !== 1 || !stored) {
        const error = new Error('Se perdió el lease antes de persistir el informe');
        error.code = 'OVERVIEW_CACHE_REFRESH_LEASE_LOST';
        throw error;
      }
      return stored;
    }

    await ensure(identity);
    await model.update(update, { where: { cache_key: identity.cache_key } });
    return find(identity);
  }

  async function generateAndPersist(identity, token, generate) {
    try {
      const payload = await generate();
      const stored = await persist(identity, payload, token);
      return withOverviewCacheMetadata(payloadFromRow(stored), stored, { now: now() });
    } catch (error) {
      await release(identity, token, error).catch(() => {});
      throw error;
    }
  }

  async function readOrGenerate({ identity, generate, forceRefresh = false, staleWhileRefresh = true }) {
    try {
      let row = await find(identity);
      let status = overviewCacheStatus(row, now());

      if (!forceRefresh && status === 'fresh') {
        return withOverviewCacheMetadata(payloadFromRow(row), row, { now: now(), status });
      }

      if (!forceRefresh && status === 'stale' && staleWhileRefresh) {
        const lease = await acquire(identity, row);
        row = lease.row || row;
        status = overviewCacheStatus(row, now());
        if (status === 'fresh') {
          return withOverviewCacheMetadata(payloadFromRow(row), row, { now: now(), status });
        }
        if (lease.acquired && typeof scheduleRefresh === 'function') {
          try {
            await scheduleRefresh({ identity, token: lease.token });
          } catch (error) {
            await release(identity, lease.token, error).catch(() => {});
            logger?.warn?.('No se pudo encolar refresco de informe persistente:', error?.message || error);
            return withOverviewCacheMetadata(payloadFromRow(row), row, {
              now: now(),
              status,
              refreshPending: false,
            });
          }
        }
        return withOverviewCacheMetadata(payloadFromRow(row), row, {
          now: now(),
          status,
          refreshPending: lease.acquired || refreshInProgress(row, now()),
        });
      }

      const lease = await acquire(identity, row);
      if (!lease.acquired) {
        const current = lease.row || await find(identity);
        const currentStatus = overviewCacheStatus(current, now());
        if (currentStatus !== 'miss') {
          return withOverviewCacheMetadata(payloadFromRow(current), current, {
            now: now(),
            status: currentStatus,
            refreshPending: refreshInProgress(current, now()),
          });
        }
      }
      const token = lease.acquired ? lease.token : null;
      const payload = await generate();
      const stored = token ? await persist(identity, payload, token) : await persist(identity, payload);
      return withOverviewCacheMetadata(payloadFromRow(stored), stored, { now: now() });
    } catch (error) {
      if (isMissingCacheTableError(error)) {
        logger?.warn?.('MarketingReportOverviewCaches no disponible; calculando informe sin caché persistente.');
        return {
          ...(await generate()),
          cache: {
            type: 'marketing_report_overview',
            status: 'bypass',
            generated_at: null,
            data_cutoff_at: null,
            fresh_until: null,
            expires_at: null,
            refresh_available: false,
            refresh_in_progress: false,
            report_version: OVERVIEW_CACHE_VERSION,
            unavailable: true,
          },
        };
      }
      throw error;
    }
  }

  async function claimForRefresh(identity, expectedToken = null) {
    const row = await find(identity);
    const currentToken = cleanString(rowValue(row, 'refresh_lock_token'));
    if (expectedToken && currentToken === expectedToken && refreshInProgress(row, now())) {
      return { acquired: true, reused: true, token: expectedToken, row };
    }
    const lease = await acquire(identity, row);
    return { ...lease, reused: false };
  }

  return {
    find,
    ensure,
    acquire,
    release,
    persist,
    generateAndPersist,
    readOrGenerate,
    claimForRefresh,
  };
}

const overviewCache = MarketingReportOverviewCache
  ? createOverviewCacheCoordinator({
    model: MarketingReportOverviewCache,
    scheduleRefresh: async ({ identity, token }) => jobRequestsService.enqueueUniqueJobRequest({
      type: OVERVIEW_REFRESH_JOB_TYPE,
      priority: 'low',
      origin: 'marketing_reports_cache',
      dedupeScope: `marketing-report:${identity.cache_key}`,
      payload: {
        cacheKey: identity.cache_key,
        refreshToken: token,
        identity,
      },
      maxAttempts: 3,
    }),
  })
  : null;

function defaultReportEndDate(now = new Date()) {
  const date = validDate(now) || new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function defaultClinicScope(clinicId, groupId = null) {
  return {
    scope: 'clinic',
    isAll: false,
    groupId: positiveInt(groupId),
    clinicIds: [positiveInt(clinicId)].filter(Boolean),
    original: { clinicId: String(clinicId) },
  };
}

async function activeClinicRows({ clinicIds = null, limit = null } = {}) {
  const where = {};
  const normalizedIds = uniqueSortedIds(clinicIds);
  if (normalizedIds.length) where.id_clinica = { [Op.in]: normalizedIds };
  if (Object.prototype.hasOwnProperty.call(Clinica.rawAttributes || {}, 'estado_clinica')) {
    where[Op.or] = [
      { estado_clinica: true },
      { estado_clinica: null },
    ];
  }
  return Clinica.findAll({
    where,
    attributes: ['id_clinica', 'grupoClinicaId'],
    order: [['id_clinica', 'ASC']],
    ...(positiveInt(limit) ? { limit: positiveInt(limit) } : {}),
    raw: true,
  });
}

async function refreshOverviewSnapshots({
  buildOverviewPayload,
  buildRange,
  cacheKey = null,
  identity = null,
  refreshToken = null,
  clinicIds = null,
  limit = null,
  section = 'overview',
  now = new Date(),
  prune = true,
} = {}) {
  try {
    if (typeof buildOverviewPayload !== 'function' || typeof buildRange !== 'function') {
      throw new Error('refreshOverviewSnapshots requires buildOverviewPayload and buildRange');
    }
    if (!overviewCache) {
      return { status: 'completed', processed: 0, skipped: true, reason: 'cache_model_unavailable' };
    }

    const deleted = prune ? await cleanupOverviewCache() : 0;

    if (cacheKey) {
      const requestedIdentity = identity && typeof identity === 'object'
        ? identity
        : identityFromRow(await overviewCache.find({ cache_key: cacheKey }));
      if (!requestedIdentity) {
        return { status: 'completed', processed: 0, deleted, skipped: true, reason: 'cache_identity_not_found' };
      }
      if (requestedIdentity.cache_key !== cacheKey) {
        return { status: 'failed', retryable: false, error_message: 'La identidad del snapshot de informe ha cambiado' };
      }
      const range = buildRange(requestedIdentity.period_start, requestedIdentity.period_end, 30);
      const scope = requestedIdentity.scope_payload || rowValue(requestedIdentity, 'scope_payload') || {};
      const claim = await overviewCache.claimForRefresh(requestedIdentity, refreshToken);
      if (!claim.acquired || !claim.token) {
        return {
          status: 'waiting',
          backoffMs: 60 * 1000,
          error: new Error('Otro worker está refrescando este informe'),
        };
      }
      await overviewCache.generateAndPersist(requestedIdentity, claim.token, () => buildOverviewPayload({ scope, range }));
      return {
        status: 'completed',
        processed: 1,
        deleted,
        refreshed: [{ cacheKey }],
      };
    }

    const end = defaultReportEndDate(now);
    const start = new Date(end.getTime() - (29 * DAY_MS));
    const range = buildRange(start, end, 30);
    const clinics = await activeClinicRows({ clinicIds, limit });
    const refreshed = [];
    const errors = [];

    for (const clinic of clinics) {
      const scope = defaultClinicScope(clinic.id_clinica, clinic.grupoClinicaId);
      const snapshotIdentity = buildOverviewCacheIdentity({ scope, range, section });
      try {
        await overviewCache.readOrGenerate({
          identity: snapshotIdentity,
          forceRefresh: true,
          staleWhileRefresh: false,
          generate: () => buildOverviewPayload({ scope, range }),
        });
        refreshed.push({
          clinicId: Number(clinic.id_clinica),
          cacheKey: snapshotIdentity.cache_key,
        });
      } catch (error) {
        errors.push({
          clinicId: Number(clinic.id_clinica),
          error: error.message || String(error),
        });
      }
    }

    return {
      status: errors.length && !refreshed.length ? 'failed' : 'completed',
      processed: refreshed.length,
      deleted,
      errors,
      refreshed,
    };
  } catch (error) {
    if (isMissingCacheTableError(error)) {
      return { status: 'completed', processed: 0, skipped: true, reason: 'cache_table_unavailable' };
    }
    throw error;
  }
}

async function cleanupOverviewCache({ retentionDays = 7, now = new Date() } = {}) {
  if (!MarketingReportOverviewCache) return 0;
  const safeRetentionDays = Math.max(2, Math.min(30, Number(retentionDays) || 7));
  const cutoff = new Date((validDate(now)?.getTime() ?? Date.now()) - (safeRetentionDays * DAY_MS));
  try {
    return await MarketingReportOverviewCache.destroy({
      where: {
        [Op.or]: [
          { expires_at: { [Op.lt]: cutoff } },
        {
          report_version: { [Op.ne]: OVERVIEW_CACHE_VERSION },
          expires_at: { [Op.lt]: now },
        },
        { scope_type: 'clinic', group_id: { [Op.ne]: null } },
        { payload: null, created_at: { [Op.lt]: cutoff } },
      ],
    },
    });
  } catch (error) {
    if (isMissingCacheTableError(error)) return 0;
    throw error;
  }
}

module.exports = {
  DAY_MS,
  OVERVIEW_CACHE_FRESH_TTL_MS,
  OVERVIEW_CACHE_EXPIRES_TTL_MS,
  OVERVIEW_CACHE_REFRESH_LEASE_MS,
  OVERVIEW_CACHE_VERSION,
  OVERVIEW_REFRESH_JOB_TYPE,
  buildOverviewCacheIdentity,
  overviewCacheStatus,
  refreshInProgress,
  withOverviewCacheMetadata,
  createOverviewCacheCoordinator,
  overviewCache,
  refreshOverviewSnapshots,
  cleanupOverviewCache,
  __testing: {
    stableStringify,
    normalizeScope,
    payloadFromRow,
    cacheDefaults,
    activeClinicRows,
    defaultClinicScope,
  },
};
