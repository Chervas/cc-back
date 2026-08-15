'use strict';

const { ApiUsageCounter } = require('../../models');

const MAX_RECENT_EVENTS = 20;

const PROVIDERS = {
  meta_ads: {
    label: 'Meta Graph / Marketing',
    category: 'ads',
    quotaLabel: 'cabeceras Meta',
  },
  google_ads: {
    label: 'Google Ads',
    category: 'ads',
    quotaLabel: 'cuota diaria',
  },
  openai: {
    label: 'ChatGPT / OpenAI',
    category: 'ai',
    quotaLabel: 'estado IA',
  },
  gemini: {
    label: 'Gemini',
    category: 'ai',
    quotaLabel: 'estado IA',
  },
  whatsapp_cloud: {
    label: 'WhatsApp Cloud API',
    category: 'messaging',
    quotaLabel: 'estado Meta',
  },
};

function dateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function cleanString(value, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function clampPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function normalizeProvider(provider) {
  const normalized = cleanString(provider).toLowerCase();
  if (normalized === 'meta' || normalized === 'facebook' || normalized === 'meta_graph') return 'meta_ads';
  if (normalized === 'google' || normalized === 'googleads') return 'google_ads';
  if (normalized === 'whatsapp' || normalized === 'whatsapp_business') return 'whatsapp_cloud';
  return normalized || 'unknown';
}

function normalizeStatus(status) {
  const normalized = cleanString(status, 'ok').toLowerCase();
  if (['ok', 'success', 'completed', 'ready'].includes(normalized)) return 'ok';
  if (['warning', 'warn'].includes(normalized)) return 'warning';
  if (['rate_limited', 'rate-limit', 'rate_limit'].includes(normalized)) return 'rate_limited';
  if (['quota_limited', 'quota-limit', 'quota_limit', 'quota_exceeded'].includes(normalized)) return 'quota_limited';
  if (['billing_required', 'credentials_invalid', 'not_configured'].includes(normalized)) return normalized;
  if (['failed', 'error'].includes(normalized)) return 'error';
  return normalized;
}

function publicErrorFrom(error) {
  const graphError = error?.response?.data?.error || null;
  const googleError = Array.isArray(error?.response?.data?.error?.details)
    ? error.response.data.error
    : null;
  const code = graphError?.code ?? googleError?.code ?? error?.code ?? error?.response?.status ?? null;
  const subcode = graphError?.error_subcode ?? null;
  const message = graphError?.message
    || googleError?.message
    || error?.response?.data?.error_description
    || error?.message
    || null;
  return {
    code: code == null ? null : String(code),
    subcode: subcode == null ? null : String(subcode),
    message: cleanString(message, 'Error externo').slice(0, 280),
  };
}

function compactEvent(event) {
  return {
    at: event.at,
    source: cleanString(event.source, 'unknown').slice(0, 80),
    operation: cleanString(event.operation, 'request').slice(0, 120),
    status: normalizeStatus(event.status),
    error: event.error || null,
  };
}

function mergeSourceStats(metadata, { source, operation, status, at }) {
  const sources = {
    ...((metadata && typeof metadata === 'object' && metadata.sources && typeof metadata.sources === 'object') ? metadata.sources : {}),
  };
  const sourceKey = cleanString(source, 'unknown').slice(0, 80);
  const current = sources[sourceKey] || {};
  const normalizedStatus = normalizeStatus(status);
  sources[sourceKey] = {
    requestCount: Number(current.requestCount || 0) + 1,
    errorCount: Number(current.errorCount || 0) + (['error', 'rate_limited', 'quota_limited', 'credentials_invalid'].includes(normalizedStatus) ? 1 : 0),
    lastSeenAt: at,
    lastStatus: normalizedStatus,
    lastOperation: cleanString(operation, 'request').slice(0, 120),
  };
  return sources;
}

async function recordApiUsage({
  provider,
  source = 'unknown',
  operation = 'request',
  status = 'ok',
  usagePct = null,
  requestCount = 1,
  pauseUntil = undefined,
  resetAt = undefined,
  quota = undefined,
  error = null,
  metadata = {},
} = {}) {
  try {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider || normalizedProvider === 'unknown') return null;

    const now = new Date();
    const today = dateOnly(now);
    const normalizedStatus = normalizeStatus(status);
    const safeError = error ? publicErrorFrom(error) : null;
    const [counter] = await ApiUsageCounter.findOrCreate({
      where: { provider: normalizedProvider },
      defaults: {
        usageDate: today,
        requestCount: 0,
        usagePct: 0,
        pauseUntil: null,
        metadata: {},
      },
    });

    const previousMetadata = counter.metadata && typeof counter.metadata === 'object'
      ? counter.metadata
      : {};
    const resetDaily = String(counter.usageDate) !== today;
    const baseCount = resetDaily ? 0 : Number(counter.requestCount || 0);
    const requestedIncrement = Math.max(0, Number(requestCount || 0));
    const event = compactEvent({
      at: now.toISOString(),
      source,
      operation,
      status: normalizedStatus,
      error: safeError,
    });
    const recentEvents = [event, ...(Array.isArray(previousMetadata.recentEvents) ? previousMetadata.recentEvents : [])]
      .slice(0, MAX_RECENT_EVENTS);
    const sources = mergeSourceStats(resetDaily ? {} : previousMetadata, {
      source,
      operation,
      status: normalizedStatus,
      at: event.at,
    });

    const nextMetadata = {
      ...previousMetadata,
      ...metadata,
      quota: quota !== undefined ? quota : previousMetadata.quota,
      resetAt: resetAt !== undefined ? resetAt : previousMetadata.resetAt,
      lastEvent: event,
      recentEvents,
      sources,
    };

    const nextUsagePct = clampPct(usagePct);
    const updates = {
      usageDate: today,
      requestCount: baseCount + requestedIncrement,
      metadata: nextMetadata,
    };
    if (nextUsagePct !== null) {
      updates.usagePct = nextUsagePct;
    } else if (resetDaily) {
      updates.usagePct = 0;
    }
    if (pauseUntil !== undefined) {
      updates.pauseUntil = pauseUntil ? new Date(pauseUntil) : null;
    } else if (resetDaily) {
      updates.pauseUntil = null;
    }

    await counter.update(updates);
    return counter.reload();
  } catch (telemetryError) {
    console.warn('⚠️ apiUsageTelemetry record failed:', telemetryError.message);
    return null;
  }
}

