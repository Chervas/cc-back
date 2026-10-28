'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const helper = path.join(__dirname, '../../lib/searchConsoleArchiveVerifier.js');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (/^(?:node:)?(?:net|tls|http|https|http2|dns|child_process)$/.test(request)
    || /(?:sequelize|dotenv|@aws-sdk|(?:^|\/)models(?:\/|$))/.test(request)) throw Error('OFFLINE_FORBIDDEN');
  if (parent?.filename === helper && !['node:crypto', 'node:util'].includes(request)) throw Error('PARSER_DEPENDENCY_FORBIDDEN');
  return load.call(this, request, parent, isMain);
};
const { verifySearchConsoleArchive: verify } = require(helper);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sc_archive_verifier/manifest.json'), 'utf8'));
const body = fs.readFileSync(path.join(__dirname, 'fixtures/sc_archive_verifier/synthetic-v1.ndjson'));
const original = body.toString('utf8').trimEnd().split('\n').map(JSON.parse);
const expected = manifest.synthetic.expected;
const sha = b => createHash('sha256').update(b).digest('hex');
const external = (b, rows = original.length - 1) => ({ ...expected, sha256: sha(b), bytes: b.length, rows });
async function* chunks(b, pattern = [1, 2, 3, 7]) {
  let at = 0, i = 0;
  while (at < b.length) { const end = Math.min(at + pattern[i++ % pattern.length], b.length); yield b.subarray(at, end); at = end; }
}
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
const alter = change => { const rows = JSON.parse(JSON.stringify(original)); change(rows); return encode(rows); };
async function rejects(b, code, e = external(b), options) {
  await assert.rejects(verify(chunks(b), e, options), error => error.code === code);
}

