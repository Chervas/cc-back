'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/clinical-episode-contract');
const delta = text => ({ ops: [{ insert: text + '\n', attributes: { bold: true } }] });

test('safe native Quill Delta preserves bold, italic, lists and clinical Unicode', () => {
  const input = { ops: [{ insert: 'Evolución favorable', attributes: { bold: true, italic: true } },
    { insert: '\n', attributes: { list: 'bullet' } }] };
  assert.deepEqual(C.safeDocument(input), input);
  const patch = C.normalizePatch({ rich_document: { version: 1, sections: { summary: input } } });
  assert.equal(patch.summary, 'Evolución favorable');
  assert.deepEqual(patch.rich_document.sections.summary, input);
});
for (const [name, value] of [
  ['embed', { ops: [{ insert: { image: 'https://untrusted.example/photo' } }] }],
  ['retains', { ops: [{ retain: 10 }] }], ['delete', { ops: [{ delete: 10 }] }],
  ['html', { ops: [{ insert: 'hello', attributes: { html: '<script>' } }] }],
  ['links', { ops: [{ insert: 'x', attributes: { link: 'javascript:alert(1)' } }] }],
  ['unknown format', { ops: [{ insert: 'x', attributes: { color: '#000' } }] }],
  ['false format', { ops: [{ insert: 'x', attributes: { bold: false } }] }],
  ['unknown list', { ops: [{ insert: '\n', attributes: { list: 'checked' } }] }],
  ['null character', { ops: [{ insert: 'x\0' }] }], ['unknown schema', { type: 'doc', content: [] }],
]) test('document rejects ' + name, () => assert.throws(() => C.safeDocument(value), { code: 'clinical_episode_invalid_document' }));

test('plain legacy edits replace only changed section and preserve other rich formatting', () => {
  const row = { summary: 'Anterior', plan: 'Revisión', rich_document: { version: 1, sections: { summary: delta('Anterior'), plan: delta('Revisión') } } };
  const patch = C.normalizePatch({ summary: 'Nuevo' }, row, { legacy: true });
  assert.equal(patch.summary, 'Nuevo'); assert.equal(Object.hasOwn(patch, 'plan'), false);
  assert.deepEqual(patch.rich_document.sections.summary, C.plainDocument('Nuevo'));
  assert.deepEqual(patch.rich_document.sections.plan, row.rich_document.sections.plan);
  assert.equal(C.normalizePatch({ summary: 'Anterior' }, row).rich_document, undefined);
});

test('text and Delta must agree; partial rich updates leave other eight fields alone', () => {
  assert.throws(() => C.normalizePatch({ summary: 'Otro', rich_document: { version: 1, sections: { summary: delta('Texto') } } }), { code: 'clinical_episode_document_conflict' });
  const patch = C.normalizePatch({ summary: ' Texto ', rich_document: { version: 1, sections: { summary: delta('Texto') } } });
  assert.equal(patch.summary, 'Texto'); assert.equal(Object.hasOwn(patch, 'private_notes'), false);
  assert.throws(() => C.normalizePatch({ rich_document: { version: 1, sections: { arbitrary: delta('text') } } }), { code: 'clinical_episode_invalid_document' });
});

test('clinical metadata and links are explicit and bounded without silent coercion', () => {
  const patch = C.normalizePatch({ title: ' Consulta ', occurred_at: '2026-10-20T10:00:00+02:00', template_key: 'capilar', appointment_ids: [2, 1] });
  assert.equal(patch.occurred_at, '2026-10-20T08:00:00.000Z'); assert.deepEqual(patch.appointment_ids, [2, 1]);
  for (const value of [true, null, [], {}, '12x', '0', 0, -1, 1.2]) assert.throws(() => C.integer(value), { code: 'clinical_episode_invalid_identifier' });
  assert.throws(() => C.appointmentIds([1, 1]), { code: 'clinical_episode_duplicate_appointment' });
  assert.throws(() => C.normalizePatch({ occurred_at: '2026-10-20' }), { code: 'clinical_episode_invalid_date' });
  assert.throws(() => C.normalizePatch({ template_key: 'dental' }), { code: 'clinical_episode_invalid_template' });
  assert.throws(() => C.normalizePatch({ summary: 'x'.repeat(20001) }), { code: 'clinical_episode_invalid_text' });
});

test('cursor rejects malformed input and never evaluates caller text', () => {
  const value = { scope: 'owned-scope', id: 123, date: '2026-10-20T10:00:00.000Z' };
  assert.deepEqual(C.decodeCursor(C.encodeCursor(value)), value);
  for (const cursor of ['<script>', 'abc', 'W10', 'x'.repeat(401)]) assert.throws(() => C.decodeCursor(cursor), { code: 'clinical_episode_invalid_cursor' });
});
