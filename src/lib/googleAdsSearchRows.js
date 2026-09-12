'use strict';

const { googleAdsRequest, normalizeCustomerId } = require('./googleAdsClient');

async function googleAdsSearchRows({ customerId, accessToken, loginCustomerId, query, apiVersion, request = googleAdsRequest,
  maxPages = 20, timeoutMs = 45000, now = Date.now }) {
  const customer = normalizeCustomerId(customerId);
  const fail = () => { throw Object.assign(new Error('Google Ads search could not be completed'), {
    code: 'GOOGLE_ADS_SEARCH_INCOMPLETE', status: 409, httpStatus: 409,
  }); };
  if (!/^\d+$/.test(customer) || !accessToken || typeof query !== 'string' || !query.trim()) fail();
  const deadline = now() + timeoutMs; const rows = []; const seen = new Set(); let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const remaining = deadline - now();
    if (remaining <= 0) fail();
    const response = await request('POST', `customers/${customer}/googleAds:search`, {
      accessToken, apiVersion, loginCustomerId: loginCustomerId || undefined, singleAttempt: true,
      timeoutMs: Math.min(10000, remaining), data: { query, ...(pageToken ? { pageToken } : {}) },
    });
    if (now() >= deadline) fail();
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.error || response.errors
      || response.partialFailureError || response.partial_failure_error
      || response.results !== undefined && !Array.isArray(response.results)) fail();
    rows.push(...(response.results || []));
    const next = response.nextPageToken ?? response.next_page_token;
    if (!next) return rows;
    if (typeof next !== 'string' || next.length > 4096 || seen.has(next)) fail();
    seen.add(next); pageToken = next;
  }
  fail();
}

module.exports = { googleAdsSearchRows };
