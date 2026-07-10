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
const requestDelayMs = Number(process.env.OPS_GBP_DELAY_MS || 450);
const locationLimit = Number(process.env.OPS_GBP_LOCATION_LIMIT || 50);
const minAgeHours = Number(process.env.OPS_GBP_MIN_AGE_HOURS || 24);
const includeNotDue = process.env.OPS_GBP_INCLUDE_NOT_DUE === 'true';
const onlyRequested = process.env.OPS_GBP_ONLY_REQUESTED === 'true';
const targetClientId = process.env.OPS_GBP_CLIENT_ID || '';
const targetSearch = process.env.OPS_GBP_SEARCH || '';
const targetLocationId = process.env.OPS_GBP_LOCATION_ID || '';
const connectionEmail = process.env.OPS_GBP_CONNECTION_EMAIL || '';
const reviewPageSize = Number(process.env.OPS_GBP_REVIEW_PAGE_SIZE || 50);
const reviewMaxPages = Number(process.env.OPS_GBP_REVIEW_MAX_PAGES || 4);
const postPageSize = Number(process.env.OPS_GBP_POST_PAGE_SIZE || 20);
const postMaxPages = Number(process.env.OPS_GBP_POST_MAX_PAGES || 2);
const businessUnit = process.env.OPS_GBP_BUSINESS_UNIT || 'conmigas';
const reconcileOfficialIdentities = process.env.OPS_GBP_RECONCILE_IDENTITIES !== 'false';
const reconcileFuzzy = process.env.OPS_GBP_RECONCILE_FUZZY === 'true';
const reconcileLimit = Number(process.env.OPS_GBP_RECONCILE_LIMIT || 300);
const reconcileMatchLimit = Number(process.env.OPS_GBP_RECONCILE_MATCH_LIMIT || 300);
const discoverOfficialLocations = process.env.OPS_GBP_DISCOVER_OFFICIAL_LOCATIONS === 'true';
const discoverLocationLimit = Number(process.env.OPS_GBP_DISCOVER_LIMIT || 300);
const discoverSearch = process.env.OPS_GBP_DISCOVER_SEARCH || '';
let activeConnectorRunId = null;

const runFilters = {
  client_id: targetClientId || null,
  search: targetSearch || null,
  location_id: targetLocationId || null,
  min_age_hours: minAgeHours,
  include_not_due: includeNotDue,
  only_requested: onlyRequested,
  location_limit: locationLimit,
  review_max_pages: reviewMaxPages,
  post_max_pages: postMaxPages,
  discover_official_locations: discoverOfficialLocations,
  discover_limit: discoverLocationLimit,
  discover_search: discoverSearch || null
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function starRatingToNumber(value) {
  const normalized = String(value || '').toUpperCase();
  const map = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5
  };

  return map[normalized] || toInteger(value) || null;
}

function formatAddress(address) {
  if (!address) {
    return null;
  }

  const lines = Array.isArray(address.addressLines) ? address.addressLines.join(' ') : '';

  return [
    lines,
    address.postalCode,
    address.locality,
    address.administrativeArea
  ].filter(Boolean).join(', ') || null;
}

function cleanResourceName(value) {
  const clean = String(value || '').trim();
  const match = clean.match(/(?:accounts\/[0-9]+\/)?locations\/[0-9]+/);
  return match ? match[0] : clean;
}

function locationOnlyName(value) {
  const clean = cleanResourceName(value);
  const match = clean.match(/locations\/[0-9]+$/);
  return match ? match[0] : clean;
}

function accountLocationName(accountName, locationName) {
  const cleanLocation = locationOnlyName(locationName);
  const cleanAccount = String(accountName || '').trim();

  if (cleanLocation.startsWith('accounts/')) {
    return cleanLocation;
  }

  return cleanAccount ? `${cleanAccount}/${cleanLocation}` : cleanLocation;
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
    timeout: 45000
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
    timeout: 45000
  });

  return response.data;
}

