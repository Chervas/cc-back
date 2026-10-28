'use strict';

// Offline candidate only. No SQL, models, configuration, files, providers or env.
// Callers supply bytes plus an independently trusted descriptor. No records are
// returned before the entire stream, external SHA/length/count and schema pass.
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const HEADER_KEYS = ['version', 'siteUrl', 'startDate', 'endDate', 'revision'];
const ROW_KEYS = ['date', 'query_id', 'page_id', 'query', 'page_url', 'clicks',
  'impressions', 'position_weighted', 'position_sum', 'position_count', 'row_digest'];
const EXPECTED_KEYS = ['siteUrl', 'month', 'sha256', 'bytes', 'rows'];
const DEFAULT_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxLineBytes: 64 * 1024, maxRows: 50000, maxDictionaryBindings: 100000 });
const HARD_LIMITS = Object.freeze({ maxBytes: 1024 * 1024 * 1024, maxLineBytes: 128 * 1024, maxRows: 1000000, maxDictionaryBindings: 500000 });
const MAX_CHUNK_BYTES = 1024 * 1024;
const U64 = 18446744073709551615n;
const hash = value => createHash('sha256').update(value).digest('hex');

class ArchiveVerificationError extends Error {
  constructor(code) { super(code); this.name = 'ArchiveVerificationError'; this.code = code; }
}
const fail = code => { throw new ArchiveVerificationError(code); };
const need = (value, code) => { if (!value) fail(code); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Exact pure site() extraction from the pinned broker contract. No schema/Ajv
// or broker runtime dependency is loaded merely to validate this identifier.
function site(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\%?#]/.test(value)) fail('scope_denied');
  const domain = value.startsWith('sc-domain:') ? value.slice(10) : null;
  if (domain !== null) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail('scope_denied');
  } else {
    let url; try { url = new URL(value); } catch { fail('scope_denied'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.href !== value
      || !value.endsWith('/') || !/^\/[A-Za-z0-9/_~.-]*$/.test(url.pathname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) fail('scope_denied');
  }
  const siteHash = createHash('sha256').update(value).digest('hex');
  return { siteUrl: value, siteHash, assetRef: 'sc:' + siteHash, inspectionUrl: domain ? `https://${domain}/` : value };
}

function fullMonth(month) {
  need(typeof month === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month), 'sc_archive_expected_invalid');
  const year = Number(month.slice(0, 4)), number = Number(month.slice(5));
  return { startDate: month + '-01', endDate: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) };
}
function unsigned(value, positive = false) {
  need(typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value), 'sc_archive_integer_invalid');
  const n = BigInt(value);
  need(n <= U64 && (!positive || n > 0n), 'sc_archive_integer_invalid');
  return n;
}
function decimal(value) {
  // DECIMAL(38,9), exact database spelling, no Number/averaging conversion.
  need(typeof value === 'string' && /^(0|[1-9]\d{0,28})\.\d{9}$/.test(value), 'sc_archive_decimal_invalid');
}
function dimension(value, empty) {
  need(typeof value === 'string' && (empty || value.length > 0)
    && Buffer.byteLength(value) <= 8192 && !/[\x00-\x1f]/.test(value), 'sc_archive_dimension_invalid');
}
function descriptor(input, limits) {
  need(exact(input, EXPECTED_KEYS), 'sc_archive_expected_required');
  const e = { ...input };
  try { site(e.siteUrl); } catch { fail('sc_archive_expected_invalid'); }
  const bounds = fullMonth(e.month);
  need(typeof e.sha256 === 'string' && /^[a-f0-9]{64}$/.test(e.sha256)
    && Number.isSafeInteger(e.bytes) && e.bytes > 0 && e.bytes <= limits.maxBytes
    && Number.isSafeInteger(e.rows) && e.rows >= 0 && e.rows <= limits.maxRows, 'sc_archive_expected_invalid');
  return Object.freeze({ ...e, ...bounds });
}
function readLimits(input) {
  need(input && Object.getPrototypeOf(input) === Object.prototype
    && Object.keys(input).every(k => Object.hasOwn(DEFAULT_LIMITS, k)), 'sc_archive_limits_invalid');
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(limits)) need(Number.isSafeInteger(limits[key])
    && limits[key] >= (key === 'maxRows' ? 0 : 1) && limits[key] <= HARD_LIMITS[key], 'sc_archive_limits_invalid');
  return limits;
}

