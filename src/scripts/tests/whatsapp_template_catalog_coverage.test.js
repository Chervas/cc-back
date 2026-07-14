'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWhatsappTemplateCatalogCoverage,
} = require('../../lib/whatsapp-template-catalog-coverage');

const BASE_NAME = 'clinicaclick_recordatorio_acceso';
const CURRENT_BODY = 'Hola {{1}}, estas son las indicaciones actuales.';
const OLD_BODY = 'Hola {{1}}, estas son las indicaciones antiguas.';

function catalog(overrides = {}) {
  return {
    id: 39,
    name: BASE_NAME,
    category: 'UTILITY',
    components: [{ type: 'BODY', text: CURRENT_BODY }],
    is_generic: true,
    disciplinas: [],
    ...overrides,
  };
}

function clinic(id, groupId, overrides = {}) {
  return {
    id_clinica: id,
    nombre_clinica: `Clínica ${id}`,
    grupoClinicaId: groupId,
    configuracion: { disciplinas: ['dental'] },
    ...overrides,
  };
}

function groupAsset(id, groupId, wabaId, overrides = {}) {
  return {
    id,
    clinicaId: null,
    grupoClinicaId: groupId,
    assignmentScope: 'group',
    assetType: 'whatsapp_phone_number',
    wabaId,
    phoneNumberId: `phone-${wabaId}`,
    waAccessToken: `token-${wabaId}`,
    isActive: true,
    updatedAt: `2026-07-${String(id).padStart(2, '0')}T00:00:00.000Z`,
    ...overrides,
  };
}

function clinicAsset(id, clinicId, wabaId, overrides = {}) {
  return {
    ...groupAsset(id, null, wabaId),
    clinicaId: clinicId,
    grupoClinicaId: null,
    assignmentScope: 'clinic',
    ...overrides,
  };
}

function remoteTemplate(id, wabaId, name, status, body = CURRENT_BODY, overrides = {}) {
  return {
    id,
    catalog_template_id: 39,
    waba_id: wabaId,
    clinic_id: null,
    name,
    category: 'UTILITY',
    components: [{ type: 'BODY', text: body }],
    status,
    meta_template_id: `meta-${id}`,
    updatedAt: `2026-07-${String(id).padStart(2, '0')}T00:00:00.000Z`,
    ...overrides,
  };
}

test('no usa el máximo técnico global: exige contrato aprobado en cada WABA efectiva', () => {
  const coverage = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog(),
    clinics: [clinic(10, 1), clinic(20, 2)],
    assets: [groupAsset(1, 1, 'waba-a'), groupAsset(2, 2, 'waba-b')],
    familyRows: [
      remoteTemplate(8, 'waba-a', `${BASE_NAME}_v8`, 'APPROVED'),
      remoteTemplate(2, 'waba-b', `${BASE_NAME}_v2`, 'PENDING'),
      remoteTemplate(1, 'waba-b', BASE_NAME, 'APPROVED', OLD_BODY),
    ],
  });

  assert.equal(coverage.approved_by_coverage, false);
  assert.equal(coverage.approved_count, 1);
  assert.equal(coverage.approved_total, 2);
  assert.deepEqual(coverage.applicable_waba_ids, ['waba-a', 'waba-b']);
  assert.deepEqual(coverage.unapproved_clinics, [{
    clinic_id: 20,
    clinic_name: 'Clínica 20',
    waba_id: 'waba-b',
    status: 'PENDING',
  }]);
});

test('acepta versiones técnicas diferentes cuando cada WABA tiene el contrato vigente aprobado', () => {
  const coverage = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog(),
    clinics: [clinic(10, 1), clinic(20, 2)],
    assets: [groupAsset(1, 1, 'waba-a'), groupAsset(2, 2, 'waba-b')],
    familyRows: [
      remoteTemplate(8, 'waba-a', `${BASE_NAME}_v8`, 'APPROVED'),
      remoteTemplate(2, 'waba-b', `${BASE_NAME}_v2`, 'APPROVED'),
    ],
  });

  assert.equal(coverage.approved_by_coverage, true);
  assert.equal(coverage.approved_count, 2);
  assert.equal(coverage.approved_total, 2);
  assert.deepEqual(coverage.unapproved_clinics, []);
});

test('un APPROVED de la familia con cuerpo antiguo no acredita el contrato actual', () => {
  const coverage = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog(),
    clinics: [clinic(10, 1)],
    assets: [groupAsset(1, 1, 'waba-a')],
    familyRows: [
      remoteTemplate(9, 'waba-a', `${BASE_NAME}_v9`, 'APPROVED', OLD_BODY),
    ],
  });

  assert.equal(coverage.approved_by_coverage, false);
  assert.equal(coverage.approved_count, 0);
  assert.equal(coverage.approved_total, 1);
  assert.equal(coverage.unapproved_clinics[0].status, 'DESACTUALIZADA');
});

test('deduplica clínicas que comparten WABA y respeta el WABA efectivo más específico', () => {
  const coverage = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog(),
    clinics: [clinic(10, 1), clinic(11, 1)],
    assets: [
      groupAsset(1, 1, 'waba-shared'),
      clinicAsset(2, 10, 'waba-clinic-10'),
    ],
    familyRows: [
      remoteTemplate(1, 'waba-shared', BASE_NAME, 'APPROVED'),
      remoteTemplate(2, 'waba-clinic-10', `${BASE_NAME}_v2`, 'PENDING'),
    ],
  });

  assert.equal(coverage.approved_by_coverage, false);
  assert.equal(coverage.approved_count, 1);
  assert.equal(coverage.approved_total, 2);
  assert.deepEqual(coverage.unapproved_clinics.map((entry) => entry.clinic_id), [10]);

  const sharedOnly = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog(),
    clinics: [clinic(10, 1), clinic(11, 1)],
    assets: [groupAsset(1, 1, 'waba-shared')],
    familyRows: [remoteTemplate(1, 'waba-shared', BASE_NAME, 'APPROVED')],
  });
  assert.equal(sharedOnly.approved_by_coverage, true);
  assert.equal(sharedOnly.approved_count, 1);
  assert.equal(sharedOnly.approved_total, 1);
});

test('solo incluye clínicas donde aplica el catálogo y con credenciales WhatsApp efectivas', () => {
  const coverage = buildWhatsappTemplateCatalogCoverage({
    catalog: catalog({
      is_generic: false,
      disciplinas: [{ disciplina_code: 'capilar' }],
    }),
    clinics: [
      clinic(10, 1, { configuracion: { disciplinas: ['capilar'] } }),
      clinic(20, 2, { configuracion: { disciplinas: ['dental'] } }),
      clinic(30, 3, { configuracion: { disciplinas: ['capilar'] } }),
    ],
    assets: [
      groupAsset(1, 1, 'waba-capilar'),
      groupAsset(2, 2, 'waba-dental'),
      groupAsset(3, 3, 'waba-no-token', { waAccessToken: '' }),
    ],
    familyRows: [
      remoteTemplate(1, 'waba-capilar', BASE_NAME, 'APPROVED'),
      remoteTemplate(2, 'waba-dental', `${BASE_NAME}_v2`, 'PENDING'),
    ],
  });

  assert.equal(coverage.approved_by_coverage, true);
  assert.equal(coverage.approved_count, 1);
  assert.equal(coverage.approved_total, 1);
  assert.deepEqual(coverage.applicable_waba_ids, ['waba-capilar']);
});
