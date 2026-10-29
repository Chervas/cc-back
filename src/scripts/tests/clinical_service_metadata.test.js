'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { voucherTreatmentIds, voucherMedicalAreas } = require('../../lib/clinical-service-metadata');

test('medical area lookup uses only the voucher and exact stored budget concept component ids', () => {
  const lines = [{ key: 'owned', area_code: 'general', program_snapshot: { appointments: [
    { treatment_ids: [7, 8, 7, null, -1, 'foreign'] }, { treatment_ids: ['9'] },
  ] } }, { key: 'other', treatment_id: 999, area_code: 'dental' }];
  const voucher = { budget_line_key: 'owned', treatment_id: 7 };
  assert.deepEqual(voucherTreatmentIds(voucher, lines), [7, 8, 9]);
  const areas = new Map([[7, ['capilar']], [8, ['estetica']], [9, ['capilar']], [999, ['dental']]]);
  assert.deepEqual(voucherMedicalAreas(voucher, lines, areas), ['capilar', 'estetica']);
  assert.deepEqual(voucherMedicalAreas({ budget_line_key: 'missing' }, lines, areas), []);
});
test('explicit stored medical area survives catalog edits; no treatment name or default label is evidence', () => {
  const voucher = { treatment_id: 7, budget_line_key: 'owned', name: 'PRP capilar' };
  assert.deepEqual(voucherMedicalAreas(voucher, [{ key: 'owned', area_code: 'dental' }], new Map([[7, ['estetica']]])), ['dental']);
  assert.deepEqual(voucherMedicalAreas({ name: 'PRP capilar' }), []);
  assert.deepEqual(voucherTreatmentIds({ program_snapshot: '{bad' }), []);
});
test('voucher serializer exposes the real creation date, without using latest movement or expiry', () => {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const file = require.resolve('../../services/patientEconomics.service'), local = createRequire(file);
  const source = fs.readFileSync(file, 'utf8'), start = source.indexOf('function serializeVoucher('), end = source.indexOf('\nfunction serializeFiscalDocument', start);
  const context = { require: local, numberValue: value => Number(value || 0), economicPrograms: { integrationCapabilities: () => ({ program_batch_booking: true }) } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.serialize = serializeVoucher;', context);
  const result = context.serialize({ public_id: 'owned', created_at: '2025-01-01T10:00:00Z', updated_at: '2026-10-29T10:00:00Z',
    expires_at: '2030-01-01T10:00:00Z', source_system: 'clinicaclick' }, [{ occurred_at: '2026-10-29T10:00:00Z' }], ['capilar']);
  assert.equal(result.created_at, '2025-01-01T10:00:00Z');
  assert.deepEqual(result.medical_areas, ['capilar']);
  assert.equal(context.serialize({ public_id: 'legacy', source_system: 'clinicaclick' }, []).created_at, null);
});

test('workspace bulk metadata lookup is limited to referenced treatments in the selected clinic, group or system', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const file = require.resolve('../../services/patientEconomics.service'), local = createRequire(file);
  const source = fs.readFileSync(file, 'utf8'), start = source.indexOf('async function getWorkspace(');
  const end = source.indexOf('\nmodule.exports', start);
  const Op = { in: Symbol('in'), or: Symbol('or') }, sentinel = new Error('stop_before_other_reads');
  const rows = values => ({ findAll: async () => values });
  const voucher = { id: 1, public_id: 'owned', clinic_id: 72, patient_id: 5, treatment_id: 7, budget_id: 10, budget_line_key: 'owned-line' };
  let query;
  const context = { require: local, Op,
    loadContext: async () => ({ clinicId: 72, patient: { id_paciente: 5 }, clinic: { id_clinica: 72, grupoClinicaId: 29 } }),
    EconomicBudget: rows([{ id: 10, current_version: 2 }]),
    EconomicBudgetVersion: rows([{ budget_id: 10, version_number: 1, lines: [{ key: 'owned-line', treatment_id: 99 }] },
      { budget_id: 10, version_number: 2, lines: [{ key: 'owned-line', program_snapshot: { appointments: [{ treatment_ids: [8, 9] }] } },
        { key: 'other-line', treatment_id: 100 }] }]),
    EconomicBudgetEvent: rows([]), EconomicBudgetSignatureRequest: rows([]), EconomicPayment: rows([]),
    PatientWalletEntry: rows([]), PatientVoucher: rows([voucher]), PatientFiscalDocument: rows([]),
    listTemplates: async () => [], parseJson: (value, fallback) => value == null ? fallback : typeof value === 'string' ? JSON.parse(value) : value,
    Tratamiento: { findAll: async value => { query = value; throw sentinel; } },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.workspace = getWorkspace;', context);
  await assert.rejects(context.workspace({ patientIdentifier: 5, clinicId: 72 }), error => error === sentinel);
  assert.deepEqual(JSON.parse(JSON.stringify(query.where.id_tratamiento[Op.in])), [7, 8, 9]);
  assert.deepEqual(JSON.parse(JSON.stringify(query.where[Op.or])), [
    { origen: 'clinica', clinica_id: 72 }, { origen: 'sistema' }, { origen: 'grupo', grupo_clinica_id: 29 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(query.attributes)), ['id_tratamiento', 'disciplina', 'clinical_config']);
});
