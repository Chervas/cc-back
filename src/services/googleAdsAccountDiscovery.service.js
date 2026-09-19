'use strict';

const { googleAdsRequest } = require('../lib/googleAdsClient');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');

function incompleteDiscovery() {
  return Object.assign(new Error('Google Ads account discovery could not be completed'), {
    code: 'google_ads_discovery_incomplete', httpStatus: 502,
  });
}

function customerId(resourceName) {
  if (typeof resourceName !== 'string' || !/^customers\/\d{10}$/.test(resourceName)) throw incompleteDiscovery();
  return resourceName.slice('customers/'.length);
}

// The picker needs account identities, not per-account manager invitations or clinic mappings.
async function discoverGoogleAdsAccountSelection({ accessToken, request = googleAdsRequest, now = Date.now,
  timeoutMs = 40000, maxAccounts = 5000, maxRequests = 100 }) {
  if (!accessToken) throw incompleteDiscovery();
  const deadline = now() + timeoutMs;
  let requests = 0;
  const boundedRequest = async (method, path, options) => {
    const remaining = deadline - now();
    if (remaining <= 0 || ++requests > maxRequests) throw incompleteDiscovery();
    let result;
    try {
      result = await request(method, path, { ...options, accessToken, singleAttempt: true,
        timeoutMs: Math.min(8000, remaining, options?.timeoutMs || 8000) });
    } catch (error) {
      const details = error.response?.data?.error?.details;
      error.discoveryCodes = Array.isArray(details) ? details.flatMap(detail => (Array.isArray(detail.errors) ? detail.errors : [])
        .flatMap(item => Object.values(item.errorCode || {}).filter(value => typeof value === 'string' && /^[A-Z][A-Z_]+$/.test(value)))) : [];
      throw error;
    }
    if (now() >= deadline) throw incompleteDiscovery();
    return result;
  };
  const search = (id, query, loginCustomerId) => googleAdsSearchRows({ customerId: id, accessToken, loginCustomerId,
    query, request: boundedRequest, now, timeoutMs: Math.max(1, deadline - now()) });
  const response = await boundedRequest('GET', 'customers:listAccessibleCustomers');
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error
    || response.resourceNames !== undefined && !Array.isArray(response.resourceNames)) throw incompleteDiscovery();
  const roots = [...new Set((response.resourceNames || []).map(customerId))];
  if (roots.length > maxAccounts) throw incompleteDiscovery();
  const accounts = new Map();
  const unavailable = new Set();
  const add = (id, source, loginCustomerId = null) => {
    if (source.manager !== undefined && typeof source.manager !== 'boolean') throw incompleteDiscovery();
    if (['CANCELED', 'CLOSED'].includes(source.status)) { unavailable.add(id); return; }
    if (accounts.has(id)) return;
    if (accounts.size >= maxAccounts) throw incompleteDiscovery();
    accounts.set(id, { customerId: id, descriptiveName: source.descriptiveName || null,
      currencyCode: source.currencyCode || null, isManager: source.manager === true, loginCustomerId });
  };
  for (const root of roots) {
    if (accounts.has(root) || unavailable.has(root)) continue;
    let rows;
    try {
      rows = await search(root, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer');
    } catch (error) {
      // Google lists directly accessible accounts even when they are closed or not yet enabled.
      if (error.response?.status === 403 && error.discoveryCodes?.length
        && error.discoveryCodes.every(code => code === 'CUSTOMER_NOT_ENABLED')) {
        unavailable.add(root); continue;
      }
      throw error;
    }
    if (rows.length !== 1 || String(rows[0]?.customer?.id) !== root) throw incompleteDiscovery();
    const summary = rows[0].customer;
    add(root, summary);
    if (!summary.manager) continue;
    // CustomerClient includes the complete direct and indirect hierarchy, including the manager itself.
    const clients = await search(root,
      'SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.hidden, customer_client.status FROM customer_client WHERE customer_client.hidden = FALSE', root);
    for (const row of clients) {
      const client = row?.customerClient;
      if (!client || client.hidden !== undefined && typeof client.hidden !== 'boolean') throw incompleteDiscovery();
      const id = customerId(client.clientCustomer);
      if (client.hidden !== true) add(id, client, id === root ? null : root);
    }
  }
  return { accounts: [...accounts.values()].filter(account => !unavailable.has(account.customerId))
    .sort((a, b) => (a.descriptiveName || a.customerId).localeCompare(b.descriptiveName || b.customerId, 'es')
      || a.customerId.localeCompare(b.customerId)), unavailableAccountCount: unavailable.size };
}

module.exports = { discoverGoogleAdsAccountSelection };
