'use strict';

const { fail } = require('./errors');
const { graphId } = require('./meta-marketing-contract');

function pageFields(raw, appId) {
  if (!Array.isArray(raw?.data) || raw.data.length > 100 || raw.paging?.next) fail('provider_failed');
  if (raw.data.some(row => !graphId(row?.id))) fail('provider_failed');
  const entries = raw.data.filter(row => row.id === appId);
  if (entries.length > 1) fail('provider_failed');
  const fields = entries.length ? entries[0].subscribed_fields : [];
  if (!Array.isArray(fields) || fields.length > 100 || new Set(fields).size !== fields.length ||
      fields.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value))) fail('provider_failed');
  return { subscribed: entries.length === 1, fields: [...fields].sort() };
}

// All Page subscription writes in the owner take the same lock, including Lead Ads.
// On an uncertain POST a later invocation first reads the actual provider state.
const writing = new Set();
async function ensureField({ appId, pageId, field, read, write, authorize }) {
  const key = appId + ':' + pageId;
  if (writing.has(key)) fail('oauth_flow_busy');
  writing.add(key);
  try {
    const before = await read();
    authorize(before);
    if (before.subscription.fields.includes(field)) return before;
    const desired = [...before.subscription.fields, field].sort();
    const ack = await write(desired);
    if (ack?.success !== true) fail('provider_failed');
    const after = await read();
    if (!after.subscription.subscribed || desired.some(value => !after.subscription.fields.includes(value)))
      fail('provider_failed');
    return after;
  } finally {
    writing.delete(key);
  }
}

function subscriptionForm(fields, proof) {
  return new URLSearchParams({ subscribed_fields: fields.join(','), appsecret_proof: proof }).toString();
}

module.exports = { pageFields, ensureField, subscriptionForm };
