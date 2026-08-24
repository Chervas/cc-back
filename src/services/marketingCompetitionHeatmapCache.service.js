'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_FRESH_TTL_MS = 7 * DAY_MS;
const HEATMAP_EXPIRES_TTL_MS = 14 * DAY_MS;
// El refresco stale se ejecuta en el orquestador durable. El lease cubre una
// cola temporalmente ocupada y evita que otra petición encole el mismo cálculo.
const HEATMAP_REFRESH_LEASE_MS = 30 * 60 * 1000;

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

function normalizeScope(scope = {}) {
  return {
    type: cleanString(scope.scope) || (scope.isAll ? 'all' : 'clinic'),
    all: !!scope.isAll,
    group_id: positiveInt(scope.groupId),
    clinic_ids: [...new Set((Array.isArray(scope.clinicIds) ? scope.clinicIds : [])
      .map(positiveInt)
      .filter(Boolean))].sort((left, right) => left - right)
  };
}

function buildHeatmapCacheIdentity({
  scope,
  clinicId,
  placeKey,
  googlePlaceId = null,
  term,
  zoomKm,
  gridSize,
  algorithmVersion
}) {
  const scopePayload = normalizeScope(scope);
  const normalized = {
    algorithm_version: cleanString(algorithmVersion),
    scope: scopePayload,
    clinic_id: positiveInt(clinicId),
    place_key: cleanString(placeKey),
    term: cleanString(term)?.toLocaleLowerCase('es-ES') || null,
    zoom_km: positiveInt(zoomKm),
    grid_size: positiveInt(gridSize)
  };
  if (!normalized.algorithm_version || !normalized.clinic_id || !normalized.place_key || !normalized.term) {
    throw new Error('La identidad persistente del heatmap está incompleta');
  }
  if (!normalized.zoom_km || !normalized.grid_size) {
    throw new Error('El zoom y la cuadrícula del heatmap deben ser enteros positivos');
  }

  return {
    cache_key: sha256(stableStringify(normalized)),
    algorithm_version: limitedString(normalized.algorithm_version, 96),
    scope_key: sha256(stableStringify(scopePayload)),
    scope_type: limitedString(scopePayload.type, 32),
    scope_payload: scopePayload,
    primary_clinic_id: normalized.clinic_id,
    place_key: limitedString(normalized.place_key, 512),
    google_place_id: limitedString(googlePlaceId, 255),
    search_term: limitedString(term, 512),
    zoom_km: normalized.zoom_km,
    grid_size: normalized.grid_size
  };
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

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoDate(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

function heatmapCacheStatus(row, now = new Date()) {
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
    && lockedUntil.getTime() > validDate(now).getTime();
}

function withHeatmapCacheMetadata(payload, row, {
  now = new Date(),
  status = heatmapCacheStatus(row, now),
  providerRequests = null,
  refreshPending = null,
  refreshAvailable = null,
  algorithmVersion = null
} = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const inProgress = refreshPending === null ? refreshInProgress(row, now) : !!refreshPending;
  const storedRequests = Number(rowValue(row, 'provider_requests'));
  const hasExplicitProviderRequests = providerRequests !== null && providerRequests !== undefined;
  const requests = hasExplicitProviderRequests && Number.isFinite(Number(providerRequests))
    ? Number(providerRequests)
    : (Number.isFinite(storedRequests) ? storedRequests : 0);
  return {
    ...source,
    cache: {
      status,
      generated_at: isoDate(rowValue(row, 'generated_at')),
      fresh_until: isoDate(rowValue(row, 'fresh_until')),
      expires_at: isoDate(rowValue(row, 'expires_at')),
      provider_requests: Math.max(0, Math.round(requests)),
      refresh_available: refreshAvailable === null
        ? status !== 'fresh' && !inProgress
        : !!refreshAvailable,
      refresh_in_progress: inProgress,
      algorithm_version: cleanString(rowValue(row, 'algorithm_version')) || cleanString(algorithmVersion)
    }
  };
}

function cacheDefaults(identity) {
  return {
    ...identity,
    payload: null,
    provider_requests: 0,
    generated_at: null,
    fresh_until: null,
    expires_at: null,
    refresh_state: 'idle',
    refresh_lock_token: null,
    refresh_locked_until: null,
    last_refresh_started_at: null,
    last_refresh_finished_at: null,
    last_refresh_error: null
  };
}

function normalizedTtl(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(60 * 1000, Math.min(maximum, Math.round(parsed)));
}

function createHeatmapCacheCoordinator({
  model,
  now = () => new Date(),
  randomToken = () => crypto.randomUUID(),
  scheduleRefresh = null,
  logger = console
} = {}) {
  if (!model) throw new Error('MarketingCompetitionHeatmapCache model is required');

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

  /**
   * Lectura estrictamente pasiva del último valor persistido.
   *
   * A diferencia de resolve(), no crea la fila, no adquiere leases y no
   * programa ningún refresco aunque el valor esté stale o expired. Se usa en
   * resúmenes compactos donde una visita a la pantalla nunca debe consumir
   * proveedor ni generar trabajo en segundo plano.
   */
  async function peek(identity) {
    const row = await find(identity);
    const payload = payloadFromRow(row);
    const status = heatmapCacheStatus(row, now());
    if (!payload) {
      return withHeatmapCacheMetadata({
        success: false,
        cached_only: true,
        cache_miss: true,
        points: []
      }, row, {
        now: now(),
        status: 'miss',
        refreshPending: false,
        refreshAvailable: false,
        algorithmVersion: identity.algorithm_version
      });
    }
    return withHeatmapCacheMetadata({
      ...payload,
      cached_only: true
    }, row, {
      now: now(),
      status,
      refreshPending: false,
      refreshAvailable: false,
      algorithmVersion: identity.algorithm_version
    });
  }

  async function acquire(identity, observedRow = null) {
    const current = observedRow || await ensure(identity);
    const acquiredAt = now();
    const token = randomToken();
    const lockedUntil = new Date(acquiredAt.getTime() + HEATMAP_REFRESH_LEASE_MS);
    const expectedGeneratedAt = validDate(rowValue(current, 'generated_at'));
    const where = {
      cache_key: identity.cache_key,
      generated_at: expectedGeneratedAt || null,
      [Op.or]: [
        { refresh_locked_until: null },
        { refresh_locked_until: { [Op.lte]: acquiredAt } }
      ]
    };
    const [updated] = await model.update({
      refresh_state: 'refreshing',
      refresh_lock_token: token,
      refresh_locked_until: lockedUntil,
      last_refresh_started_at: acquiredAt,
      last_refresh_error: null
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
      last_refresh_error: error ? String(error?.message || error).slice(0, 4000) : null
    }, {
      where: { cache_key: identity.cache_key, refresh_lock_token: token }
    });
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

  async function generateAndPersist(identity, token, generate) {
    try {
      const generated = await generate();
      const providerRequests = Math.max(0, Math.round(Number(generated?.providerRequests) || 0));
      if (generated?.cacheable === false) {
        await release(identity, token);
        return withHeatmapCacheMetadata(generated?.payload, null, {
          status: 'miss',
          providerRequests,
          refreshPending: false,
          algorithmVersion: identity.algorithm_version,
          now: now()
        });
      }

      const generatedAt = now();
      const freshTtlMs = normalizedTtl(
        generated?.freshTtlMs,
        HEATMAP_FRESH_TTL_MS,
        HEATMAP_FRESH_TTL_MS
      );
      const expiresTtlMs = Math.max(freshTtlMs, normalizedTtl(
        generated?.expiresTtlMs,
        HEATMAP_EXPIRES_TTL_MS,
        HEATMAP_EXPIRES_TTL_MS
      ));
      const [updated] = await model.update({
        google_place_id: cleanString(generated?.googlePlaceId) || identity.google_place_id,
        payload: generated?.payload || {},
        provider_requests: providerRequests,
        generated_at: generatedAt,
        fresh_until: new Date(generatedAt.getTime() + freshTtlMs),
        expires_at: new Date(generatedAt.getTime() + expiresTtlMs),
        refresh_state: 'idle',
        refresh_lock_token: null,
        refresh_locked_until: null,
        last_refresh_finished_at: generatedAt,
        last_refresh_error: null
      }, {
        where: { cache_key: identity.cache_key, refresh_lock_token: token }
      });
      const stored = await find(identity);
      if (updated !== 1 || !stored) {
        const error = new Error('Se perdió el lease antes de persistir el heatmap');
        error.code = 'HEATMAP_REFRESH_LEASE_LOST';
        throw error;
      }
      return withHeatmapCacheMetadata(payloadFromRow(stored), stored, { now: generatedAt });
    } catch (error) {
      await release(identity, token, error).catch(() => {});
      throw error;
    }
  }

  async function resolve({ identity, refreshPayload = null }) {
    let row = await find(identity);
    let status = heatmapCacheStatus(row, now());

    if (status === 'fresh') {
      return withHeatmapCacheMetadata(payloadFromRow(row), row, { now: now() });
    }

    if (status === 'stale') {
      const lease = await acquire(identity, row);
      row = lease.row || row;
      status = heatmapCacheStatus(row, now());
      if (status === 'fresh') {
        return withHeatmapCacheMetadata(payloadFromRow(row), row, { now: now() });
      }
      if (lease.acquired) {
        try {
          if (typeof scheduleRefresh !== 'function') {
            throw new Error('No hay un orquestador configurado para refrescar el heatmap');
          }
          await scheduleRefresh({ identity, token: lease.token, payload: refreshPayload });
        } catch (error) {
          await release(identity, lease.token, error).catch(() => {});
          logger?.warn?.('⚠️ No se pudo encolar el refresco persistente del heatmap:', error?.message || error);
          return withHeatmapCacheMetadata(payloadFromRow(row), row, {
            now: now(),
            status,
            refreshPending: false
          });
        }
      }
      return withHeatmapCacheMetadata(payloadFromRow(row), row, {
        now: now(),
        status,
        refreshPending: lease.acquired || refreshInProgress(row, now())
      });
    }

    const lease = await acquire(identity, row);
    row = lease.row || row;
    status = heatmapCacheStatus(row, now());
    if (!lease.acquired) {
      if (status !== 'miss') {
        return withHeatmapCacheMetadata(payloadFromRow(row), row, {
          now: now(),
          status,
          refreshPending: refreshInProgress(row, now())
        });
      }
      return withHeatmapCacheMetadata({
        success: false,
        pending: true,
        message: 'El mapa local se está calculando. Vuelve a consultarlo en unos segundos.',
        points: []
      }, row, { now: now(), status: 'miss', refreshPending: true });
    }

    try {
      if (typeof scheduleRefresh !== 'function') {
        throw new Error('No hay un orquestador configurado para calcular el heatmap');
      }
      await scheduleRefresh({ identity, token: lease.token, payload: refreshPayload });
    } catch (error) {
      await release(identity, lease.token, error).catch(() => {});
      throw error;
    }

    // Un miss/expired puede requerir 25 búsquedas externas. Nunca bloqueamos
    // la petición HTTP con ese trabajo: el JobRequest durable lo calcula y el
    // cliente consulta de nuevo hasta que la fila queda fresh.
    const pendingRow = await find(identity) || row;
    return withHeatmapCacheMetadata({
      success: false,
      pending: true,
      message: 'El mapa local se está calculando. Puedes permanecer en esta pantalla mientras termina.',
      points: []
    }, pendingRow, {
      now: now(),
      status,
      refreshPending: true
    });
  }

  return { resolve, peek, find, ensure, acquire, claimForRefresh, release, generateAndPersist };
}

module.exports = {
  DAY_MS,
  HEATMAP_FRESH_TTL_MS,
  HEATMAP_EXPIRES_TTL_MS,
  HEATMAP_REFRESH_LEASE_MS,
  buildHeatmapCacheIdentity,
  heatmapCacheStatus,
  refreshInProgress,
  withHeatmapCacheMetadata,
  createHeatmapCacheCoordinator,
  __testing: {
    normalizeScope,
    payloadFromRow,
    stableStringify,
    cacheDefaults
  }
};
