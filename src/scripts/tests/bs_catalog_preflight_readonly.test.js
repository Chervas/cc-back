'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { WORKBOOK_SHA } = require('../../lib/cliniccloud-import/catalog-matrix');
const { VERSION, SUPPORTED_VERSIONS, QUERIES, LIMITS, checkedMatrix, captureCatalog, reconcileCatalog } = require('../../lib/cliniccloud-import/catalog-preflight');

function matrix() {
    const rows = Array.from({ length: 167 }, (_, index) => {
        const key = hash(['fixture', index]);
        return { record_type: 'concept', kind: 'treatment', matrix_key: key,
            code: `BS26-${key.slice(0, 20)}`, clinic: index % 2 ? 'BS Capilar' : 'BS Medical', name: `Ficticio ${index}`,
            source_references_json: JSON.stringify([{ file_sha256: WORKBOOK_SHA, sheet: 'Ficticio', source_row: index + 2, row_sha256: hash(['row', index]) }]),
            pending_json: '[]' };
    });
    while (rows.length < 895) rows.push({ record_type: 'source_manifest', matrix_key: hash(['manifest', rows.length]) });
    return rows;
}
function treatment(row, changes = {}) {
    return { id_tratamiento: 100, codigo: row.code, clinica_id: row.clinic === 'BS Capilar' ? 66 : 72,
        nombre: row.name, activo: 1, clinical_config: { source_catalog_key: row.matrix_key,
            source_catalog: JSON.parse(row.source_references_json)[0], catalog_status: 'active', booking_profile: { version: 3 } }, ...changes };
}

test('fixed inventory reads no patient rows, appointment notes or mutation SQL', () => {
    for (const sql of Object.values(QUERIES)) {
        assert.match(sql, /^SELECT /);
        assert.match(sql, / LIMIT \d+$/);
        assert.doesNotMatch(sql, /FOR UPDATE|INSERT |UPDATE |DELETE |PacienteConsentimientos|PatientConsentDocuments|paciente_id|paciente\.nota/i);
        if (/FROM CitasPacientes|FROM PatientVouchers/.test(sql)) {
            assert.match(sql, /COUNT\(\*\)/);
            assert.doesNotMatch(sql, /SELECT \*|id_cita|patient_id|paciente_id|nota|snapshot|public_id/);
        }
    }
});
test('capture requires exactly the expected clinics in group 29', async () => {
    const c = { query: async sql => [sql === QUERIES.clinics ? [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }] : []] };
    assert.equal((await captureCatalog(c)).clinics.length, 2);
    await assert.rejects(captureCatalog({ query: async () => [[]] }), /PREFLIGHT_CLINIC_GROUP_CHANGED/);
});
test('capture refuses truncated inventories instead of reporting complete coverage', async () => {
    const c = { query: async sql => [sql === QUERIES.treatments ? Array(LIMITS.treatments + 1).fill({}) : []] };
    await assert.rejects(captureCatalog(c), /PREFLIGHT_SCOPE_LIMIT_EXCEEDED/);
});
test('v2 explicitly captures only scoped physical-alias evidence without changing historical captures', async () => {
    assert.equal(VERSION, 'bs-catalog-preflight-readonly/2');
    assert(SUPPORTED_VERSIONS.includes('bs-catalog-preflight-readonly/1'));
    assert.match(QUERIES.physical_aliases, /FROM InstallationPhysicalAliases a/);
    assert.match(QUERIES.physical_aliases, /a\.group_id=29 AND \(i\.clinica_id IN \(66,72\) OR c\.clinica_id IN \(66,72\)\)/);
    assert.doesNotMatch(QUERIES.physical_aliases, /patient|pacient|SELECT \*/i);
    const alias = { installation_id: 73, canonical_installation_id: 74, group_id: 29 };
    const connection = { query: async sql => [sql === QUERIES.clinics
        ? [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]
        : sql === QUERIES.physical_aliases ? [alias] : []] };
    assert.deepEqual((await captureCatalog(connection)).physical_aliases, [alias]);
});
test('matrix count and exact source provenance are mandatory', () => {
    const rows = matrix();
    assert.equal(checkedMatrix(rows).length, 167);
    assert.throws(() => checkedMatrix(rows.slice(1)), /PREFLIGHT_MATRIX_IDENTITY_INVALID/);
    rows[0].source_references_json = '[]';
    assert.throws(() => checkedMatrix(rows), /PREFLIGHT_MATRIX_SOURCE_INVALID/);
});
test('same names without exact source codes do not create an equivalence', () => {
    const rows = matrix();
    const result = reconcileCatalog(rows, { treatments: [treatment(rows[0], { codigo: 'CCLOUD-historical' })] });
    assert.equal(result.records[0].status, 'missing');
    assert.equal(result.summary.writes, 0);
    assert.equal(result.summary.activation_ready, false);
});
test('exact IDs are reused despite a local name edit, with fingerprints and links', () => {
    const rows = matrix();
    const result = reconcileCatalog(rows, { treatments: [treatment(rows[0], { nombre: 'Nombre editado por clínica' })],
        consent_requirements: [{ id: 3, tratamiento_id: 100 }], protocols: [{ id: 7, treatment_ids: '[100]' }] });
    assert.equal(result.records[0].status, 'exact_existing_source');
    assert.equal(result.records[0].treatment_id, 100);
    assert.equal(result.records[0].name_changed, true);
    assert.match(result.records[0].current_row_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.records[0].consent_requirement_ids, [3]);
    assert.deepEqual(result.records[0].protocol_ids, [7]);
});
test('duplicate codes, another tenant and changed origin require review, not a new treatment', () => {
    const rows = matrix(), current = treatment(rows[0]);
    const state = treatments => reconcileCatalog(rows, { treatments }).records[0].status;
    assert.equal(state([current, { ...current, id_tratamiento: 101 }]), 'duplicate_source_code');
    assert.equal(state([{ ...current, clinica_id: 66 }]), 'source_code_in_other_clinic');
    assert.equal(state([{ ...current, clinical_config: { ...current.clinical_config, source_catalog_key: hash('changed') } }]), 'source_provenance_changed');
    assert.equal(state([{ ...current, clinical_config: '{broken' }]), 'invalid_existing_configuration');
});
test('early import without source_catalog_key reuses exact code and all pinned origin hashes', () => {
    const rows = matrix(), current = treatment(rows[0]);
    delete current.clinical_config.source_catalog_key;
    const record = reconcileCatalog(rows, { treatments: [current] }).records[0];
    assert.equal(record.status, 'exact_existing_source');
    assert.equal(record.source_identity_field_missing, true);
    current.clinical_config.source_catalog.row_sha256 = hash('another source row');
    assert.equal(reconcileCatalog(rows, { treatments: [current] }).records[0].status, 'source_provenance_changed');
});
