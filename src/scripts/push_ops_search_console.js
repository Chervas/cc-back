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

const apiUrl = (process.env.OPS_API_URL || 'https://ops.conmigas.com').replace(/\/$/, '');
const apiToken = process.env.OPS_INTERNAL_API_TOKEN;
const lookbackDays = Number(process.env.SEARCH_CONSOLE_LOOKBACK_DAYS || 7);
const rowLimit = Number(process.env.SEARCH_CONSOLE_ROW_LIMIT || 250);
const siteLimit = Number(process.env.OPS_SEARCH_CONSOLE_SITE_LIMIT || 50);
const requestDelayMs = Number(process.env.OPS_SEARCH_CONSOLE_DELAY_MS || 250);
const connectionEmail = process.env.OPS_SEARCH_CONSOLE_CONNECTION_EMAIL || '';
const siteSearch = String(process.env.OPS_SEARCH_CONSOLE_SEARCH || '').trim().toLowerCase();
const discoverAccessibleSites = process.env.OPS_SEARCH_CONSOLE_DISCOVER !== 'false';
let activeConnectorRunId = null;
let activeConnectorRunContext = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function domainFromSiteUrl(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  if (raw.startsWith('sc-domain:')) {
    return raw.replace(/^sc-domain:/, '').replace(/\/+$/, '').toLowerCase();
  }

  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_error) {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

function domainKeys(value) {
  const domain = domainFromSiteUrl(value);

  if (!domain) {
    return [];
  }

  const withoutWww = domain.replace(/^www\./, '');
  return Array.from(new Set([domain, withoutWww]));
}

async function query(sql, replacements = {}) {
  return db.sequelize.query(sql, {
    replacements,
    type: db.Sequelize.QueryTypes.SELECT
  });
}

async function postOps(endpoint, payload) {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  const response = await axios.post(`${apiUrl}${endpoint}`, payload, {
    headers: {
      'content-type': 'application/json',
      'x-ops-api-key': apiToken
    },
    timeout: 60000
  });

  return response.data;
}

async function patchOps(endpoint, payload) {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  const response = await axios.patch(`${apiUrl}${endpoint}`, payload, {
    headers: {
      'content-type': 'application/json',
      'x-ops-api-key': apiToken
    },
    timeout: 60000
  });

  return response.data;
}

async function getOps(endpoint) {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  const response = await axios.get(`${apiUrl}${endpoint}`, {
    headers: {
      'x-ops-api-key': apiToken
    },
    timeout: 60000
  });

  return response.data;
}

async function postBatch(endpoint, items, size = 100) {
  let sent = 0;

  for (let index = 0; index < items.length; index += size) {
    const slice = items.slice(index, index + size);
    if (!slice.length) {
      continue;
    }

    await postOps(endpoint, { items: slice });
    sent += slice.length;
  }

  return sent;
}

function normalizeSites(sites) {
  const seen = new Set();

  return sites
    .filter((site) => site && site.site_url)
    .map((site) => ({
      client_id: site.client_id || null,
      client_name: site.client_name || null,
      business_unit: site.business_unit || 'unknown',
      website_id: site.website_id || null,
      domain: site.domain || null,
      matched_target: Boolean(site.matched_target || site.website_id),
      matched_source_type: site.matched_source_type || null,
      hosting_asset_id: site.hosting_asset_id || null,
      hosting_label: site.hosting_label || null,
      hosting_scope: site.hosting_scope || null,
      site_url: String(site.site_url || '').trim(),
      permission_level: site.permission_level || null,
      source: site.source || 'ops'
    }))
    .filter((site) => {
      const key = site.site_url.toLowerCase();

      if (!key || seen.has(key)) {
        return false;
      }

      if (siteSearch) {
        const haystack = `${site.site_url} ${site.domain || ''} ${site.client_name || ''}`.toLowerCase();
        if (!haystack.includes(siteSearch)) {
          return false;
        }
      }

      seen.add(key);
      return true;
    })
    .slice(0, siteLimit);
}

function buildCoverageTargets(dashboard) {
  const targets = new Map();

  for (const row of dashboard.coverage || []) {
    const domain = row.domain || domainFromSiteUrl(row.site_url);

    for (const key of domainKeys(domain)) {
      if (!targets.has(key)) {
        targets.set(key, row);
      }
    }
  }

  return targets;
}

function siteFromCoverageRow(row) {
  return {
    client_id: row.client_id || null,
    client_name: row.client_name || null,
    business_unit: row.business_unit || 'unknown',
    website_id: row.website_id || null,
    domain: row.domain || null,
    matched_target: Boolean(row.website_id || row.hosting_asset_id),
    matched_source_type: row.source_type || null,
    hosting_asset_id: row.hosting_asset_id || null,
    hosting_label: row.hosting_label || null,
    hosting_scope: row.hosting_scope || null,
    site_url: row.site_url,
    source: 'ops_coverage'
  };
}

function siteFromGoogleEntry(entry, coverageTargets) {
  const siteUrl = String(entry.siteUrl || '').trim();
  const domain = domainFromSiteUrl(siteUrl);
  const target = domainKeys(domain)
    .map((key) => coverageTargets.get(key))
    .find(Boolean);
  const hostingLabel = target?.hosting_label || null;
  const hostingScope = target?.hosting_scope ||
    (/^Alderaan\b/i.test(hostingLabel || '') ? 'alderaan' : null);

  return {
    client_id: target?.client_id || null,
    client_name: target?.client_name || null,
    business_unit: target?.business_unit || 'unknown',
    website_id: target?.website_id || null,
    matched_target: Boolean(target),
    matched_source_type: target?.source_type || null,
    hosting_asset_id: target?.hosting_asset_id || null,
    hosting_label: hostingLabel,
    hosting_scope: hostingScope,
    domain: target?.domain || domain || null,
    site_url: siteUrl,
    permission_level: entry.permissionLevel || null,
    source: target ? 'google_discovered_matched' : 'google_discovered_unmatched'
  };
}

async function listAccessibleSearchConsoleSites(accessToken) {
  const response = await axios.get('https://www.googleapis.com/webmasters/v3/sites', {
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    timeout: 60000
  });

  return response.data?.siteEntry || [];
}

async function loadSites(accessToken) {
  if (process.env.OPS_SEARCH_CONSOLE_SITES) {
    const sites = JSON.parse(process.env.OPS_SEARCH_CONSOLE_SITES);
    if (!Array.isArray(sites) || !sites.length) {
      throw new Error('OPS_SEARCH_CONSOLE_SITES must be a non-empty JSON array');
    }

    return normalizeSites(sites);
  }

  const dashboard = await getOps('/api/internal/seo-dashboard');
  const coverageTargets = buildCoverageTargets(dashboard);
  let sites = [];

  if (discoverAccessibleSites) {
    const accessibleSites = await listAccessibleSearchConsoleSites(accessToken);
    sites = normalizeSites(accessibleSites.map((entry) => siteFromGoogleEntry(entry, coverageTargets)));
  } else {
    sites = normalizeSites(
      (dashboard.coverage || [])
        .filter((row) => row.website_id && row.site_url)
        .map(siteFromCoverageRow)
    );
  }

  if (!sites.length) {
    throw new Error('No Search Console sites found. Set OPS_SEARCH_CONSOLE_SITES or connect accessible Search Console properties.');
  }

  return sites;
}

async function getGoogleConnections() {
  const emailFilter = connectionEmail ? 'AND userEmail = :connectionEmail' : '';

  return query(`
    SELECT id, userName, userEmail, accessToken, refreshToken, scopes, expiresAt
    FROM GoogleConnections
    WHERE accessToken IS NOT NULL
      ${emailFilter}
      AND scopes LIKE '%webmasters.readonly%'
    ORDER BY updated_at DESC, id DESC
  `, { connectionEmail });
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

async function querySearchConsole(accessToken, siteUrl, startDate, endDate) {
  await sleep(requestDelayMs);

  const response = await axios.post(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      startDate,
      endDate,
      dimensions: ['query', 'page', 'date'],
      rowLimit
    },
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      timeout: 60000
    }
  );

  return response.data;
}

