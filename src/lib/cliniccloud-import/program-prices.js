'use strict';

// Closed documentary price update. The owner's approval to bring forward the
// October tariff is NOT clinical approval, tax classification or activation.
const assert = require('node:assert/strict');
const { hash } = require('./adapter');
const { normalizeValues, payloadHash } = require('../treatmentPrograms.contract');
const corporal = require('./corporal-program-drafts');
const capillary = require('./capillary-program-drafts');
const obesity = require('./obesity-program-drafts');

const VERSION = 'cliniccloud-program-prices/1';
const AUTHORIZATION = 'apply_documented_october_gross_prices_now';
const SOURCES = Object.freeze({ ...corporal.SOURCES, [capillary.PDF_NAME]: capillary.PDF_SHA256, ...obesity.SOURCES });
const SPECS = [
  ...corporal.SPECS.map(s => ({ ...s, family: 'corporal', clinic: 72, importVersion: corporal.VERSION })),
  ...capillary.SPECS.map(s => ({ ...s, family: 'capillary', clinic: 66, importVersion: capillary.VERSION,
    count: s.blocks.reduce((n, [, count]) => n + count, 2) })),
  ...obesity.SPECS.map(s => ({ ...s, family: 'obesity', clinic: 72, importVersion: obesity.VERSION })),
];
const APPLIED_NOTE = 'Precio final incorporado por autorización del titular para adelantar la tarifa de octubre de 2026. La fiscalidad y la activación clínica siguen pendientes.';