test('public Python-authored file roundtrips exact records through real file read with byte-sized UTF8 chunks', async () => {
  const stream = fs.createReadStream(path.join(__dirname, 'fixtures/sc_archive_verifier/synthetic-v1.ndjson'), { highWaterMark: 1 });
  const result = await verify(stream, expected, { collectRecords: true });
  assert.deepEqual(result.records, manifest.synthetic.records);
  assert.equal(result.records[1].clicks, '9007199254740993');
  assert.equal(result.records[2].impressions, '0');
  assert.equal(result.records[2].position_sum, '4.000000000');
  assert.equal(result.records[2].position_count, '1');
  assert.notEqual(result.records[1].query, result.records[3].query); // NFD versus NFC preserved.
  assert.equal(result.sha256, expected.sha256); assert.equal(result.bytes, expected.bytes);
  assert.equal(stream.closed, true); assert(Object.isFrozen(result.records));
  for (const row of result.records) assert(Object.isFrozen(row));
});
test('verification-only result and header-only archive do not invent records or completeness', async () => {
  const result = await verify(chunks(body), expected);
  assert.equal(Object.hasOwn(result, 'records'), false);
  assert.equal(Object.hasOwn(result, 'coverageComplete'), false);
  const empty = fs.readFileSync(path.join(__dirname, 'fixtures/sc_archive_verifier/empty-v1.ndjson'));
  const zero = await verify(chunks(empty), manifest.empty.expected, { collectRecords: true });
  assert.deepEqual(zero.records, []); assert.equal(zero.rowCount, 0);
});
test('every external descriptor field is mandatory and never taken from a header', async () => {
  for (const key of ['siteUrl', 'month', 'sha256', 'bytes', 'rows']) {
    const e = { ...expected }; delete e[key];
    await assert.rejects(verify(chunks(body), e), { code: 'sc_archive_expected_required' });
  }
  for (const siteUrl of ['http://127.0.0.1/', 'https://EXAMPLE.com/', 'sc-domain:example.com/']) {
    await assert.rejects(verify(chunks(body), { ...expected, siteUrl }), { code: 'sc_archive_expected_invalid' });
  }
});
test('wrong property, month, schema and non-full-month header are rejected', async () => {
  await rejects(body, 'sc_archive_header_mismatch', { ...expected, siteUrl: 'sc-domain:other.example' });
  await rejects(body, 'sc_archive_header_mismatch', { ...expected, month: '2024-03' });
  for (const mutate of [h => { h.version = '1'; }, h => { h.extra = true; }, h => { h.startDate = '2024-02-02'; }]) {
    const b = alter(rows => mutate(rows[0])); await rejects(b, 'sc_archive_header_mismatch');
  }
});
test('changed metric and changed digest fail even with a freshly recalculated whole-file descriptor', async () => {
  await rejects(alter(rows => { rows[1].clicks = '2'; }), 'sc_archive_row_digest_mismatch');
  await rejects(alter(rows => { rows[1].row_digest = '0'.repeat(64); }), 'sc_archive_row_digest_mismatch');
  await rejects(alter(rows => { rows[1].row_digest = rows[1].row_digest.toUpperCase(); }), 'sc_archive_row_digest_invalid');
  await rejects(body, 'sc_archive_external_digest_mismatch', { ...expected, sha256: '0'.repeat(64) });
});
test('UInt64, IDs, decimal precision and type bounds are strict with no Number coercion', async () => {
  for (const [key, value, code] of [
    ['query_id', '0', 'sc_archive_integer_invalid'], ['page_id', '18446744073709551616', 'sc_archive_integer_invalid'],
    ['clicks', 1, 'sc_archive_integer_invalid'], ['impressions', '-1', 'sc_archive_integer_invalid'],
    ['position_count', '01', 'sc_archive_integer_invalid'], ['position_weighted', '1e3', 'sc_archive_decimal_invalid'],
    ['position_sum', '1.00000000', 'sc_archive_decimal_invalid'],
    ['position_sum', '100000000000000000000000000000.000000000', 'sc_archive_decimal_invalid']]) {
    await rejects(alter(rows => { rows[1][key] = value; }), code);
  }
});
test('date validity, range, numeric ID order and duplicate tuples are enforced', async () => {
  for (const date of ['2024-02-30', '2024-03-01']) await rejects(alter(rows => { rows[1].date = date; }), 'sc_archive_date_invalid');
  await rejects(alter(rows => { [rows[1], rows[2]] = [rows[2], rows[1]]; }), 'sc_archive_order_or_duplicate');
  const duplicate = encode([original[0], original[1], original[1]]);
  await rejects(duplicate, 'sc_archive_order_or_duplicate', external(duplicate, 2));
});
test('dictionary identities stay consistent across dates even though IDs are outside the row digest', async () => {
  await rejects(alter(rows => { rows[3].query_id = '10'; }), 'sc_archive_dictionary_conflict');
  await rejects(alter(rows => { rows[4].query_id = '12'; rows[4].page_id = '9'; }), 'sc_archive_dictionary_conflict');
});
test('dimensions are strict and legitimate worst-case escaping still fits the default line bound', async () => {
  for (const value of ['', 'x\u0000', 'x'.repeat(8193)]) {
    await rejects(alter(rows => { rows[1].query = value; }), 'sc_archive_dimension_invalid');
  }
  const row = { ...original[1], query: '"'.repeat(8192), page_url: '\\'.repeat(8192) };
  row.row_digest = sha(JSON.stringify([row.date, sha(row.query), sha(row.page_url), row.clicks,
    row.impressions, row.position_weighted, row.position_sum, row.position_count]));
  const large = encode([original[0], row]);
  assert(large.length > 32768);
  const result = await verify(chunks(large, [512]), external(large, 1), { collectRecords: true });
  assert.equal(result.records[0].query, row.query); assert.equal(result.records[0].page_url, row.page_url);
});
test('invalid UTF8, incomplete multibyte, JSON, BOM and duplicate keys fail closed', async () => {
  const invalid = Buffer.concat([body.subarray(0, body.length - 1), Buffer.from([0xff, 0x0a])]);
  await rejects(invalid, 'sc_archive_utf8_invalid');
  const incomplete = Buffer.concat([body.subarray(0, body.indexOf(10) + 1), Buffer.from([0xe2, 0x82, 0x0a])]);
  await rejects(incomplete, 'sc_archive_utf8_invalid', external(incomplete, 0));
  const broken = Buffer.from('{\n'); await rejects(broken, 'sc_archive_json_invalid', external(broken, 0));
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]); await rejects(bom, 'sc_archive_json_invalid');
  const duplicate = Buffer.from(body.toString().replace('"version":1', '"version":1,"version":1'));
  await rejects(duplicate, 'sc_archive_noncanonical_json');
});
test('LF, CRLF and truncation are not silently normalized', async () => {
  const noLf = body.subarray(0, body.length - 1);
  await rejects(noLf, 'sc_archive_final_newline_required', external(noLf));
  const blank = Buffer.concat([body, Buffer.from('\n')]); await rejects(blank, 'sc_archive_line_bound');
  const crlf = Buffer.from(body.toString().replace(/\n/g, '\r\n')); await rejects(crlf, 'sc_archive_noncanonical_json');
});
test('row, byte, line, chunk and option budgets enforce the actual consumed stream', async () => {
  await rejects(body, 'sc_archive_byte_bound', { ...expected, bytes: expected.bytes - 1 });
  await rejects(body, 'sc_archive_external_size_or_count_mismatch', { ...expected, bytes: expected.bytes + 1 });
  await rejects(body, 'sc_archive_row_bound', { ...expected, rows: expected.rows - 1 });
  await rejects(body, 'sc_archive_external_size_or_count_mismatch', { ...expected, rows: expected.rows + 1 });
  await rejects(body, 'sc_archive_line_bound', expected, { limits: { maxLineBytes: 32 } });
  await rejects(body, 'sc_archive_expected_invalid', expected, { limits: { maxBytes: 10 } });
  await rejects(body, 'sc_archive_limits_invalid', expected, { limits: { maxBytes: 1024 * 1024 * 1024 + 1 } });
  async function* huge() { yield Buffer.alloc(1024 * 1024 + 1); }
  await assert.rejects(verify(huge(), expected), { code: 'sc_archive_chunk_bound' });
});
test('source failure and wrong chunk types expose fixed codes and close iterators', async () => {
  let closed = false;
  async function* wrong() { try { yield 'text'; } finally { closed = true; } }
  await assert.rejects(verify(wrong(), expected), { code: 'sc_archive_byte_chunk_required' }); assert.equal(closed, true);
  async function* broken() { throw Error('SYNTHETIC_PRIVATE_MESSAGE_DO_NOT_EXPOSE'); }
  await assert.rejects(verify(broken(), expected), error => error.code === 'sc_archive_source_failed'
    && !error.message.includes('PRIVATE') && !Object.hasOwn(error, 'cause'));
  assert.equal(Object.keys(require.cache).some(p => /\/models\/index\.js$/.test(p)), false);
});