function queryPayload(site, row) {
  const [queryText, pageUrl, statDate] = row.keys || [];

  return {
    client_id: site.client_id || null,
    client_name: site.client_name || null,
    business_unit: site.business_unit || 'unknown',
    website_id: site.website_id || null,
    domain: site.domain || null,
    hosting_asset_id: site.hosting_asset_id || null,
    hosting_label: site.hosting_label || null,
    hosting_scope: site.hosting_scope || null,
    site_url: site.site_url,
    page_url: pageUrl || '',
    query_text: queryText,
    stat_date: statDate,
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || null,
    source_platform: 'google_search_console',
    raw_payload: {
      ...row,
      source: 'clinicaclick_oauth'
    }
  };
}

function dailyPayloads(site, queries) {
  const byDate = new Map();

  for (const row of queries) {
    const current = byDate.get(row.stat_date) || {
      client_id: site.client_id || null,
      client_name: site.client_name || null,
      business_unit: site.business_unit || 'unknown',
      website_id: site.website_id || null,
      domain: site.domain || null,
      hosting_asset_id: site.hosting_asset_id || null,
      hosting_label: site.hosting_label || null,
      hosting_scope: site.hosting_scope || null,
      site_url: site.site_url,
      stat_date: row.stat_date,
      clicks: 0,
      impressions: 0,
      position_sum: 0,
      position_count: 0,
      top3: new Set(),
      top10: new Set()
    };

    current.clicks += Number(row.clicks || 0);
    current.impressions += Number(row.impressions || 0);
    if (row.position) {
      current.position_sum += Number(row.position);
      current.position_count += 1;
      if (Number(row.position) <= 3) {
        current.top3.add(row.query_text);
      }
      if (Number(row.position) <= 10) {
        current.top10.add(row.query_text);
      }
    }

    byDate.set(row.stat_date, current);
  }

  return Array.from(byDate.values()).map((row) => ({
    client_id: row.client_id,
    client_name: row.client_name,
    business_unit: row.business_unit,
    website_id: row.website_id,
    domain: row.domain,
    hosting_asset_id: row.hosting_asset_id,
    hosting_label: row.hosting_label,
    hosting_scope: row.hosting_scope,
    site_url: row.site_url,
    stat_date: row.stat_date,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    position: row.position_count ? row.position_sum / row.position_count : null,
    top3_queries: row.top3.size,
    top10_queries: row.top10.size,
    raw_payload: {
      source: 'clinicaclick-search-console-to-ops',
      query_rows: queries.filter((query) => query.stat_date === row.stat_date).length
    }
  }));
}