function replaceOnce(text, previous, next) {
  assert.equal(text.split(previous).length, 2, 'PROGRAM_PRICE_NOTE_CHANGED');
  return text.replace(previous, next);
}
function revisedNotes(notes, spec) {
  assert.equal(typeof notes, 'string', 'PROGRAM_PRICE_NOTE_MISSING');
  const old = {
    corporal: 'Tarifa desde 01/10/2026: no aplicada al precio comercial; confirmar vigencia y fiscalidad.',
    capillary: 'No aplicada al precio de venta; revisar vigencia y fiscalidad antes de activar.',
    obesity: 'Vigencia desde 01/10/2026; no aplicado al precio comercial.',
  }[spec.family];
  let result = replaceOnce(notes, old, APPLIED_NOTE);
  if (spec.family === 'obesity') result = replaceOnce(result, 'consentimientos, precio vigente y fiscalidad.', 'consentimientos y fiscalidad.');
  // Keep conditional reductions (surgery / completed Arranque), clinical
  // restrictions, variant links and human additions exactly as they were.
  return result;
}
function prepare({ programs, clinics, sourceHashes, authorization }) {
  assert.equal(authorization, AUTHORIZATION, 'PROGRAM_PRICE_EARLY_AUTHORIZATION_REQUIRED');
  assert.equal(hash(sourceHashes), hash(SOURCES), 'PROGRAM_PRICE_SOURCE_CHANGED');
  for (const id of [66, 72]) assert.equal(clinics.filter(c => c.id_clinica === id && c.grupoClinicaId === 29).length, 1, 'PROGRAM_PRICE_SCOPE_CHANGED');
  const operations = SPECS.map(spec => {
    const key = payloadHash([spec.clinic, `${spec.importVersion}:${spec.code}`]);
    const rows = programs.filter(p => p.request_key === key);
    assert.equal(rows.length, 1, 'PROGRAM_PRICE_IDENTITY_NOT_UNIQUE');
    const before = structuredClone(rows[0]);
    assert.equal(before.clinic_id, spec.clinic, 'PROGRAM_PRICE_SCOPE_CHANGED');
    assert.equal(before.name, spec.name, 'PROGRAM_PRICE_IDENTITY_CHANGED');
    assert.equal(before.kind, 'program');
    assert.equal(before.status, 'draft', 'PROGRAM_PRICE_DRAFT_REQUIRED');
    assert.equal(before.total_price, null, 'PROGRAM_PRICE_EXISTING_PRICE_REQUIRES_REVIEW');
    assert(Number.isSafeInteger(before.version_number) && before.version_number > 0);
    assert.equal(before.appointments.length, spec.count, 'PROGRAM_PRICE_COMPOSITION_CHANGED');
    const familySources = spec.family === 'corporal' ? corporal.SOURCES : spec.family === 'obesity' ? obesity.SOURCES : { [capillary.PDF_NAME]: capillary.PDF_SHA256 };
    for (const sha of Object.values(familySources)) assert(before.notes?.includes(sha), 'PROGRAM_PRICE_PROVENANCE_MISSING');
    const payload = { expected_version: before.version_number, total_price: spec.price, notes: revisedNotes(before.notes, spec) };
    const after = normalizeValues(payload, { current: before });
    assert.equal(hash({ ...after, total_price: null, notes: before.notes }), hash(normalizeValues(before)), 'PROGRAM_PRICE_UNRELATED_CHANGE');
    return { code: spec.code, clinic_id: spec.clinic, source_gross_price: spec.price,
      before, before_sha256: hash(before), payload, after_values_sha256: hash(after) };
  });
  assert.equal(operations.length, 23);
  const body = { version: VERSION, source_hashes: SOURCES, authorization, source_effective_date: '2026-10-01',
    clinics, operations, policy: { draft_only: true, tax_classification_changed: false, treatments_changed: false,
      existing_purchases_changed: false, appointments_changed: false, clinical_approval: false, reminders_activated: false } };
  return { ...body, package_sha256: hash(body) };
}
function verifyPackage(pkg) {
  assert.equal(hash(pkg), hash(prepare({ programs: pkg.operations.map(op => op.before), clinics: pkg.clinics,
    sourceHashes: pkg.source_hashes, authorization: pkg.authorization })), 'PROGRAM_PRICE_PACKAGE_CHANGED');
}
function timestamp(value) {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value)) value = value.replace(' ', 'T') + 'Z';
  const n = new Date(value).getTime();
  assert(Number.isFinite(n), 'PROGRAM_PRICE_TIMESTAMP_INVALID');
  return n;
}
function classifyRow(row, op) {
  assert(row, 'PROGRAM_PRICE_ROW_MISSING');
  if (hash(row) === op.before_sha256) return 'before';
  assert.equal(row.version_number, op.before.version_number + 1, 'PROGRAM_PRICE_VERSION_CHANGED');
  assert.equal(hash(normalizeValues(row)), op.after_values_sha256, 'PROGRAM_PRICE_VALUES_CHANGED');
  const stable = r => {
    const { version_number, total_price, notes, updated_by, updated_at, ...rest } = r;
    if (rest.created_at != null) rest.created_at = timestamp(rest.created_at);
    return rest;
  };
  assert.equal(hash(stable(row)), hash(stable(op.before)), 'PROGRAM_PRICE_METADATA_CHANGED');
  assert(Number.isSafeInteger(row.updated_by) && row.updated_by > 0, 'PROGRAM_PRICE_ACTOR_MISSING');
  assert(timestamp(row.updated_at) >= timestamp(op.before.updated_at), 'PROGRAM_PRICE_TIMESTAMP_CHANGED');
  return 'applied';
}
function verifyState({ programs, revisions }, pkg, { complete = false } = {}) {
  const counts = { before: 0, applied: 0 };
  for (const op of pkg.operations) {
    const rows = programs.filter(p => p.id === op.before.id);
    assert.equal(rows.length, 1, 'PROGRAM_PRICE_ROW_NOT_UNIQUE');
    const state = classifyRow(rows[0], op);
    counts[state]++;
    const later = revisions.filter(r => r.program_id === op.before.id && r.version_number > op.before.version_number);
    assert.equal(later.length, state === 'applied' ? 1 : 0, 'PROGRAM_PRICE_REVISION_CHANGED');
    if (state === 'applied') {
      assert.equal(later[0].version_number, rows[0].version_number);
      assert.equal(classifyRow(later[0].snapshot, op), 'applied');
      assert.equal(later[0].actor_id, rows[0].updated_by);
      assert.equal(later[0].snapshot.updated_by, rows[0].updated_by);
    }
  }
  if (complete) assert.equal(counts.before, 0, 'PROGRAM_PRICE_INCOMPLETE');
  return counts;
}
module.exports = { VERSION, AUTHORIZATION, SOURCES, SPECS, APPLIED_NOTE, revisedNotes, prepare, verifyPackage, classifyRow, verifyState };