async function verifyArchive(source, expected, { limits: suppliedLimits = {}, collectRecords = false, stageRows = null } = {}) {
  need(collectRecords === true || collectRecords === false, 'sc_archive_options_invalid');
  const limits = readLimits(suppliedLimits), e = descriptor(expected, limits);
  need(!collectRecords || limits.maxBytes <= 256 * 1024 * 1024, 'sc_archive_collect_bound');
  need(source && typeof source[Symbol.asyncIterator] === 'function', 'sc_archive_byte_stream_required');
  const digest = createHash('sha256'), recordsDigest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0, rowCount = 0, header = null, previous = null, pending = Buffer.alloc(0);
  const records = collectRecords ? [] : null;
  let staged = [];
  const queryIds = new Map(), queryHashes = new Map(), pageIds = new Map(), pageHashes = new Map();
  function bind(ids, hashes, id, value) {
    const h = hash(value);
    need(!ids.has(id) || ids.get(id) === h, 'sc_archive_dictionary_conflict');
    need(!hashes.has(h) || hashes.get(h) === id, 'sc_archive_dictionary_conflict');
    ids.set(id, h); hashes.set(h, id);
    need(queryIds.size + pageIds.size <= limits.maxDictionaryBindings, 'sc_archive_dictionary_bound');
  }
  async function flush() {
    if (!staged.length) return;
    const batch = Object.freeze(staged); staged = [];
    try { await stageRows(batch); } catch { fail('sc_archive_staging_failed'); }
  }
  function line(raw) {
    need(raw.length > 0 && raw.length <= limits.maxLineBytes, 'sc_archive_line_bound');
    let text;
    try { text = decoder.decode(raw); } catch { fail('sc_archive_utf8_invalid'); }
    let value;
    try { value = JSON.parse(text); } catch { fail('sc_archive_json_invalid'); }
    // snapshot() emits JSON.stringify, with no BOM/CRLF/duplicate keys or alternate
    // number spelling. Enforce that format instead of accepting hidden duplicates.
    need(JSON.stringify(value) === text, 'sc_archive_noncanonical_json');
    if (!header) {
      need(exact(value, HEADER_KEYS) && value.version === 1 && value.siteUrl === e.siteUrl
        && value.startDate === e.startDate && value.endDate === e.endDate, 'sc_archive_header_mismatch');
      unsigned(value.revision);
      header = Object.freeze(value); return;
    }
    need(exact(value, ROW_KEYS), 'sc_archive_row_schema');
    need(typeof value.date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value.date)
      && Number.isFinite(Date.parse(value.date)) && new Date(value.date).toISOString().slice(0, 10) === value.date
      && value.date >= e.startDate && value.date <= e.endDate, 'sc_archive_date_invalid');
    const query = unsigned(value.query_id, true), page = unsigned(value.page_id, true);
    for (const k of ['clicks', 'impressions', 'position_count']) unsigned(value[k]);
    for (const k of ['position_weighted', 'position_sum']) decimal(value[k]);
    dimension(value.query, false); dimension(value.page_url, true);
    need(typeof value.row_digest === 'string' && /^[a-f0-9]{64}$/.test(value.row_digest), 'sc_archive_row_digest_invalid');
    const actual = hash(JSON.stringify([value.date, hash(value.query), hash(value.page_url), value.clicks,
      value.impressions, value.position_weighted, value.position_sum, value.position_count]));
    need(actual === value.row_digest, 'sc_archive_row_digest_mismatch');
    if (previous) need(value.date > previous.date || value.date === previous.date
      && (query > previous.query || query === previous.query && page > previous.page), 'sc_archive_order_or_duplicate');
    previous = { date: value.date, query, page };
    bind(queryIds, queryHashes, value.query_id, value.query);
    bind(pageIds, pageHashes, value.page_id, value.page_url);
    rowCount++;
    need(rowCount <= limits.maxRows && rowCount <= e.rows, 'sc_archive_row_bound');
    recordsDigest.update(JSON.stringify(ROW_KEYS.map(k => value[k])) + '\n');
    if (records || stageRows) Object.freeze(value);
    if (records) records.push(value);
    if (stageRows) staged.push(value);
  }
  try {
    for await (const chunk of source) {
      need(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array, 'sc_archive_byte_chunk_required');
      need(chunk.byteLength <= MAX_CHUNK_BYTES, 'sc_archive_chunk_bound');
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      bytes += buffer.length;
      need(bytes <= limits.maxBytes && bytes <= e.bytes, 'sc_archive_byte_bound');
      digest.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const end = buffer.indexOf(10, offset), stop = end === -1 ? buffer.length : end;
        need(pending.length + stop - offset <= limits.maxLineBytes, 'sc_archive_line_bound');
        if (end === -1) { pending = Buffer.concat([pending, buffer.subarray(offset)]); break; }
        const complete = pending.length ? Buffer.concat([pending, buffer.subarray(offset, end)]) : buffer.subarray(offset, end);
        line(complete); pending = Buffer.alloc(0); offset = end + 1;
        if (stageRows && staged.length === 250) await flush();
      }
    }
  } catch (error) {
    if (error instanceof ArchiveVerificationError) throw error;
    fail('sc_archive_source_failed');
  }
  need(pending.length === 0 && header !== null, 'sc_archive_final_newline_required');
  need(bytes === e.bytes && rowCount === e.rows, 'sc_archive_external_size_or_count_mismatch');
  const sha256 = digest.digest('hex');
  need(sha256 === e.sha256, 'sc_archive_external_digest_mismatch');
  if (stageRows) await flush();
  return Object.freeze({ schema: 'clinicaclick-sc-archive-verification/1', verified: true,
    siteUrl: e.siteUrl, month: e.month, header, bytes, rowCount, sha256, recordsSha256: recordsDigest.digest('hex'),
    ...(records ? { records: Object.freeze(records) } : {}) });
}

function verifySearchConsoleArchive(source, expected, { limits, collectRecords = false } = {}) {
  return verifyArchive(source, expected, { limits, collectRecords });
}
// Opt-in provisional staging only, intended for an uncommitted isolated scratch
// transaction after a first complete verification pass. The caller must discard
// staged data on ANY error; a callback never means an archive is verified.
function stageSearchConsoleArchive(source, expected, { onStagedRows, limits } = {}) {
  need(typeof onStagedRows === 'function', 'sc_archive_staging_required');
  return verifyArchive(source, expected, { limits, collectRecords: false, stageRows: onStagedRows });
}
module.exports = { verifySearchConsoleArchive, stageSearchConsoleArchive, ArchiveVerificationError, DEFAULT_LIMITS, HARD_LIMITS };
