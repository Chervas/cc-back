'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const registration = require('../../lib/registration-privacy-template');
const { CORRECTIONS, correctDraft } = require('../../lib/registration-privacy-spelling');
test('new drafts correct only the seven documented spelling errors and preserve decisions, legal facts and pinned source', () => {
  const original = registration.bsDraft(), bytes = JSON.stringify(original), corrected = correctDraft(original);
  assert.equal(JSON.stringify(original), bytes);
  let expected = original.body_html;
  for (const [from, to] of CORRECTIONS) { assert.equal(expected.split(from).length, 2, from); expected = expected.replace(from, to); }
  assert.equal(corrected.body_html, expected);
  assert.deepEqual(corrected.body_json.consent_form, original.body_json.consent_form);
  assert.equal(corrected.body_json.registration_privacy.source_document_sha256, original.body_json.registration_privacy.source_document_sha256);
  assert.notEqual(corrected.body_json.registration_privacy.orthographic_revision.original_html_sha256,
    corrected.body_json.registration_privacy.orthographic_revision.corrected_html_sha256);
  assert.deepEqual(correctDraft(corrected), corrected, 'Idempotent, including original provenance');
  assert.deepEqual(registration.bsDraft(), original);
});