async function syncWithConnection(connection, sites, startDate, endDate, accessTokenOverride = null) {
  const accessToken = accessTokenOverride || await refreshGoogleConnection(connection);
  const summary = {
    sites: sites.length,
    queried_sites: 0,
    matched_sites: sites.filter((site) => site.matched_target || site.website_id).length,
    unmatched_sites: sites.filter((site) => !(site.matched_target || site.website_id)).length,
    query_rows: 0,
    daily_rows: 0,
    errors: 0,
    site_summaries: []
  };

  for (const site of sites) {
    try {
      const data = await querySearchConsole(accessToken, site.site_url, startDate, endDate);
      const rows = data.rows || [];
      const queries = rows
        .map((row) => queryPayload(site, row))
        .filter((row) => row.query_text && row.stat_date);
      const daily = dailyPayloads(site, queries);

      if (queries.length) {
        summary.query_rows += await postBatch('/api/internal/web-search-queries', queries);
      }

      if (daily.length) {
        summary.daily_rows += await postBatch('/api/internal/web-seo-daily', daily);
      }

      summary.queried_sites += 1;
      summary.site_summaries.push({
        site_url: site.site_url,
        website_id: site.website_id || null,
        matched_target: Boolean(site.matched_target || site.website_id),
        hosting_asset_id: site.hosting_asset_id || null,
        domain: site.domain || null,
        source: site.source || null,
        query_rows: queries.length,
        daily_rows: daily.length
      });
      console.log(`[search-console-oauth-to-ops] ${site.site_url}: ${queries.length} query rows`);
    } catch (error) {
      summary.errors += 1;
      summary.site_summaries.push({
        site_url: site.site_url,
        website_id: site.website_id || null,
        matched_target: Boolean(site.matched_target || site.website_id),
        hosting_asset_id: site.hosting_asset_id || null,
        domain: site.domain || null,
        source: site.source || null,
        error: error.response?.data?.error?.message || error.message,
        status: error.response?.status || null
      });
      console.error(JSON.stringify({
        site_url: site.site_url,
        error: error.response?.data?.error?.message || error.message,
        status: error.response?.status || null
      }));
    }
  }

  return summary;
}