function classifyProviderStatus(snapshot) {
  const status = normalizeStatus(snapshot.lastStatus || snapshot.status);
  const usagePct = clampPct(snapshot.usagePct) || 0;
  const waiting = !!snapshot.waiting;
  if (['error', 'quota_limited', 'credentials_invalid', 'billing_required'].includes(status)) {
    return 'error';
  }
  if (status === 'rate_limited' || waiting || usagePct >= 80) {
    return 'warning';
  }
  if (status === 'not_configured') {
    return 'unknown';
  }
  return 'healthy';
}

function statusLabel(status) {
  switch (status) {
    case 'healthy':
      return 'Operativo';
    case 'warning':
      return 'Atención';
    case 'error':
      return 'Bloqueado';
    default:
      return 'Sin datos';
  }
}

function sourceListFromMetadata(metadata) {
  const sources = metadata?.sources && typeof metadata.sources === 'object' ? metadata.sources : {};
  return Object.entries(sources)
    .map(([source, value]) => ({
      source,
      requestCount: Number(value?.requestCount || 0),
      errorCount: Number(value?.errorCount || 0),
      lastSeenAt: value?.lastSeenAt || null,
      lastStatus: value?.lastStatus || null,
      lastOperation: value?.lastOperation || null,
    }))
    .sort((a, b) => {
      const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bTime - aTime;
    });
}

function providerSnapshotFromCounter(counter, overrides = {}) {
  const provider = normalizeProvider(counter?.provider || overrides.provider);
  const metadata = counter?.metadata && typeof counter.metadata === 'object' ? counter.metadata : {};
  const catalog = PROVIDERS[provider] || {
    label: provider,
    category: 'other',
    quotaLabel: 'sin cuota configurada',
  };
  const pauseUntil = overrides.pauseUntil !== undefined
    ? overrides.pauseUntil
    : (counter?.pauseUntil ? new Date(counter.pauseUntil).getTime() : null);
  const now = Date.now();
  const waiting = overrides.waiting !== undefined
    ? !!overrides.waiting
    : !!(pauseUntil && pauseUntil > now);
  const snapshot = {
    provider,
    label: overrides.label || catalog.label,
    category: overrides.category || catalog.category,
    quotaLabel: overrides.quotaLabel || catalog.quotaLabel,
    usagePct: clampPct(overrides.usagePct ?? counter?.usagePct) || 0,
    requestCount: Number(overrides.requestCount ?? counter?.requestCount ?? 0),
    quota: Number(overrides.quota ?? metadata.quota ?? 0),
    resetAt: overrides.resetAt ?? metadata.resetAt ?? null,
    pauseUntil,
    waiting,
    lastUpdatedAt: overrides.lastUpdatedAt || counter?.updated_at || null,
    lastStatus: overrides.lastStatus || metadata.lastEvent?.status || null,
    lastError: overrides.lastError || metadata.lastEvent?.error || null,
    sources: overrides.sources || sourceListFromMetadata(metadata),
    recentEvents: overrides.recentEvents || (Array.isArray(metadata.recentEvents) ? metadata.recentEvents.slice(0, MAX_RECENT_EVENTS) : []),
  };
  const status = classifyProviderStatus(snapshot);
  return {
    ...snapshot,
    status,
    statusLabel: statusLabel(status),
  };
}

