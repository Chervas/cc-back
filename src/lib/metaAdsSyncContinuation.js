'use strict';

const { createHash } = require('node:crypto');
const TYPES = new Set(['meta_ads_recent', 'meta_ads_midday', 'meta_ads_backfill']);
const contexts = new WeakMap();
const KEY = 'metaAdsContinuation';
const MAX_ACCOUNTS = 1000, MAX_DAYS = 3660;
const BUSY = 'oauth_flow_busy', MIN_WAIT_MS = 60000, MAX_BUSY_ATTEMPTS = 3;
const fail = () => { throw Object.assign(Error('meta_ads_continuation_invalid'), { code: 'meta_ads_continuation_invalid' }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const positive = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value))
  && Number(value) <= 2147483647;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const at = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) fail();
  return at;
}
function window(value) {
  if (!exact(value, 'mappingId,startDate,endDate') || !positive(value.mappingId)) fail();
  const span = (day(value.endDate) - day(value.startDate)) / 86400000 + 1;
  if (span < 1 || span > MAX_DAYS) fail();
  return { mappingId: Number(value.mappingId), startDate: value.startDate, endDate: value.endDate };
}
function calendarEnd({ now = Date.now(), timeZone = 'Europe/Madrid', includeToday = false } = {}) {
  const text = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const date = new Date(day(text));
  if (!includeToday) date.setUTCDate(date.getUTCDate() - 1);
  return date;
}
function account(value) {
  const accountId = String(value.metaAssetId || '').replace(/^act_/, '');
  if (!positive(value.id) || !positive(value.metaConnectionId) || !/^[1-9]\d{0,29}$/.test(accountId)) fail();
  const clinicId = value.clinicaId == null ? null : Number(value.clinicaId);
  const groupId = value.grupoClinicaId == null ? null : Number(value.grupoClinicaId);
  if (clinicId !== null && !positive(clinicId) || groupId !== null && !positive(groupId)) fail();
  const scope = value.assignmentScope || (clinicId !== null ? 'clinic' : 'group');
  if (!['clinic', 'group'].includes(scope) || scope === 'clinic' && clinicId === null || scope === 'group' && groupId === null) fail();
  return [Number(value.id), Number(value.metaConnectionId), accountId,
    scope, clinicId, groupId];
}
const accountDigest = value => digest(account(value));
const filters = values => values === undefined ? null : [...new Set(values.map(Number))].sort((a, b) => a - b);
function contextForJob(job, now = Date.now()) {
  if (!job || !TYPES.has(job.type) || !positive(job.id)) fail();
  let summary = job.result_summary;
  if (typeof summary === 'string') {
    if (summary.length > 1048576) fail();
    try { summary = JSON.parse(summary); } catch { fail(); }
  }
  // This reference never enters a queue payload. Only the scheduler's persisted
  // result column is copied; request body/options cannot manufacture a resume.
  let previous = summary && typeof summary === 'object' && Object.hasOwn(summary, KEY) ? structuredClone(summary[KEY]) : null;
  // Manual retry repurposes the same row and retains its terminal summary.
  // A terminal result is never continuation authority: start all work afresh.
  if (previous !== null && ['completed', 'failed'].includes(summary.status)) previous = null;
  if (summary?.status === 'waiting' && summary.reason === BUSY && previous === null) fail();
  if (previous !== null && (job.status !== 'running' || !Number.isSafeInteger(Number(job.attempts)) || Number(job.attempts) < 2
    || summary.status !== 'waiting' || !['rate_limited', BUSY].includes(summary.reason) || !Number.isFinite(+new Date(job.next_run_at))
    || +new Date(job.next_run_at) !== +new Date(summary.nextAllowedAt) || +new Date(job.next_run_at) > now)) fail();
  // Explicit scheduler waits do not consult its normal failure retry budget.
  // Bound contention retries to actual durable claims and the smaller limit.
  const busyCanWait = job.status === 'running' && positive(job.attempts) && positive(job.max_attempts)
    && Number(job.attempts) < Math.min(Number(job.max_attempts), MAX_BUSY_ATTEMPTS);
  const context = Object.freeze({});
  contexts.set(context, { jobId: Number(job.id), type: job.type,
    previous, busyCanWait });
  return context;
}
function createRun({ context, type, options, adsConfig, assets }) {
  if (!TYPES.has(type) || !Array.isArray(assets) || assets.length > MAX_ACCOUNTS) fail();
  const cohort = assets.map(account).sort((a, b) => a[0] - b[0]);
  if (new Set(cohort.map(row => row[0])).size !== cohort.length) fail();
  const requestDigest = digest([type, filters(options.clinicIds), filters(options.groupIds),
    options.startDate ?? null, options.endDate ?? null, options.windowDays ?? options.days ?? null,
    options.windowLabel ?? 'default', adsConfig.initialDays, adsConfig.recentDays, adsConfig.middayDays, adsConfig.backfillDays,
    adsConfig.timeZone || 'Europe/Madrid']);
  const cohortDigest = digest(cohort);
  const checksum = value => digest([value.version, value.jobId, value.type, value.requestDigest, value.cohortDigest,
    value.windows.map(row => [row.mappingId, row.startDate, row.endDate]), value.completedMappingIds]);
  const issued = context === undefined ? null : contexts.get(context);
  if (context !== undefined && (!issued || issued.type !== type)) fail();
  const previous = issued?.previous;
  let value = null;
  if (previous !== null && previous !== undefined) {
    if (!exact(previous, 'version,jobId,type,requestDigest,cohortDigest,windows,completedMappingIds,checksum') || previous.version !== 1
      || previous.jobId !== issued.jobId || previous.type !== type || previous.requestDigest !== requestDigest
      || previous.cohortDigest !== cohortDigest || !Array.isArray(previous.windows)
      || previous.windows.length !== cohort.length || !Array.isArray(previous.completedMappingIds)
      || previous.completedMappingIds.length > cohort.length) fail();
    const windows = previous.windows.map(window), expectedIds = cohort.map(row => row[0]);
    if (JSON.stringify(windows.map(row => row.mappingId)) !== JSON.stringify(expectedIds)
      || previous.completedMappingIds.some((id, i) => !Number.isInteger(id) || !expectedIds.includes(id)
        || i > 0 && id <= previous.completedMappingIds[i - 1]) || previous.checksum !== checksum({ ...previous, windows })) fail();
    value = { ...previous, windows };
  }
  const completed = new Set(value?.completedMappingIds || []);
  return {
    get windows() { return value?.windows || null; },
    initialize(windows) {
      if (value) return;
      const normalized = windows.map(window).sort((a, b) => a.mappingId - b.mappingId);
      if (normalized.length !== cohort.length || normalized.some((row, i) => row.mappingId !== cohort[i][0])) fail();
      value = { version: 1, jobId: issued?.jobId ?? null, type, requestDigest, cohortDigest,
        windows: normalized, completedMappingIds: [] };
    },
    windowFor(id) { const row = value?.windows.find(row => row.mappingId === Number(id)); if (!row) fail(); return row; },
    isCompleted(id) { return completed.has(Number(id)); },
    complete(id) { if (!cohort.some(row => row[0] === Number(id))) fail(); completed.add(Number(id)); },
    waitUntil(error, now) {
      let delay;
      if (error.code === 'rate_limited') delay = Math.max(MIN_WAIT_MS, error.retryAfterMs || 2 * 60 * 60 * 1000);
      else if (error.code === BUSY && issued?.busyCanWait) delay = MIN_WAIT_MS;
      else return null;
      // JobRequests stores seconds. Round up to avoid shortening any pause.
      return new Date(Math.ceil((now + delay) / 1000) * 1000);
    },
    result() {
      if (!issued) return {};
      const snapshot = { ...value, completedMappingIds: [...completed].sort((a, b) => a - b) };
      return { [KEY]: { ...snapshot, checksum: checksum(snapshot) } };
    },
  };
}
module.exports = { TYPES, KEY, MAX_ACCOUNTS, MAX_DAYS, contextForJob, createRun, accountDigest, calendarEnd };
