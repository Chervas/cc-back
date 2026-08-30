#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const path = require('path');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const originalConsoleLog = console.log;
if (process.env.OPS_VERBOSE_MODEL_LOAD !== 'true') {
  console.log = () => {};
}
const db = require(path.resolve(process.cwd(), 'models'));
console.log = originalConsoleLog;
db.sequelize.options.logging = false;
const { recordApiUsage } = require('../services/apiUsageTelemetry.service');

const apiUrl = (process.env.OPS_API_URL || 'https://ops.conmigas.com').replace(/\/$/, '');
const apiToken = process.env.OPS_INTERNAL_API_TOKEN;
const metaBaseUrl = (process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0').replace(/\/$/, '');
const lookbackDays = Number(process.env.OPS_GLOBAL_DISCOVERY_LOOKBACK_DAYS || 7);
const requestDelayMs = Number(process.env.OPS_GLOBAL_DISCOVERY_DELAY_MS || 450);
const metaMaxAccounts = Number(process.env.OPS_META_MAX_ACCOUNTS_PER_RUN || 80);
const metaMaxAdsetsPerAccount = Number(process.env.OPS_META_MAX_ADSETS_PER_ACCOUNT || 250);
const metaMaxAdsPerAccount = Number(process.env.OPS_META_MAX_ADS_PER_ACCOUNT || 25);
const metaMaxVideoInsightCalls = Number(process.env.OPS_META_MAX_VIDEO_INSIGHT_CALLS || 80);
const metaRateLimitCooldownMs = Math.max(
  60 * 60 * 1000,
  Number(process.env.OPS_META_RATE_LIMIT_COOLDOWN_MS || process.env.METASYNC_RATE_LIMIT_COOLDOWN_MS || 2 * 60 * 60 * 1000)
);
const metaUsageThreshold = Math.max(
  1,
  Math.min(100, Number(process.env.METASYNC_RATE_LIMIT_THRESHOLD || 90))
);
const googleMaxAccounts = Number(process.env.OPS_GOOGLE_MAX_ACCOUNTS_PER_RUN || 120);
const googleMaxAdGroupsPerAccount = Number(process.env.OPS_GOOGLE_MAX_AD_GROUPS_PER_ACCOUNT || 500);
const googleMaxAssetGroupsPerAccount = Number(process.env.OPS_GOOGLE_MAX_ASSET_GROUPS_PER_ACCOUNT || 300);
const googleMaxAssetGroupAssetsPerAccount = Number(process.env.OPS_GOOGLE_MAX_ASSET_GROUP_ASSETS_PER_ACCOUNT || 300);
const googleMaxVideoAdsPerAccount = Number(process.env.OPS_GOOGLE_MAX_VIDEO_ADS_PER_ACCOUNT || 80);
const opsRequestMaxAttempts = Math.max(1, Number(process.env.OPS_REQUEST_MAX_ATTEMPTS || 3));
const opsRequestRetryDelayMs = Math.max(250, Number(process.env.OPS_REQUEST_RETRY_DELAY_MS || 2000));
const enabledPlatforms = new Set(
  (process.env.OPS_GLOBAL_DISCOVERY_PLATFORMS || 'meta,google_ads')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const googleCustomerIdFilter = new Set(
  (process.env.OPS_GOOGLE_CUSTOMER_IDS || process.env.OPS_GOOGLE_CUSTOMER_ID || '')
    .split(',')
    .map(cleanCustomerId)
    .filter(Boolean)
);
let activeConnectorRunId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function cleanCustomerId(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function normalizeMetaAccountId(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }

  return clean.startsWith('act_') ? clean : `act_${clean.replace(/^act_/, '')}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.max(0, Math.round(toNumber(value)));
}

function statusFromMeta(status) {
  const normalized = String(status || '').toUpperCase();
  if (['ACTIVE', 'ENABLED'].includes(normalized)) {
    return 'active';
  }
  if (['PAUSED', 'DISABLED', 'INACTIVE'].includes(normalized)) {
    return 'paused';
  }
  if (['DELETED', 'ARCHIVED'].includes(normalized)) {
    return 'archived';
  }
  return 'active';
}

function statusFromGoogle(status) {
  const normalized = String(status || '').toUpperCase();
  if (['ENABLED'].includes(normalized)) {
    return 'active';
  }
  if (['PAUSED', 'SUSPENDED'].includes(normalized)) {
    return 'paused';
  }
  if (['REMOVED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(normalized)) {
    return 'archived';
  }
  return 'active';
}

async function query(sql, replacements = {}) {
  return db.sequelize.query(sql, {
    replacements,
    type: db.Sequelize.QueryTypes.SELECT
  });
}

function opsErrorMessage(error) {
  return error.response?.data?.error?.message ||
    error.response?.data?.message ||
    error.message ||
    'Unknown OPS request error';
}

function shouldRetryOpsRequest(error) {
  const status = Number(error.response?.status || 0);

  return !status || status === 429 || status >= 500;
}

function parseUsageHeader(headerValue) {
  try {
    if (!headerValue) {
      return 0;
    }
    const parsed = typeof headerValue === 'string' ? JSON.parse(headerValue) : headerValue;
    if (parsed.call_count != null) {
      return Math.max(
        Number(parsed.call_count) || 0,
        Number(parsed.total_cputime) || 0,
        Number(parsed.total_time) || 0
      );
    }
    const values = Object.values(parsed);
    if (values.length && Array.isArray(values[0])) {
      return values[0].reduce((max, entry) => Math.max(max, Number(entry?.usage) || 0), 0);
    }
  } catch {}
  return 0;
}

function metaGraphError(error) {
  return error?.response?.data?.error || null;
}

function isMetaRateLimitError(error) {
  if (error?.code === 'META_RATE_LIMIT_PAUSED' || error?.code === 'META_RATE_LIMITED') {
    return true;
  }
  const graphError = metaGraphError(error);
  return [4, 17, 613].includes(Number(graphError?.code));
}

function metaPauseUntilFromNow() {
  return new Date(Date.now() + metaRateLimitCooldownMs);
}

function metaPausedError(pauseUntil) {
  const error = new Error(`Meta discovery paused until ${pauseUntil.toISOString()}`);
  error.code = 'META_RATE_LIMIT_PAUSED';
  error.pauseUntil = pauseUntil;
  return error;
}

function metaLimitedError(error, pauseUntil) {
  error.code = 'META_RATE_LIMITED';
  error.pauseUntil = pauseUntil;
  return error;
}

function compactMetaOperation(pathOrUrl) {
  return String(pathOrUrl || 'graph_request')
    .replace(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\//, '')
    .split('?')[0]
    .slice(0, 120);
}

function publicMetaErrorMessage(error) {
  return metaGraphError(error)?.message || error?.message || 'Meta rate limit';
}

async function readMetaUsagePauseUntil() {
  try {
    const counter = db.ApiUsageCounter
      ? await db.ApiUsageCounter.findByPk('meta_ads')
      : null;
    const pauseMs = counter?.pauseUntil ? new Date(counter.pauseUntil).getTime() : 0;
    return pauseMs > Date.now() ? new Date(pauseMs) : null;
  } catch (error) {
    console.warn(`[global-discovery] Meta pause read skipped: ${error.message}`);
    return null;
  }
}

async function recordMetaDiscoveryUsage({
  operation,
  status = 'ok',
  usagePct = null,
  pauseUntil = undefined,
  error = null,
  requestCount = 1
} = {}) {
  await recordApiUsage({
    provider: 'meta_ads',
    source: 'ops_global_discovery',
    operation: compactMetaOperation(operation),
    status,
    usagePct,
    pauseUntil,
    error,
    requestCount,
    metadata: { runner: 'push_ops_global_discovery' }
  });
}

async function requestOps(method, endpoint, payload) {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= opsRequestMaxAttempts; attempt += 1) {
    try {
      const response = await axios({
        method,
        url: `${apiUrl}${endpoint}`,
        data: payload,
        headers: {
          'content-type': 'application/json',
          'x-ops-api-key': apiToken
        },
        timeout: 45000
      });

      return response.data;
    } catch (error) {
      lastError = error;

      if (attempt >= opsRequestMaxAttempts || !shouldRetryOpsRequest(error)) {
        throw error;
      }

      console.warn(
        `[global-discovery] OPS ${method.toUpperCase()} ${endpoint} failed ` +
        `(${opsErrorMessage(error)}), retry ${attempt + 1}/${opsRequestMaxAttempts}`
      );
      await sleep(opsRequestRetryDelayMs * attempt);
    }
  }

  throw lastError;
}

async function postOps(endpoint, payload) {
  return requestOps('post', endpoint, payload);
}

async function patchOps(endpoint, payload) {
  return requestOps('patch', endpoint, payload);
}

async function closeActiveConnectorRunAsFailed(error, context) {
  if (!activeConnectorRunId) {
    return false;
  }

  const runId = activeConnectorRunId;

  try {
    await patchOps(`/api/internal/connector-sync-runs/${runId}`, {
      finished_at: new Date().toISOString(),
      status: 'failed',
      error_message: opsErrorMessage(error),
      raw_payload: {
        context,
        http_status: error.response?.status || null
      }
    });
    activeConnectorRunId = null;
    return true;
  } catch (patchError) {
    console.error(
      `[global-discovery] could not close connector run ${runId}:`,
      opsErrorMessage(patchError)
    );
    return false;
  }
}

async function paginatedMetaGet(pathOrUrl, accessToken, params = {}) {
  const items = [];
  let url = pathOrUrl.startsWith('http') ? pathOrUrl : `${metaBaseUrl}/${pathOrUrl.replace(/^\//, '')}`;
  let page = 0;
  const operation = compactMetaOperation(pathOrUrl);

  while (url && page < 80) {
    page += 1;
    const pauseUntil = await readMetaUsagePauseUntil();
    if (pauseUntil) {
      throw metaPausedError(pauseUntil);
    }
    await sleep(requestDelayMs);

    let response;
    try {
      response = await axios.get(url, {
        params: page === 1 ? { ...params, access_token: accessToken } : { access_token: accessToken },
        timeout: 45000
      });
    } catch (error) {
      if (isMetaRateLimitError(error)) {
        const pauseUntil = metaPauseUntilFromNow();
        await recordMetaDiscoveryUsage({
          operation,
          status: 'rate_limited',
          usagePct: 100,
          pauseUntil,
          error
        });
        throw metaLimitedError(error, pauseUntil);
      }
      throw error;
    }

    const headers = response.headers || {};
    const usagePct = Math.max(
      parseUsageHeader(headers['x-app-usage']),
      parseUsageHeader(headers['x-ad-account-usage']),
      parseUsageHeader(headers['x-page-usage']),
      parseUsageHeader(headers['x-business-use-case-usage'])
    );
    if (usagePct >= metaUsageThreshold) {
      const pauseUntil = metaPauseUntilFromNow();
      await recordMetaDiscoveryUsage({
        operation,
        status: 'rate_limited',
        usagePct,
        pauseUntil
      });
      throw metaPausedError(pauseUntil);
    }
    await recordMetaDiscoveryUsage({
      operation,
      usagePct: usagePct || null
    });

    if (Array.isArray(response.data?.data)) {
      items.push(...response.data.data);
    }

    url = response.data?.paging?.next || null;
  }

  return items;
}

async function getMetaConnections() {
  return query(`
    SELECT id, userName, userEmail, accessToken, expiresAt
    FROM MetaConnections
    WHERE accessToken IS NOT NULL
    ORDER BY updatedAt DESC, id DESC
  `);
}

function metaAdAccountPayload(account) {
  const accountId = normalizeMetaAccountId(account.id || account.account_id);
  const businessName = account.business?.name || account.business_name || null;

  return {
    platform: 'meta',
    external_account_id: accountId,
    name: account.name || accountId,
    account_status: statusFromMeta(account.account_status),
    billing_company: 'unknown',
    sync_interval_hours: 4,
    notes: businessName ? `Business: ${businessName}` : null,
    raw_payload: {
      source: 'ops_global_meta',
      business_name: businessName,
      currency: account.currency || null,
      timezone_name: account.timezone_name || null,
      account_status: account.account_status || null
    }
  };
}

async function discoverMetaAdAccounts(connection) {
  const fields = [
    'id',
    'account_id',
    'name',
    'account_status',
    'currency',
    'timezone_name',
    'business_name',
    'business{id,name}',
    'amount_spent',
    'spend_cap',
    'disable_reason'
  ].join(',');
  const accounts = new Map();

  const meAccounts = await paginatedMetaGet('me/adaccounts', connection.accessToken, {
    fields,
    limit: 200
  });

  for (const account of meAccounts) {
    const id = normalizeMetaAccountId(account.id || account.account_id);
    if (id) {
      accounts.set(id, account);
    }
  }

  if (process.env.META_BUSINESS_ID) {
    for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
      try {
        const businessAccounts = await paginatedMetaGet(`${process.env.META_BUSINESS_ID}/${edge}`, connection.accessToken, {
          fields,
          limit: 200
        });
        for (const account of businessAccounts) {
          const id = normalizeMetaAccountId(account.id || account.account_id);
          if (id) {
            accounts.set(id, account);
          }
        }
      } catch (error) {
        if (isMetaRateLimitError(error)) {
          throw error;
        }
        console.warn(`[global-discovery] Meta ${edge} skipped: ${error.response?.data?.error?.message || error.message}`);
      }
    }
  }

  return Array.from(accounts.values()).slice(0, metaMaxAccounts);
}

async function discoverMetaCampaigns(connection, account) {
  const accountId = normalizeMetaAccountId(account.id || account.account_id);
  const fields = [
    'id',
    'name',
    'status',
    'effective_status',
    'objective',
    'daily_budget',
    'lifetime_budget',
    'created_time',
    'updated_time'
  ].join(',');

  try {
    return await paginatedMetaGet(`${accountId}/campaigns`, connection.accessToken, {
      fields,
      limit: 200
    });
  } catch (error) {
    if (isMetaRateLimitError(error)) {
      throw error;
    }
    console.warn(`[global-discovery] Meta campaigns skipped for ${accountId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

function leadCountFromMetaActions(actions = []) {
  if (!Array.isArray(actions)) {
    return 0;
  }

  return actions.reduce((total, action) => {
    const type = String(action.action_type || '').toLowerCase();
    if (type.includes('lead') || type.includes('contact') || type.includes('complete_registration')) {
      return total + toNumber(action.value);
    }
    return total;
  }, 0);
}

function normalizeRetentionPoint(label, value) {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return {
    label: String(label),
    value: numeric <= 1 ? Number((numeric * 100).toFixed(2)) : Number(numeric.toFixed(2))
  };
}

function retentionPointsFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .map(([label, pointValue]) => normalizeRetentionPoint(label, pointValue))
    .filter(Boolean)
    .sort((a, b) => {
      const aNumber = Number(String(a.label).replace(/[^0-9.]/g, ''));
      const bNumber = Number(String(b.label).replace(/[^0-9.]/g, ''));
      return Number.isFinite(aNumber) && Number.isFinite(bNumber)
        ? aNumber - bNumber
        : String(a.label).localeCompare(String(b.label));
    });
}

function extractMetaCreativeVideoId(creative = {}) {
  const candidates = [
    creative.video_id,
    creative.videoId,
    creative.object_story_spec?.video_data?.video_id,
    creative.objectStorySpec?.videoData?.videoId,
    creative.asset_feed_spec?.videos?.[0]?.video_id,
    creative.assetFeedSpec?.videos?.[0]?.videoId
  ];

  return candidates.find(Boolean) || null;
}

function extractMetaCreativeBody(creative = {}) {
  return creative.body
    || creative.object_story_spec?.video_data?.message
    || creative.object_story_spec?.link_data?.message
    || creative.asset_feed_spec?.bodies?.[0]?.text
    || null;
}

function extractMetaCreativeTitle(creative = {}) {
  return creative.title
    || creative.name
    || creative.object_story_spec?.video_data?.title
    || creative.object_story_spec?.link_data?.name
    || creative.asset_feed_spec?.titles?.[0]?.text
    || null;
}

function extractMetaCreativeDestination(creative = {}) {
  return creative.object_url
    || creative.object_story_spec?.link_data?.link
    || creative.object_story_spec?.video_data?.call_to_action?.value?.link
    || creative.asset_feed_spec?.link_urls?.[0]?.website_url
    || null;
}

function parseMetaVideoInsights(rows = []) {
  const result = {
    video_views: null,
    video_avg_watch_time_seconds: null,
    video_retention_granularity: null,
    video_retention_points: null,
    raw: rows
  };

  for (const row of rows) {
    const name = String(row.name || '').toLowerCase();
    const value = Array.isArray(row.values) ? row.values[0]?.value : row.value;

    if (!name) {
      continue;
    }

    if (name.includes('retention') && value && typeof value === 'object') {
      const points = retentionPointsFromObject(value);
      if (points.length) {
        result.video_retention_granularity = 'second';
        result.video_retention_points = points.slice(0, 180);
      }
    }

    if (name.includes('avg') && name.includes('time')) {
      result.video_avg_watch_time_seconds = toNumber(value);
    }

    if (name.endsWith('video_views') || name === 'total_video_views') {
      result.video_views = toInteger(value);
    }
  }

  return result;
}

const unsupportedMetaVideoInsightEdges = new Set();

async function discoverMetaVideoInsights(connection, videoId) {
  if (!videoId) {
    return null;
  }

  const metricGroups = [
    'total_video_retention_graph,total_video_avg_time_watched,total_video_views',
    'post_video_retention_graph,post_video_avg_time_watched,post_video_views'
  ];

  for (const edgeName of ['video_insights', 'insights']) {
    if (unsupportedMetaVideoInsightEdges.has(edgeName)) {
      continue;
    }
    const edge = `${videoId}/${edgeName}`;
    for (const metric of metricGroups) {
      try {
        const rows = await paginatedMetaGet(edge, connection.accessToken, {
          metric,
          period: 'lifetime',
          limit: 200
        });
        const parsed = parseMetaVideoInsights(rows);
        if (parsed.video_retention_points?.length || parsed.video_avg_watch_time_seconds || parsed.video_views) {
          return parsed;
        }
      } catch (error) {
        if (isMetaRateLimitError(error)) {
          throw error;
        }
        const message = error.response?.data?.error?.message || error.message;
        const graphCode = Number(error.response?.data?.error?.code);
        if (graphCode === 100 && /nonexisting field/i.test(message)) {
          unsupportedMetaVideoInsightEdges.add(edgeName);
          break;
        }
        console.warn(`[global-discovery] Meta video insights skipped for ${videoId}: ${message}`);
      }
    }
  }

  return null;
}

async function discoverMetaAdStructure(connection, account) {
  const accountId = normalizeMetaAccountId(account.id || account.account_id);
  const fields = [
    'id',
    'name',
    'status',
    'effective_status',
    'campaign_id',
    'adset_id',
    'creative{id,name,title,body,thumbnail_url,image_url,video_id,object_url,object_story_spec,asset_feed_spec,call_to_action_type}'
  ].join(',');

  try {
    const ads = await paginatedMetaGet(`${accountId}/ads`, connection.accessToken, {
      fields,
      effective_status: ['ACTIVE'],
      limit: 200
    });
    return ads.slice(0, metaMaxAdsPerAccount);
  } catch (error) {
    if (isMetaRateLimitError(error)) {
      throw error;
    }
    console.warn(`[global-discovery] Meta ads skipped for ${accountId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function discoverMetaAdsets(connection, account) {
  const accountId = normalizeMetaAccountId(account.id || account.account_id);
  const fields = [
    'id',
    'name',
    'status',
    'effective_status',
    'campaign_id'
  ].join(',');

  try {
    const adsets = await paginatedMetaGet(`${accountId}/adsets`, connection.accessToken, {
      fields,
      effective_status: ['ACTIVE', 'PAUSED'],
      limit: 200
    });
    return adsets.slice(0, metaMaxAdsetsPerAccount);
  } catch (error) {
    if (isMetaRateLimitError(error)) {
      throw error;
    }
    console.warn(`[global-discovery] Meta adsets skipped for ${accountId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function discoverMetaInsights(connection, account) {
  const accountId = normalizeMetaAccountId(account.id || account.account_id);
  const since = daysAgoIso(lookbackDays);
  const until = todayIso();

  try {
    return await paginatedMetaGet(`${accountId}/insights`, connection.accessToken, {
      level: 'campaign',
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,date_start,date_stop',
      time_increment: 1,
      time_range: JSON.stringify({ since, until }),
      limit: 200
    });
  } catch (error) {
    if (isMetaRateLimitError(error)) {
      throw error;
    }
    console.warn(`[global-discovery] Meta insights skipped for ${accountId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function syncMetaGlobal() {
  const initialPauseUntil = await readMetaUsagePauseUntil();
  if (initialPauseUntil) {
    console.warn(`[global-discovery] Meta discovery deferred until ${initialPauseUntil.toISOString()}`);
    return {
      accountsCount: 0,
      campaignsCount: 0,
      statsCount: 0,
      profilesCount: 0,
      structureCount: 0,
      deferred: true,
      rateLimited: true,
      pauseUntil: initialPauseUntil.toISOString()
    };
  }

  const connections = await getMetaConnections();
  let accountsCount = 0;
  let campaignsCount = 0;
  let statsCount = 0;
  let profilesCount = 0;
  let structureCount = 0;
  let videoInsightCalls = 0;

  try {
    for (const connection of connections) {
      const accounts = await discoverMetaAdAccounts(connection);
      accountsCount += accounts.length;

      if (accounts.length) {
        await postOps('/api/internal/ad-account-discovery', {
          platform: 'meta',
          business_unit: 'unknown',
          sync_interval_hours: 4,
          accounts: accounts.map(metaAdAccountPayload)
        });
      }

      try {
        const pages = await paginatedMetaGet('me/accounts', connection.accessToken, {
          fields: 'id,name,category,followers_count,picture.width(128).height(128){url},instagram_business_account{id,name,username,profile_picture_url,followers_count,media_count}',
          limit: 200
        });
        for (const page of pages) {
          profilesCount += 1;
          await postOps('/api/internal/social-profiles', {
            platform: 'facebook',
            external_profile_id: page.id,
            name: page.name || page.id,
            avatar_url: page.picture?.data?.url || page.picture?.url || null,
            business_unit: 'unknown',
            status: 'active',
            last_sync_status: 'ok',
            raw_payload: {
              source: 'ops_global_meta',
              category: page.category || null,
              followers_count: page.followers_count || null
            }
          });

          if (page.instagram_business_account?.id) {
            profilesCount += 1;
            await postOps('/api/internal/social-profiles', {
              platform: 'instagram',
              external_profile_id: page.instagram_business_account.id,
              name: page.instagram_business_account.name || page.instagram_business_account.username || page.instagram_business_account.id,
              handle: page.instagram_business_account.username || null,
              avatar_url: page.instagram_business_account.profile_picture_url || null,
              business_unit: 'unknown',
              status: 'active',
              last_sync_status: 'ok',
              raw_payload: {
                source: 'ops_global_meta',
                facebook_page_id: page.id,
                followers_count: page.instagram_business_account.followers_count || null,
                media_count: page.instagram_business_account.media_count || null
              }
            });
          }
        }
      } catch (error) {
        if (isMetaRateLimitError(error)) {
          throw error;
        }
        console.warn(`[global-discovery] Meta pages skipped: ${error.response?.data?.error?.message || error.message}`);
      }

      for (const account of accounts) {
        const accountId = normalizeMetaAccountId(account.id || account.account_id);
        const accountPayload = metaAdAccountPayload(account);
        const campaigns = await discoverMetaCampaigns(connection, account);
        campaignsCount += campaigns.length;

        if (campaigns.length) {
          await postOps('/api/internal/campaign-discovery', {
            platform: 'meta',
            business_unit: 'unknown',
            ad_account: accountPayload,
            campaigns: campaigns.map((campaign) => ({
              platform_campaign_id: `${accountId}:${campaign.id}`,
              external_campaign_id: `${accountId}:${campaign.id}`,
              name: campaign.name || campaign.id,
              status: statusFromMeta(campaign.effective_status || campaign.status),
              objective: campaign.objective || null,
              daily_budget: campaign.daily_budget ? toNumber(campaign.daily_budget) / 100 : null,
              currency: account.currency || 'EUR'
            }))
          });
        }

        const insights = await discoverMetaInsights(connection, account);
        for (const insight of insights) {
          statsCount += 1;
          await postOps('/api/internal/campaign-daily-stats', {
            campaign: {
              ad_account: accountPayload,
              platform_campaign_id: `${accountId}:${insight.campaign_id}`,
              name: insight.campaign_name || insight.campaign_id,
              channel: 'meta',
              campaign_status: 'active',
              currency: account.currency || 'EUR'
            },
            stat_date: insight.date_start,
            spend: toNumber(insight.spend),
            impressions: toInteger(insight.impressions),
            clicks: toInteger(insight.clicks),
            leads: toInteger(leadCountFromMetaActions(insight.actions)),
            currency: account.currency || 'EUR',
            source_platform: 'ops_global_meta',
            raw_payload: {
              account_id: accountId,
              campaign_id: insight.campaign_id
            }
          });
        }

        const adsets = await discoverMetaAdsets(connection, account);
        for (const adset of adsets) {
          structureCount += 1;
          await postOps('/api/internal/campaign-structure-items', {
            platform: 'meta',
            item_type: 'adset',
            external_item_id: adset.id,
            platform_campaign_id: `${accountId}:${adset.campaign_id}`,
            ad_account: accountPayload,
            name: adset.name || adset.id,
            status: statusFromMeta(adset.status),
            effective_status: statusFromMeta(adset.effective_status || adset.status),
            raw_payload: {
              account_id: accountId,
              campaign_id: adset.campaign_id,
              adset_id: adset.id
            }
          });
        }

        const ads = await discoverMetaAdStructure(connection, account);
        for (const ad of ads) {
          const creative = ad.creative || {};
          const videoId = extractMetaCreativeVideoId(creative);
          let videoInsights = null;
          if (videoId && videoInsightCalls < metaMaxVideoInsightCalls) {
            videoInsightCalls += 1;
            videoInsights = await discoverMetaVideoInsights(connection, videoId);
          }
          structureCount += 1;

          await postOps('/api/internal/campaign-structure-items', {
            platform: 'meta',
            item_type: 'ad',
            external_item_id: ad.id,
            parent_external_id: ad.adset_id || null,
            platform_campaign_id: `${accountId}:${ad.campaign_id}`,
            ad_account: accountPayload,
            name: ad.name || creative.name || ad.id,
            status: statusFromMeta(ad.status),
            effective_status: statusFromMeta(ad.effective_status || ad.status),
            preview_title: extractMetaCreativeTitle(creative),
            preview_body: extractMetaCreativeBody(creative),
            thumbnail_url: creative.thumbnail_url || creative.image_url || null,
            media_url: creative.image_url || creative.thumbnail_url || null,
            destination_url: extractMetaCreativeDestination(creative),
            cta_type: creative.call_to_action_type || null,
            video_views: videoInsights?.video_views || null,
            video_avg_watch_time_seconds: videoInsights?.video_avg_watch_time_seconds || null,
            video_retention_granularity: videoInsights?.video_retention_granularity || null,
            video_retention_points: videoInsights?.video_retention_points || null,
            source_platform: 'ops_global_meta',
            raw_payload: {
              source: 'ops_global_meta',
              account_id: accountId,
              campaign_id: ad.campaign_id || null,
              adset_id: ad.adset_id || null,
              creative_id: creative.id || null,
              video_id: videoId,
              video_insights: videoInsights?.raw || null
            }
          });
        }
      }
    }
  } catch (error) {
    if (!isMetaRateLimitError(error)) {
      throw error;
    }
    const pauseUntil = error.pauseUntil || await readMetaUsagePauseUntil() || metaPauseUntilFromNow();
    console.warn(`[global-discovery] Meta discovery stopped by rate-limit until ${pauseUntil.toISOString()}: ${publicMetaErrorMessage(error)}`);
    return {
      accountsCount,
      campaignsCount,
      statsCount,
      profilesCount,
      structureCount,
      deferred: true,
      rateLimited: true,
      pauseUntil: pauseUntil.toISOString()
    };
  }

  return { accountsCount, campaignsCount, statsCount, profilesCount, structureCount };
}

async function getGoogleConnections() {
  return query(`
    SELECT id, userName, userEmail, accessToken, refreshToken, expiresAt
    FROM GoogleConnections
    WHERE accessToken IS NOT NULL
    ORDER BY updated_at DESC, id DESC
  `);
}

async function refreshGoogleConnection(connection) {
  const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0;
  const shouldRefresh = connection.refreshToken && (!expiresAt || expiresAt < Date.now() + 120000);

  if (!shouldRefresh) {
    return connection.accessToken;
  }

  const response = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: connection.refreshToken
  }).toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    timeout: 30000
  });

  const accessToken = response.data.access_token;
  const expiresIn = Number(response.data.expires_in || 3600);
  const expiresAtDate = new Date(Date.now() + expiresIn * 1000);

  await db.sequelize.query(
    'UPDATE GoogleConnections SET accessToken = :accessToken, expiresAt = :expiresAt, updated_at = NOW() WHERE id = :id',
    {
      replacements: {
        accessToken,
        expiresAt: expiresAtDate,
        id: connection.id
      }
    }
  );

  return accessToken;
}

function googleAdsBaseUrls() {
  const endpoint = (process.env.GOOGLE_ADS_API_ENDPOINT || 'https://googleads.googleapis.com').replace(/\/$/, '');
  const version = (process.env.GOOGLE_ADS_API_VERSION || 'v21').replace(/^\//, '');
  const fallbacks = (process.env.GOOGLE_ADS_API_VERSION_FALLBACKS || '')
    .split(',')
    .map((item) => item.trim().replace(/^\//, ''))
    .filter(Boolean);
  const configured = process.env.GOOGLE_ADS_API_BASE_URL
    ? [process.env.GOOGLE_ADS_API_BASE_URL.replace(/\/$/, '')]
    : [];
  const urls = [...configured];

  for (const item of [version, ...fallbacks]) {
    urls.push(`${endpoint}/googleads/${item}`);
    urls.push(`${endpoint}/${item}`);
  }

  return [...new Set(urls)];
}

async function googleAdsSearch(customerId, accessToken, query, { loginCustomerId } = {}) {
  const cleanId = cleanCustomerId(customerId);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'content-type': 'application/json',
    accept: 'application/json'
  };

  if (loginCustomerId) {
    headers['login-customer-id'] = cleanCustomerId(loginCustomerId);
  }

  const items = [];
  let pageToken = null;

  do {
    await sleep(requestDelayMs);
    let response = null;
    let lastError = null;

    for (const baseUrl of googleAdsBaseUrls()) {
      try {
        response = await axios.post(`${baseUrl}/customers/${cleanId}/googleAds:search`, {
          query,
          pageToken: pageToken || undefined
        }, {
          headers,
          timeout: 45000
        });
        break;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        if (![404, 405].includes(status)) {
          throw error;
        }
      }
    }

    if (!response) {
      throw lastError || new Error('Google Ads API search failed');
    }

    if (Array.isArray(response.data?.results)) {
      items.push(...response.data.results);
    }

    pageToken = response.data?.nextPageToken || response.data?.next_page_token || null;
  } while (pageToken);

  return items;
}

async function googleAdsSearchWithFallback(customerId, accessToken, query, account = {}) {
  const preferredLoginCustomerId = account.loginCustomerId || null;

  try {
    return await googleAdsSearch(customerId, accessToken, query, {
      loginCustomerId: preferredLoginCustomerId
    });
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.error?.message || error.message || '';

    if (preferredLoginCustomerId && (status === 403 || /permission/i.test(message))) {
      return googleAdsSearch(customerId, accessToken, query, {});
    }

    throw error;
  }
}

async function googleListAccessibleCustomers(accessToken) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    accept: 'application/json'
  };

  try {
    let response = null;
    let lastError = null;

    for (const baseUrl of googleAdsBaseUrls()) {
      try {
        response = await axios.get(`${baseUrl}/customers:listAccessibleCustomers`, {
          headers,
          timeout: 30000
        });
        break;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        if (![404, 405].includes(status)) {
          throw error;
        }
      }
    }

    if (!response) {
      throw lastError || new Error('Google Ads API listAccessibleCustomers failed');
    }

    return (response.data?.resourceNames || [])
      .map((resourceName) => cleanCustomerId(String(resourceName).split('/').pop()))
      .filter(Boolean);
  } catch (error) {
    console.warn(`[global-discovery] Google accessible customers skipped: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

function googleAccountPayload(row) {
  return {
    platform: 'google_ads',
    external_account_id: row.customerId,
    name: row.descriptiveName || row.customerId,
    account_status: statusFromGoogle(row.status),
    billing_company: 'unknown',
    sync_interval_hours: 4,
    notes: row.isManager ? 'Google Ads manager account' : null,
    raw_payload: {
      source: 'ops_global_google_ads',
      currency: row.currencyCode || null,
      time_zone: row.timeZone || null,
      level: row.level || null,
      manager: row.isManager || false
    }
  };
}

async function discoverGoogleAccounts(accessToken) {
  const managerId = cleanCustomerId(process.env.GOOGLE_ADS_MANAGER_ID);
  const accounts = new Map();

  for (const customerId of await googleListAccessibleCustomers(accessToken)) {
      accounts.set(customerId, {
        customerId,
        descriptiveName: customerId,
        status: 'ENABLED',
        isManager: false,
        loginCustomerId: null
      });
  }

  if (managerId) {
    const rows = await googleAdsSearch(managerId, accessToken, [
      'SELECT',
      '  customer_client.client_customer,',
      '  customer_client.descriptive_name,',
      '  customer_client.currency_code,',
      '  customer_client.time_zone,',
      '  customer_client.status,',
      '  customer_client.level,',
      '  customer_client.manager,',
      '  customer_client.hidden',
      'FROM customer_client',
      'WHERE customer_client.hidden = FALSE'
    ].join('\n'), { loginCustomerId: managerId });

    for (const row of rows) {
      const client = row.customerClient || row.customer_client;
      const resourceName = client?.clientCustomer || client?.client_customer;
      const customerId = cleanCustomerId(String(resourceName || '').split('/').pop());
      if (!customerId) {
        continue;
      }

      accounts.set(customerId, {
        customerId,
        descriptiveName: client.descriptiveName || client.descriptive_name || customerId,
        currencyCode: client.currencyCode || client.currency_code || null,
        timeZone: client.timeZone || client.time_zone || null,
        status: client.status || null,
        level: client.level || 0,
        isManager: Boolean(client.manager),
        hidden: Boolean(client.hidden),
        loginCustomerId: managerId
      });
    }
  }

  return Array.from(accounts.values())
    .filter((account) => !googleCustomerIdFilter.size || googleCustomerIdFilter.has(cleanCustomerId(account.customerId)))
    .slice(0, googleMaxAccounts);
}

async function discoverGoogleCampaigns(accessToken, account, managerId) {
  try {
    const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, [
      'SELECT',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  campaign.serving_status,',
      '  campaign.primary_status,',
      '  campaign.advertising_channel_type,',
      '  campaign_budget.amount_micros',
      'FROM campaign',
      "WHERE campaign.status IN ('ENABLED','PAUSED')"
    ].join('\n'), account);

    return rows.map((row) => {
      const campaign = row.campaign || {};
      const budget = row.campaignBudget || row.campaign_budget || {};
      return {
        id: String(campaign.id),
        name: campaign.name || String(campaign.id),
        status: campaign.status || null,
        servingStatus: campaign.servingStatus || campaign.serving_status || null,
        primaryStatus: campaign.primaryStatus || campaign.primary_status || null,
        channelType: campaign.advertisingChannelType || campaign.advertising_channel_type || null,
        dailyBudget: budget.amountMicros || budget.amount_micros ? toNumber(budget.amountMicros || budget.amount_micros) / 1000000 : null
      };
    }).filter((campaign) => campaign.id && campaign.id !== 'undefined');
  } catch (error) {
    console.warn(`[global-discovery] Google campaigns skipped for ${account.customerId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function discoverGoogleAdGroups(accessToken, account, managerId) {
  try {
    const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, [
      'SELECT',
      '  campaign.id,',
      '  campaign.name,',
      '  ad_group.id,',
      '  ad_group.name,',
      '  ad_group.status',
      'FROM ad_group',
      "WHERE campaign.status IN ('ENABLED','PAUSED')",
      "  AND ad_group.status IN ('ENABLED','PAUSED')"
    ].join('\n'), account);

    return rows.slice(0, googleMaxAdGroupsPerAccount).map((row) => {
      const campaign = row.campaign || {};
      const adGroup = row.adGroup || row.ad_group || {};
      return {
        campaignId: String(campaign.id || ''),
        campaignName: campaign.name || null,
        adGroupId: String(adGroup.id || ''),
        adGroupName: adGroup.name || String(adGroup.id || ''),
        status: adGroup.status || null
      };
    }).filter((row) => row.campaignId && row.adGroupId);
  } catch (error) {
    console.warn(`[global-discovery] Google ad groups skipped for ${account.customerId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function discoverGoogleAssetGroups(accessToken, account) {
  const queryWithUrls = [
    'SELECT',
    '  campaign.id,',
    '  campaign.name,',
    '  asset_group.id,',
    '  asset_group.name,',
    '  asset_group.status,',
    '  asset_group.final_urls',
    'FROM asset_group',
    "WHERE campaign.status IN ('ENABLED','PAUSED')",
    "  AND asset_group.status IN ('ENABLED','PAUSED')"
  ].join('\n');

  const queryMinimal = [
    'SELECT',
    '  campaign.id,',
    '  campaign.name,',
    '  asset_group.id,',
    '  asset_group.name,',
    '  asset_group.status',
    'FROM asset_group',
    "WHERE campaign.status IN ('ENABLED','PAUSED')",
    "  AND asset_group.status IN ('ENABLED','PAUSED')"
  ].join('\n');

  for (const queryText of [queryWithUrls, queryMinimal]) {
    try {
      const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, queryText, account);
      return rows.slice(0, googleMaxAssetGroupsPerAccount).map((row) => {
        const campaign = row.campaign || {};
        const assetGroup = row.assetGroup || row.asset_group || {};
        const finalUrls = assetGroup.finalUrls || assetGroup.final_urls || [];

        return {
          campaignId: String(campaign.id || ''),
          campaignName: campaign.name || null,
          assetGroupId: String(assetGroup.id || ''),
          assetGroupName: assetGroup.name || String(assetGroup.id || ''),
          status: assetGroup.status || null,
          destinationUrl: Array.isArray(finalUrls) ? finalUrls[0] : finalUrls
        };
      }).filter((row) => row.campaignId && row.assetGroupId);
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      if (queryText === queryMinimal) {
        console.warn(`[global-discovery] Google asset groups skipped for ${account.customerId}: ${message}`);
      }
    }
  }

  return [];
}

async function discoverGoogleAssetGroupAssets(accessToken, account) {
  const baseSelect = [
    'campaign.id',
    'campaign.name',
    'asset_group.id',
    'asset_group.name',
    'asset_group_asset.asset',
    'asset_group_asset.field_type',
    'asset_group_asset.status',
    'asset.id',
    'asset.name',
    'asset.type'
  ];
  const richSelect = [
    ...baseSelect,
    'asset.text_asset.text',
    'asset.youtube_video_asset.youtube_video_id',
    'asset.youtube_video_asset.youtube_video_title',
    'asset.image_asset.full_size.url'
  ];
  const mediumSelect = [
    ...baseSelect,
    'asset.text_asset.text',
    'asset.youtube_video_asset.youtube_video_id',
    'asset.youtube_video_asset.youtube_video_title'
  ];

  const buildQuery = (selectFields) => [
    'SELECT',
    selectFields.map((field, index) => `  ${field}${index < selectFields.length - 1 ? ',' : ''}`).join('\n'),
    'FROM asset_group_asset',
    "WHERE campaign.status IN ('ENABLED','PAUSED')",
    "  AND asset_group.status IN ('ENABLED','PAUSED')",
    "  AND asset_group_asset.status IN ('ENABLED','PAUSED')"
  ].join('\n');

  for (const queryText of [buildQuery(richSelect), buildQuery(mediumSelect), buildQuery(baseSelect)]) {
    try {
      const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, queryText, account);
      return rows.slice(0, googleMaxAssetGroupAssetsPerAccount).map((row) => {
        const campaign = row.campaign || {};
        const assetGroup = row.assetGroup || row.asset_group || {};
        const assetGroupAsset = row.assetGroupAsset || row.asset_group_asset || {};
        const asset = row.asset || {};
        const textAsset = asset.textAsset || asset.text_asset || {};
        const videoAsset = asset.youtubeVideoAsset || asset.youtube_video_asset || {};
        const imageAsset = asset.imageAsset || asset.image_asset || {};
        const imageFullSize = imageAsset.fullSize || imageAsset.full_size || {};
        const assetResource = assetGroupAsset.asset || asset.resourceName || asset.resource_name || '';
        const assetId = String(asset.id || String(assetResource).split('/').pop() || '');
        const fieldType = assetGroupAsset.fieldType || assetGroupAsset.field_type || null;
        const assetType = asset.type || null;
        const title = videoAsset.youtubeVideoTitle || videoAsset.youtube_video_title || asset.name || fieldType || assetId;
        const body = textAsset.text || assetType || null;
        const youtubeId = videoAsset.youtubeVideoId || videoAsset.youtube_video_id || null;

        return {
          campaignId: String(campaign.id || ''),
          campaignName: campaign.name || null,
          assetGroupId: String(assetGroup.id || ''),
          assetGroupName: assetGroup.name || null,
          assetId,
          assetResource,
          fieldType,
          assetType,
          status: assetGroupAsset.status || null,
          name: asset.name || title || assetId,
          previewTitle: title || null,
          previewBody: body,
          thumbnailUrl: imageFullSize.url || null,
          destinationUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null,
          youtubeId
        };
      }).filter((row) => row.campaignId && row.assetGroupId && (row.assetId || row.assetResource));
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      if (queryText === buildQuery(baseSelect)) {
        console.warn(`[global-discovery] Google asset group assets skipped for ${account.customerId}: ${message}`);
      }
    }
  }

  return [];
}

async function discoverGoogleStats(accessToken, account, managerId) {
  const since = daysAgoIso(lookbackDays);
  const until = todayIso();

  try {
    const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, [
      'SELECT',
      '  segments.date,',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  metrics.cost_micros,',
      '  metrics.impressions,',
      '  metrics.clicks,',
      '  metrics.conversions',
      'FROM campaign',
      `WHERE segments.date BETWEEN '${since}' AND '${until}'`
    ].join('\n'), account);

    return rows.map((row) => ({
      statDate: row.segments?.date,
      campaignId: String(row.campaign?.id || ''),
      campaignName: row.campaign?.name || null,
      campaignStatus: row.campaign?.status || null,
      spend: toNumber(row.metrics?.costMicros || row.metrics?.cost_micros) / 1000000,
      impressions: toInteger(row.metrics?.impressions),
      clicks: toInteger(row.metrics?.clicks),
      leads: toInteger(row.metrics?.conversions)
    })).filter((row) => row.statDate && row.campaignId);
  } catch (error) {
    console.warn(`[global-discovery] Google stats skipped for ${account.customerId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function discoverGoogleVideoAdMetrics(accessToken, account) {
  const since = daysAgoIso(lookbackDays);
  const until = todayIso();

  try {
    const rows = await googleAdsSearchWithFallback(account.customerId, accessToken, [
      'SELECT',
      '  segments.date,',
      '  campaign.id,',
      '  campaign.name,',
      '  ad_group.id,',
      '  ad_group.name,',
      '  ad_group_ad.ad.id,',
      '  ad_group_ad.ad.name,',
      '  ad_group_ad.ad.type,',
      '  ad_group_ad.ad.final_urls,',
      '  ad_group_ad.status,',
      '  metrics.video_views,',
      '  metrics.video_quartile_p25_rate,',
      '  metrics.video_quartile_p50_rate,',
      '  metrics.video_quartile_p75_rate,',
      '  metrics.video_quartile_p100_rate,',
      '  metrics.video_view_rate,',
      '  metrics.average_cpv',
      'FROM ad_group_ad',
      `WHERE segments.date BETWEEN '${since}' AND '${until}'`,
      "  AND ad_group_ad.status IN ('ENABLED','PAUSED')"
    ].join('\n'), account);

    return rows.slice(0, googleMaxVideoAdsPerAccount).map((row) => {
      const metrics = row.metrics || {};
      const ad = row.adGroupAd?.ad || row.ad_group_ad?.ad || {};
      const adGroupAd = row.adGroupAd || row.ad_group_ad || {};
      const adGroup = row.adGroup || row.ad_group || {};
      const campaign = row.campaign || {};
      const finalUrls = ad.finalUrls || ad.final_urls || [];

      return {
        statDate: row.segments?.date,
        campaignId: String(campaign.id || ''),
        campaignName: campaign.name || null,
        adGroupId: String(adGroup.id || ''),
        adGroupName: adGroup.name || null,
        adId: String(ad.id || ''),
        adName: ad.name || String(ad.id || ''),
        adType: ad.type || null,
        status: adGroupAd.status || null,
        destinationUrl: Array.isArray(finalUrls) ? finalUrls[0] : finalUrls,
        videoViews: toInteger(metrics.videoViews || metrics.video_views),
        quartiles: {
          p25: toNumber(metrics.videoQuartileP25Rate || metrics.video_quartile_p25_rate),
          p50: toNumber(metrics.videoQuartileP50Rate || metrics.video_quartile_p50_rate),
          p75: toNumber(metrics.videoQuartileP75Rate || metrics.video_quartile_p75_rate),
          p100: toNumber(metrics.videoQuartileP100Rate || metrics.video_quartile_p100_rate)
        },
        videoViewRate: toNumber(metrics.videoViewRate || metrics.video_view_rate),
        averageCpvMicros: toNumber(metrics.averageCpv || metrics.average_cpv)
      };
    }).filter((row) => row.campaignId && row.adId && Object.values(row.quartiles).some((value) => value > 0));
  } catch (error) {
    console.warn(`[global-discovery] Google video ad metrics skipped for ${account.customerId}: ${error.response?.data?.error?.message || error.message}`);
    return [];
  }
}

async function syncGoogleGlobal() {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn('[global-discovery] Google Ads config missing');
    return { accountsCount: 0, campaignsCount: 0, statsCount: 0, structureCount: 0 };
  }

  const connections = await getGoogleConnections();
  const managerId = cleanCustomerId(process.env.GOOGLE_ADS_MANAGER_ID);
  let accountsCount = 0;
  let campaignsCount = 0;
  let statsCount = 0;
  let structureCount = 0;

  for (const connection of connections) {
    const accessToken = await refreshGoogleConnection(connection);
    const accounts = await discoverGoogleAccounts(accessToken);
    accountsCount += accounts.length;

    if (accounts.length) {
      await postOps('/api/internal/ad-account-discovery', {
        platform: 'google_ads',
        business_unit: 'unknown',
        sync_interval_hours: 4,
        accounts: accounts.map(googleAccountPayload)
      });
    }

    for (const account of accounts.filter((item) => !item.isManager)) {
      const accountPayload = googleAccountPayload(account);
      const campaigns = await discoverGoogleCampaigns(accessToken, account, managerId);
      campaignsCount += campaigns.length;

      if (campaigns.length) {
        await postOps('/api/internal/campaign-discovery', {
          platform: 'google_ads',
          business_unit: 'unknown',
          ad_account: accountPayload,
          campaigns: campaigns.map((campaign) => ({
            platform_campaign_id: `${account.customerId}:${campaign.id}`,
            external_campaign_id: `${account.customerId}:${campaign.id}`,
            name: campaign.name,
            status: statusFromGoogle(campaign.status),
            objective: campaign.channelType || campaign.servingStatus || null,
            daily_budget: campaign.dailyBudget,
            currency: account.currencyCode || 'EUR'
          }))
        });
      }

      const stats = await discoverGoogleStats(accessToken, account, managerId);
      for (const row of stats) {
        statsCount += 1;
        await postOps('/api/internal/campaign-daily-stats', {
          campaign: {
            ad_account: accountPayload,
            platform_campaign_id: `${account.customerId}:${row.campaignId}`,
            name: row.campaignName || row.campaignId,
            channel: 'google_ads',
            campaign_status: statusFromGoogle(row.campaignStatus),
            currency: account.currencyCode || 'EUR'
          },
          stat_date: row.statDate,
          spend: row.spend,
          impressions: row.impressions,
          clicks: row.clicks,
          leads: row.leads,
          currency: account.currencyCode || 'EUR',
          source_platform: 'ops_global_google_ads',
          raw_payload: {
            customer_id: account.customerId,
            campaign_id: row.campaignId
          }
        });
      }

      const adGroups = await discoverGoogleAdGroups(accessToken, account, managerId);
      for (const row of adGroups) {
        structureCount += 1;
        await postOps('/api/internal/campaign-structure-items', {
          platform: 'google_ads',
          item_type: 'ad_group',
          external_item_id: `${account.customerId}:${row.adGroupId}`,
          platform_campaign_id: `${account.customerId}:${row.campaignId}`,
          ad_account: accountPayload,
          name: row.adGroupName || row.adGroupId,
          status: statusFromGoogle(row.status),
          effective_status: statusFromGoogle(row.status),
          raw_payload: {
            customer_id: account.customerId,
            campaign_id: row.campaignId,
            ad_group_id: row.adGroupId
          }
        });
      }

      const assetGroups = await discoverGoogleAssetGroups(accessToken, account, managerId);
      for (const row of assetGroups) {
        structureCount += 1;
        await postOps('/api/internal/campaign-structure-items', {
          platform: 'google_ads',
          item_type: 'asset_group',
          external_item_id: `${account.customerId}:asset_group:${row.assetGroupId}`,
          platform_campaign_id: `${account.customerId}:${row.campaignId}`,
          ad_account: accountPayload,
          name: row.assetGroupName || row.assetGroupId,
          status: statusFromGoogle(row.status),
          effective_status: statusFromGoogle(row.status),
          destination_url: row.destinationUrl || null,
          source_platform: 'ops_global_google_ads',
          raw_payload: {
            source: 'ops_global_google_ads',
            customer_id: account.customerId,
            campaign_id: row.campaignId,
            asset_group_id: row.assetGroupId
          }
        });
      }

      const assetGroupAssets = await discoverGoogleAssetGroupAssets(accessToken, account, managerId);
      for (const row of assetGroupAssets) {
        const parentExternalId = `${account.customerId}:asset_group:${row.assetGroupId}`;
        structureCount += 1;
        await postOps('/api/internal/campaign-structure-items', {
          platform: 'google_ads',
          item_type: 'creative',
          external_item_id: `${parentExternalId}:${row.fieldType || 'asset'}:${row.assetId || row.assetResource}`,
          parent_external_id: parentExternalId,
          platform_campaign_id: `${account.customerId}:${row.campaignId}`,
          ad_account: accountPayload,
          name: row.name || row.previewTitle || row.assetId,
          status: statusFromGoogle(row.status),
          effective_status: statusFromGoogle(row.status),
          preview_title: row.previewTitle || null,
          preview_body: row.previewBody || null,
          thumbnail_url: row.thumbnailUrl || null,
          media_url: row.thumbnailUrl || null,
          destination_url: row.destinationUrl || null,
          source_platform: 'ops_global_google_ads',
          raw_payload: {
            source: 'ops_global_google_ads',
            customer_id: account.customerId,
            campaign_id: row.campaignId,
            asset_group_id: row.assetGroupId,
            asset_id: row.assetId,
            asset_resource: row.assetResource,
            field_type: row.fieldType,
            asset_type: row.assetType,
            youtube_video_id: row.youtubeId
          }
        });
      }

      const videoRows = await discoverGoogleVideoAdMetrics(accessToken, account, managerId);
      for (const row of videoRows) {
        structureCount += 1;
        await postOps('/api/internal/campaign-structure-items', {
          platform: 'google_ads',
          item_type: 'ad',
          external_item_id: `${account.customerId}:${row.adId}`,
          parent_external_id: row.adGroupId || null,
          platform_campaign_id: `${account.customerId}:${row.campaignId}`,
          ad_account: accountPayload,
          name: row.adName || row.adId,
          status: statusFromGoogle(row.status),
          effective_status: statusFromGoogle(row.status),
          preview_title: row.adName || row.adType || null,
          preview_body: row.adType || null,
          destination_url: row.destinationUrl || null,
          video_views: row.videoViews || null,
          video_retention_granularity: 'quartile',
          video_retention_quartiles: {
            p25: Number((row.quartiles.p25 * 100).toFixed(2)),
            p50: Number((row.quartiles.p50 * 100).toFixed(2)),
            p75: Number((row.quartiles.p75 * 100).toFixed(2)),
            p100: Number((row.quartiles.p100 * 100).toFixed(2))
          },
          source_platform: 'ops_global_google_ads',
          raw_payload: {
            source: 'ops_global_google_ads',
            customer_id: account.customerId,
            campaign_id: row.campaignId,
            ad_group_id: row.adGroupId,
            ad_id: row.adId,
            ad_type: row.adType,
            video_view_rate: row.videoViewRate,
            average_cpv_micros: row.averageCpvMicros,
            stat_date: row.statDate
          }
        });
      }
    }
  }

  return { accountsCount, campaignsCount, statsCount, structureCount };
}

async function main() {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  console.log(`[global-discovery] start lookback=${lookbackDays}`);

  const connectorRun = await postOps('/api/internal/connector-sync-runs', {
    connector_key: 'global_ads_discovery',
    connector_label: 'Meta/Google Ads global discovery',
    source_system: 'clinicaclick_bootstrap',
    scope_type: 'global',
    scope_id: 'all_accessible_accounts',
    started_at: startedAtIso,
    status: 'pending',
    raw_payload: {
      lookback_days: lookbackDays,
      limits: {
        meta_accounts: metaMaxAccounts,
        meta_adsets_per_account: metaMaxAdsetsPerAccount,
        meta_ads_per_account: metaMaxAdsPerAccount,
        meta_video_insight_calls: metaMaxVideoInsightCalls,
        google_accounts: googleMaxAccounts,
        google_customer_ids: Array.from(googleCustomerIdFilter),
        google_ad_groups_per_account: googleMaxAdGroupsPerAccount,
        google_asset_groups_per_account: googleMaxAssetGroupsPerAccount,
        google_asset_group_assets_per_account: googleMaxAssetGroupAssetsPerAccount,
        google_video_ads_per_account: googleMaxVideoAdsPerAccount
      }
    }
  });
  activeConnectorRunId = connectorRun.id;

  const meta = enabledPlatforms.has('meta')
    ? await syncMetaGlobal()
    : { accountsCount: 0, campaignsCount: 0, statsCount: 0, profilesCount: 0, structureCount: 0 };
  const google = (enabledPlatforms.has('google_ads') || enabledPlatforms.has('google'))
    ? await syncGoogleGlobal()
    : { accountsCount: 0, campaignsCount: 0, statsCount: 0, structureCount: 0 };

  const summary = {
    event: 'ops_global_discovery_finished',
    elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
    meta_accounts: meta.accountsCount,
    meta_campaigns: meta.campaignsCount,
    meta_stats: meta.statsCount,
    meta_profiles: meta.profilesCount,
    meta_structure_items: meta.structureCount,
    meta_deferred: meta.deferred === true,
    meta_rate_limited: meta.rateLimited === true,
    meta_pause_until: meta.pauseUntil || null,
    google_accounts: google.accountsCount,
    google_campaigns: google.campaignsCount,
    google_stats: google.statsCount,
    google_structure_items: google.structureCount
  };
  const itemsRead = meta.accountsCount + google.accountsCount;
  const itemsWritten = meta.accountsCount
    + meta.campaignsCount
    + meta.statsCount
    + meta.profilesCount
    + meta.structureCount
    + google.accountsCount
    + google.campaignsCount
    + google.statsCount
    + google.structureCount;

  await patchOps(`/api/internal/connector-sync-runs/${connectorRun.id}`, {
    finished_at: new Date().toISOString(),
    status: 'ok',
    items_read: itemsRead,
    items_written: itemsWritten,
    raw_payload: summary
  });
  activeConnectorRunId = null;

  console.log(JSON.stringify(summary));
}

main()
  .catch(async (error) => {
    await closeActiveConnectorRunAsFailed(error, 'catch');

    console.error('[global-discovery] failed:', error.response?.data || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeConnectorRunId && process.exitCode) {
      await closeActiveConnectorRunAsFailed(
        new Error('Process finished with error before connector run could be closed'),
        'finally'
      );
    }

    try {
      await db.sequelize.close();
    } catch (_error) {
      // noop
    }
  });