function aiProviderSnapshot(provider, aiStatus) {
  const providerStatus = aiStatus?.providers?.[provider] || null;
  const status = providerStatus?.status || (providerStatus?.configured ? 'ready' : 'not_configured');
  const normalized = normalizeStatus(status);
  let usageStatus = 'healthy';
  if (['quota_limited', 'billing_required', 'credentials_invalid', 'error'].includes(normalized)) usageStatus = 'error';
  else if (['rate_limited'].includes(normalized)) usageStatus = 'warning';
  else if (normalized === 'not_configured') usageStatus = 'unknown';
  return {
    provider,
    label: PROVIDERS[provider]?.label || provider,
    category: 'ai',
    quotaLabel: 'estado IA',
    usagePct: 0,
    requestCount: 0,
    quota: 0,
    resetAt: null,
    pauseUntil: null,
    waiting: normalized === 'rate_limited',
    lastUpdatedAt: aiStatus?.checked_at || providerStatus?.last_check?.checked_at || null,
    lastStatus: normalized,
    lastError: ['error', 'quota_limited', 'billing_required', 'credentials_invalid'].includes(normalized)
      ? { code: providerStatus?.last_check?.error_code || normalized, message: providerStatus?.message || 'Revisar proveedor IA' }
      : null,
    sources: [{
      source: 'ai_visibility',
      requestCount: 0,
      errorCount: usageStatus === 'error' ? 1 : 0,
      lastSeenAt: aiStatus?.checked_at || providerStatus?.last_check?.checked_at || null,
      lastStatus: normalized,
      lastOperation: 'provider_health',
    }],
    recentEvents: [],
    status: usageStatus,
    statusLabel: statusLabel(usageStatus),
    message: providerStatus?.message || null,
  };
}

function buildApiUsageOverviewFromInputs({
  counters = [],
  metaUsage = null,
  googleUsage = null,
  aiStatus = null,
  checkedAt = new Date().toISOString(),
} = {}) {
  const counterByProvider = new Map((counters || []).map((counter) => [normalizeProvider(counter.provider), counter]));
  const providers = [];
  const metaCounter = counterByProvider.get('meta_ads');
  providers.push(providerSnapshotFromCounter(metaCounter || { provider: 'meta_ads' }, {
    provider: 'meta_ads',
    usagePct: metaUsage?.usagePct ?? metaCounter?.usagePct,
    waiting: !!metaUsage?.waiting,
    pauseUntil: metaUsage?.nextAllowedAt || metaCounter?.pauseUntil || null,
    lastUpdatedAt: metaCounter?.updated_at || null,
  }));
  const googleCounter = counterByProvider.get('google_ads');
  providers.push(providerSnapshotFromCounter(googleCounter || { provider: 'google_ads' }, {
    provider: 'google_ads',
    usagePct: googleUsage?.usagePct ?? googleCounter?.usagePct,
    requestCount: googleUsage?.requestCount ?? googleCounter?.requestCount,
    quota: googleUsage?.quota ?? googleCounter?.metadata?.quota,
    resetAt: googleUsage?.resetAt ?? googleCounter?.metadata?.resetAt,
    pauseUntil: googleUsage?.pauseUntil || googleCounter?.pauseUntil || null,
    waiting: !!(googleUsage?.pauseUntil && googleUsage.pauseUntil > Date.now()),
    lastUpdatedAt: googleCounter?.updated_at || null,
  }));

  for (const counter of counters || []) {
    const provider = normalizeProvider(counter.provider);
    if (provider === 'meta_ads' || provider === 'google_ads') continue;
    providers.push(providerSnapshotFromCounter(counter));
  }

  providers.push(aiProviderSnapshot('openai', aiStatus));
  providers.push(aiProviderSnapshot('gemini', aiStatus));

  const summaryStatus = providers.some((provider) => provider.status === 'error')
    ? 'error'
    : providers.some((provider) => provider.status === 'warning')
      ? 'warning'
      : providers.some((provider) => provider.status === 'unknown')
        ? 'warning'
        : 'healthy';
  const blockedCount = providers.filter((provider) => provider.status === 'error').length;
  const warningCount = providers.filter((provider) => provider.status === 'warning').length;
  const waitingCount = providers.filter((provider) => provider.waiting).length;
  return {
    success: true,
    checkedAt,
    summary: {
      status: summaryStatus,
      statusLabel: statusLabel(summaryStatus),
      providerCount: providers.length,
      blockedCount,
      warningCount,
      waitingCount,
      lastUpdatedAt: providers
        .map((provider) => provider.lastUpdatedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    },
    providers,
  };
}

async function getApiUsageOverview({ metaUsage = null, googleUsage = null, aiStatus = null } = {}) {
  const counters = await ApiUsageCounter.findAll({ order: [['updated_at', 'DESC']] });
  return buildApiUsageOverviewFromInputs({
    counters,
    metaUsage,
    googleUsage,
    aiStatus,
    checkedAt: new Date().toISOString(),
  });
}

module.exports = {
  recordApiUsage,
  getApiUsageOverview,
  buildApiUsageOverviewFromInputs,
  __testing: {
    normalizeProvider,
    normalizeStatus,
    publicErrorFrom,
    classifyProviderStatus,
    providerSnapshotFromCounter,
    buildApiUsageOverviewFromInputs,
  },
};