async function getOps(endpoint, params = {}) {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  const response = await axios.get(`${apiUrl}${endpoint}`, {
    headers: {
      'x-ops-api-key': apiToken
    },
    params,
    timeout: 45000
  });

  return response.data;
}

async function postBatch(endpoint, items, size = 50) {
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

async function reconcileLocalLocationIdentities() {
  if (!reconcileOfficialIdentities) {
    return null;
  }

  const payload = {
    fuzzy: reconcileFuzzy,
    limit: reconcileLimit,
    match_limit: reconcileMatchLimit
  };

  if (targetClientId) {
    payload.client_id = targetClientId;
  }

  return postOps('/api/internal/local-locations/reconcile-official-identities', payload);
}

async function getGoogleConnections() {
  const emailFilter = connectionEmail ? 'AND userEmail = :connectionEmail' : '';

  return query(`
    SELECT id, userName, userEmail, accessToken, refreshToken, scopes, expiresAt
    FROM GoogleConnections
    WHERE accessToken IS NOT NULL
      ${emailFilter}
      AND (scopes LIKE '%business.manage%' OR scopes LIKE '%mybusiness%')
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

async function googleGet(url, accessToken, params = {}) {
  await sleep(requestDelayMs);

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    timeout: 45000
  });

  return response.data;
}

async function listAccounts(accessToken) {
  const accounts = [];
  let pageToken = null;

  do {
    const data = await googleGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken, {
      pageSize: 100,
      pageToken
    });

    accounts.push(...(data.accounts || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return accounts;
}

async function listAccountLocations(accessToken, accountName) {
  const locations = [];
  let pageToken = null;
  const readMask = [
    'name',
    'title',
    'storeCode',
    'metadata',
    'profile',
    'phoneNumbers',
    'categories',
    'storefrontAddress',
    'websiteUri',
    'openInfo'
  ].join(',');

  do {
    const data = await googleGet(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
      accessToken,
      {
        readMask,
        pageSize: 100,
        pageToken
      }
    );

    for (const location of data.locations || []) {
      locations.push({ ...location, accountName });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return locations;
}

async function discoverLocations(accessToken) {
  const locationsByName = new Map();
  const accounts = await listAccounts(accessToken);

  for (const account of accounts) {
    const locations = await listAccountLocations(accessToken, account.name);

    for (const location of locations) {
      locationsByName.set(locationOnlyName(location.name), {
        ...location,
        accountName: account.name,
        accountDisplayName: account.accountName || account.name
      });
    }
  }

  return locationsByName;
}

async function fetchLocationDetails(accessToken, locationName) {
  const readMask = [
    'name',
    'title',
    'storeCode',
    'metadata',
    'profile',
    'phoneNumbers',
    'categories',
    'storefrontAddress',
    'websiteUri',
    'openInfo'
  ].join(',');

  return googleGet(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${locationOnlyName(locationName)}`,
    accessToken,
    { readMask }
  );
}

async function listReviews(accessToken, parent) {
  const reviews = [];
  let pageToken = null;
  let page = 0;

  do {
    page += 1;
    const data = await googleGet(
      `https://mybusiness.googleapis.com/v4/${parent}/reviews`,
      accessToken,
      {
        pageSize: reviewPageSize,
        pageToken,
        orderBy: 'updateTime desc'
      }
    );

    reviews.push(...(data.reviews || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && page < reviewMaxPages);

  return reviews;
}

async function listPosts(accessToken, parent) {
  const posts = [];
  let pageToken = null;
  let page = 0;

  do {
    page += 1;
    const data = await googleGet(
      `https://mybusiness.googleapis.com/v4/${parent}/localPosts`,
      accessToken,
      {
        pageSize: postPageSize,
        pageToken
      }
    );

    posts.push(...(data.localPosts || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && page < postMaxPages);

  return posts;
}

function locationPayload(target, location, connection) {
  const metadata = location.metadata || {};
  const openInfo = location.openInfo || {};
  const primaryCategory = location.categories?.primaryCategory?.displayName || location.categories?.primaryCategory?.name || null;
  const suspended = location.locationState?.isSuspended;

  return {
    client_id: target.client_id,
    client_name: target.client_name,
    business_unit: businessUnit,
    external_location_id: locationOnlyName(location.name || target.external_location_id),
    place_id: metadata.placeId || target.place_id || null,
    name: target.name || location.title || target.external_location_id,
    location_name: location.title || target.name || target.external_location_id,
    store_code: target.store_code || location.storeCode || null,
    address: formatAddress(location.storefrontAddress) || target.address || null,
    public_url: metadata.mapsUri || target.public_url || null,
    google_maps_url: metadata.mapsUri || null,
    verified: metadata.hasVoiceOfMerchant === undefined ? null : Boolean(metadata.hasVoiceOfMerchant),
    suspended: suspended === undefined ? null : Boolean(suspended),
    location_status: openInfo.status === 'CLOSED_PERMANENTLY' ? 'paused' : 'active',
    last_synced_at: new Date().toISOString(),
    source_platform: 'ops_google_business_profile',
    raw_payload: {
      source: 'ops_google_business_profile',
      connectionId: connection.id,
      connectionEmail: connection.userEmail,
      accountName: location.accountName || target.account_name || null,
      accountDisplayName: location.accountDisplayName || target.account_display_name || null,
      googleTitle: location.title || null,
      primaryCategory,
      metadata,
      openInfo,
      websiteUri: location.websiteUri || null
    }
  };
}

function reviewPayload(target, review) {
  const rating = starRatingToNumber(review.starRating);
  const reply = review.reviewReply || null;

  return {
    client_id: target.client_id,
    client_name: target.client_name,
    business_unit: businessUnit,
    external_location_id: target.external_location_id,
    external_review_id: review.name || review.reviewId,
    reviewer_name: review.reviewer?.displayName || null,
    rating,
    comment: review.comment || null,
    review_state: review.reviewState || null,
    has_reply: Boolean(reply?.comment),
    is_negative: Boolean(rating && rating <= 3),
    review_created_at: review.createTime || null,
    review_updated_at: review.updateTime || null,
    reply_comment: reply?.comment || null,
    raw_payload: {
      source: 'ops_google_business_profile',
      reviewId: review.reviewId || null,
      name: review.name || null,
      starRating: review.starRating || null,
      createTime: review.createTime || null,
      updateTime: review.updateTime || null,
      hasReply: Boolean(reply?.comment)
    }
  };
}

function postPayload(target, post) {
  const media = Array.isArray(post.media) ? post.media[0] : null;

  return {
    client_id: target.client_id,
    client_name: target.client_name,
    business_unit: businessUnit,
    external_location_id: target.external_location_id,
    external_post_id: post.name,
    summary: post.summary || null,
    topic_type: post.topicType || null,
    cta_type: post.callToAction?.actionType || null,
    cta_url: post.callToAction?.url || post.searchUrl || null,
    media_url: media?.googleUrl || media?.sourceUrl || null,
    published_at: post.createTime || post.updateTime || null,
    visibility_state: post.state || null,
    raw_payload: {
      source: 'ops_google_business_profile',
      name: post.name,
      state: post.state || null,
      searchUrl: post.searchUrl || null,
      updateTime: post.updateTime || null
    }
  };
}

function discoveryText(location) {
  return [
    location.name,
    location.title,
    location.storeCode,
    location.accountDisplayName,
    location.accountName,
    formatAddress(location.storefrontAddress),
    location.metadata?.mapsUri,
    location.websiteUri
  ].filter(Boolean).join(' ').toLowerCase();
}

function discoveryMatches(location) {
  if (!discoverSearch) {
    return true;
  }

  return discoveryText(location).includes(discoverSearch.toLowerCase());
}

async function upsertDiscoveredOfficialLocations(connection, accessToken, existingIndex = null) {
  if (!discoverOfficialLocations) {
    return { scanned: 0, written: 0, errors: 0 };
  }

  const locationIndex = existingIndex || await discoverLocations(accessToken);
  const discovered = Array.from(locationIndex.values())
    .filter(discoveryMatches)
    .sort((a, b) => String(a.title || a.name || '').localeCompare(String(b.title || b.name || '')))
    .slice(0, discoverLocationLimit);

  let written = 0;
  let errors = 0;

  for (const location of discovered) {
    try {
      const payload = locationPayload({
        client_id: null,
        client_name: null,
        external_location_id: locationOnlyName(location.name),
        name: location.title || location.name,
        store_code: location.storeCode || null,
        address: formatAddress(location.storefrontAddress),
        public_url: location.metadata?.mapsUri || null
      }, location, connection);
      payload.discovery_only = true;
      payload.source_platform = 'ops_google_business_profile_discovery';
      payload.raw_payload = {
        ...payload.raw_payload,
        discoveryOnly: true
      };

      await postOps('/api/internal/local-locations', payload);
      written += 1;
    } catch (error) {
      errors += 1;
      console.error(JSON.stringify({
        step: 'discover_official_location',
        location: locationOnlyName(location.name),
        error: error.response?.data?.error?.message || error.message,
        status: error.response?.status || null
      }));
    }
  }

  return { scanned: discovered.length, written, errors };
}

async function getTargets() {
  const data = await getOps('/api/internal/local-locations-to-sync', {
    limit: locationLimit,
    min_age_hours: minAgeHours,
    include_not_due: includeNotDue ? '1' : undefined,
    only_requested: onlyRequested ? '1' : undefined,
    client_id: targetClientId || undefined,
    q: targetSearch || undefined,
    location_id: targetLocationId || undefined
  });

  return data.items || [];
}

async function syncTargetsWithConnection(connection, targets) {
  const accessToken = await refreshGoogleConnection(connection);
  let locationIndex = null;
  let locations = 0;
  let reviews = 0;
  let posts = 0;
  let errors = 0;
  let discovery = { scanned: 0, written: 0, errors: 0 };

  for (const target of targets) {
    const locationName = locationOnlyName(target.external_location_id);
    let accountName = target.account_name && target.account_name !== 'null' ? target.account_name : null;
    let location = null;

    try {
      if (!accountName) {
        locationIndex = locationIndex || await discoverLocations(accessToken);
        const discovered = locationIndex.get(locationName);
        accountName = discovered?.accountName || null;
        location = discovered || null;
      }

      if (!location) {
        location = await fetchLocationDetails(accessToken, locationName);
        location.accountName = accountName;
        location.accountDisplayName = target.account_display_name || null;
      }

      if (!accountName) {
        throw new Error(`No account found for ${locationName}`);
      }

      const parent = accountLocationName(accountName, locationName);
      await postOps('/api/internal/local-locations', locationPayload(target, location, connection));
      locations += 1;

      const locationReviews = await listReviews(accessToken, parent);
      reviews += await postBatch('/api/internal/local-reviews', locationReviews.map((review) => reviewPayload(target, review)));

      const locationPosts = await listPosts(accessToken, parent);
      posts += await postBatch('/api/internal/local-posts', locationPosts.map((post) => postPayload(target, post)));
    } catch (error) {
      errors += 1;
      console.error(JSON.stringify({
        location: locationName,
        client_id: target.client_id,
        error: error.response?.data?.error?.message || error.message,
        status: error.response?.status || null
      }));
    }
  }

  if (discoverOfficialLocations) {
    try {
      discovery = await upsertDiscoveredOfficialLocations(connection, accessToken, locationIndex);
    } catch (error) {
      errors += 1;
      discovery = { scanned: 0, written: 0, errors: 1 };
      console.error(JSON.stringify({
        step: 'discover_official_locations',
        error: error.response?.data?.error?.message || error.message,
        status: error.response?.status || null
      }));
    }
  }

  return {
    locations,
    reviews,
    posts,
    errors: errors + discovery.errors,
    discovery
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const connectorRun = await postOps('/api/internal/connector-sync-runs', {
    connector_key: 'google_business_profile',
    connector_label: 'Google Business Profile',
    source_system: 'clinicaclick_bootstrap',
    scope_type: targetClientId ? 'client' : targetLocationId ? 'local_location' : 'global',
    scope_id: targetClientId || targetLocationId || targetSearch || null,
    client_id: targetClientId || null,
    started_at: startedAt,
    status: 'pending',
    raw_payload: {
      filters: runFilters
    }
  });
  activeConnectorRunId = connectorRun.id;

  const targets = await getTargets();

  if (!targets.length && !discoverOfficialLocations) {
    await patchOps(`/api/internal/connector-sync-runs/${connectorRun.id}`, {
      finished_at: new Date().toISOString(),
      status: 'ok',
      items_read: 0,
      items_written: 0,
      raw_payload: { filters: runFilters, targets: 0, locations: 0, reviews: 0, posts: 0, errors: 0 }
    });
    activeConnectorRunId = null;
    console.log(JSON.stringify({ status: 'ok', targets: 0, locations: 0, reviews: 0, posts: 0, errors: 0 }));
    return;
  }

  const connections = await getGoogleConnections();

  if (!connections.length) {
    throw new Error('No GoogleConnections with business.manage scope found');
  }

  let summary = {
    targets: targets.length,
    locations: 0,
    reviews: 0,
    posts: 0,
    errors: 0,
    discovery: {
      scanned: 0,
      written: 0,
      errors: 0
    },
    reconciliation: null
  };

  for (const connection of connections) {
    const result = await syncTargetsWithConnection(connection, targets);
    summary = {
      targets: summary.targets,
      locations: summary.locations + result.locations,
      reviews: summary.reviews + result.reviews,
      posts: summary.posts + result.posts,
      errors: summary.errors + result.errors,
      discovery: {
        scanned: summary.discovery.scanned + (result.discovery?.scanned || 0),
        written: summary.discovery.written + (result.discovery?.written || 0),
        errors: summary.discovery.errors + (result.discovery?.errors || 0)
      },
      reconciliation: summary.reconciliation
    };

    if (!discoverOfficialLocations && summary.locations >= targets.length) {
      break;
    }
  }

  try {
    summary.reconciliation = await reconcileLocalLocationIdentities();
  } catch (error) {
    summary.errors += 1;
    summary.reconciliation_error = error.response?.data?.error?.message || error.message;
    console.error(JSON.stringify({
      step: 'reconcile_local_location_identities',
      error: summary.reconciliation_error,
      status: error.response?.status || null
    }));
  }

  const status = summary.errors ? 'warning' : 'ok';
  await patchOps(`/api/internal/connector-sync-runs/${connectorRun.id}`, {
    finished_at: new Date().toISOString(),
    status,
    items_read: summary.targets + summary.discovery.scanned,
    items_written: summary.locations + summary.reviews + summary.posts + summary.discovery.written,
    raw_payload: { filters: runFilters, ...summary }
  });
  activeConnectorRunId = null;

  console.log(JSON.stringify({ status, ...summary }, null, 2));
}

main()
  .catch(async (error) => {
    if (activeConnectorRunId) {
      try {
        await patchOps(`/api/internal/connector-sync-runs/${activeConnectorRunId}`, {
          finished_at: new Date().toISOString(),
          status: 'failed',
          error_message: error.response?.data?.error?.message || error.message,
          raw_payload: {
            http_status: error.response?.status || null
          }
        });
      } catch (_patchError) {
        // no-op: the original error is more useful in logs
      }
    }

    console.error(JSON.stringify({
      status: 'error',
      error: error.response?.data?.error?.message || error.message,
      http_status: error.response?.status || null
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (_error) {
      // no-op
    }
  });
