'use strict';

// The destination is resolved inside the broker from the granted property.
// No API secrets, arbitrary URLs or provider cursors cross this boundary.
const { fail } = require('./errors');
const OPERATION = 'google.analytics.streams.read.v1';
const MAX_STREAMS = 200;
function projectStream(row, propertyName) {
  if (!row || typeof row.name !== 'string' || !row.name.startsWith(`${propertyName}/dataStreams/`)
    || !/^[1-9]\d{0,19}$/.test(row.name.slice(`${propertyName}/dataStreams/`.length))) fail('provider_failed');
  if (['ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'].includes(row.type)) return null;
  if (row.type !== 'WEB_DATA_STREAM' || !/^G-[A-Z0-9]{4,32}$/.test(row.webStreamData?.measurementId || '')) fail('provider_failed');
  let url;
  try { url = new URL(row.webStreamData.defaultUri); } catch { fail('provider_failed'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('provider_failed');
  return { name: row.name, type: row.type, webStreamData: {
    measurementId: row.webStreamData.measurementId, defaultUri: url.origin,
  } };
}
function project(raw, propertyName) {
  if (!raw || !Array.isArray(raw.dataStreams) || raw.dataStreams.length > MAX_STREAMS) fail('provider_failed');
  const seen = new Set();
  const dataStreams = raw.dataStreams.map(row => {
    const item = projectStream(row, propertyName);
    if (seen.has(row.name)) fail('provider_failed'); seen.add(row.name); return item;
  }).filter(Boolean);
  return { dataStreams };
}
async function read({ http, propertyName, token, signal }) {
  const rows = []; const cursors = new Set(); let next = null;
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ pageSize: '50' });
    if (next) query.set('pageToken', next);
    const raw = await http({ hostname: 'analyticsadmin.googleapis.com',
      path: `/v1beta/${propertyName}/dataStreams?${query}`, token, signal });
    if (!raw || raw.error || raw.dataStreams !== undefined && !Array.isArray(raw.dataStreams)) fail('provider_failed');
    rows.push(...(raw.dataStreams || []));
    if (rows.length > MAX_STREAMS) fail('provider_failed');
    next = raw.nextPageToken;
    if (next === undefined || next === '') return project({ dataStreams: rows }, propertyName);
    if (typeof next !== 'string' || next.length > 4096 || cursors.has(next)) fail('provider_failed');
    cursors.add(next);
  }
  fail('provider_failed');
}
module.exports = { OPERATION, project, read };