async function main() {
  const startedAt = new Date().toISOString();
  const connectorRun = await postOps('/api/internal/connector-sync-runs', {
    connector_key: 'google_search_console',
    connector_label: 'Google Search Console',
    source_system: 'clinicaclick_bootstrap',
    scope_type: 'seo',
    scope_id: siteSearch || 'all_configured_sites',
    started_at: startedAt,
    status: 'pending',
    raw_payload: {
      auth_mode: 'clinicaclick_oauth',
      lookback_days: lookbackDays,
      row_limit: rowLimit,
      site_limit: siteLimit,
      site_search: siteSearch || null,
      discover_accessible_sites: discoverAccessibleSites,
      connection_email: connectionEmail || null
    }
  });
  activeConnectorRunId = connectorRun.id;

  const connections = await getGoogleConnections();

  if (!connections.length) {
    throw new Error('No GoogleConnections with webmasters.readonly scope found');
  }

  const accessToken = await refreshGoogleConnection(connections[0]);
  const sites = await loadSites(accessToken);
  activeConnectorRunContext = {
    auth_mode: 'clinicaclick_oauth',
    sites: sites.length,
    matched_sites: sites.filter((site) => site.matched_target || site.website_id).length,
    unmatched_sites: sites.filter((site) => !(site.matched_target || site.website_id)).length,
    site_urls: sites.map((site) => site.site_url).filter(Boolean).slice(0, 25)
  };
  console.log(`[search-console-oauth-to-ops] discovered ${sites.length} site(s)`);

  const startDate = isoDateDaysAgo(lookbackDays);
  const endDate = isoDateDaysAgo(1);
  const summary = await syncWithConnection(connections[0], sites, startDate, endDate, accessToken);
  const status = summary.errors ? 'warning' : 'ok';

  await patchOps(`/api/internal/connector-sync-runs/${connectorRun.id}`, {
    finished_at: new Date().toISOString(),
    status,
    items_read: summary.sites,
    items_written: summary.query_rows + summary.daily_rows,
    raw_payload: {
      ...summary,
      auth_mode: 'clinicaclick_oauth',
      discover_accessible_sites: discoverAccessibleSites,
      connection_email: connections[0].userEmail || null,
      start_date: startDate,
      end_date: endDate
    }
  });
  activeConnectorRunId = null;
  activeConnectorRunContext = {};

  console.log(JSON.stringify({ status, ...summary }, null, 2));
}

main()
  .catch(async (error) => {
    if (activeConnectorRunId) {
      try {
        await patchOps(`/api/internal/connector-sync-runs/${activeConnectorRunId}`, {
          finished_at: new Date().toISOString(),
          status: 'failed',
          items_read: activeConnectorRunContext.sites || 0,
          items_written: 0,
          error_message: error.response?.data?.error?.message || error.message,
          raw_payload: {
            ...activeConnectorRunContext,
            auth_mode: 'clinicaclick_oauth',
            http_status: error.response?.status || null
          }
        });
      } catch (_patchError) {
        // Keep the original error in the process log.
      }
    }

    console.error(JSON.stringify({
      status: 'error',
      error: error.response?.data?.error?.message || error.message,
      http_status: error.response?.status || null
    }));
    process.exit(1);
  })
  .finally(async () => {
    await db.sequelize.close();
  });
