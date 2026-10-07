'use strict';

// Read-only inventory and exact source reconciliation. No application models,
// patient rows, fuzzy equivalences, booking commands or migration operations.
const { hash } = require('./adapter');
const { WORKBOOK_SHA } = require('./catalog-matrix');
const VERSION = 'bs-catalog-preflight-readonly/2';
// Historical captures remain verifiable; only v2 proves that the physical
// aliases were actually read. Never retrofit that evidence into a v1 artifact.
const SUPPORTED_VERSIONS = Object.freeze(['bs-catalog-preflight-readonly/1', VERSION]);
const MATRIX_FILE_SHA = '699e3c2457190d19e1c79f94fd35aeaedd3a440a92ccc915fffbb00a87e0d812';
const fail = code => { throw Error(code); };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

// Fixed, bounded queries only. Existing entitlements and appointments are
// counted in SQL; their patients, notes, identifiers and snapshots never leave
// the database in this inventory. READ ONLY is additionally enforced by MySQL.
const QUERIES = Object.freeze({
    clinics: 'SELECT id_clinica,grupoClinicaId,equipment_booking_enabled FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica LIMIT 3',
    triggers: "SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('Tratamientos','TreatmentConsentRequirements','TreatmentProtocols') ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME LIMIT 101",
    treatments: "SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) OR codigo LIKE 'BS26-%' ORDER BY id_tratamiento LIMIT 2001",
    installations: 'SELECT * FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY id LIMIT 251',
    physical_aliases: 'SELECT a.installation_id,a.canonical_installation_id,a.group_id,a.created_at,a.updated_at FROM InstallationPhysicalAliases a LEFT JOIN Instalaciones i ON i.id=a.installation_id LEFT JOIN Instalaciones c ON c.id=a.canonical_installation_id WHERE a.group_id=29 AND (i.clinica_id IN (66,72) OR c.clinica_id IN (66,72)) ORDER BY a.installation_id LIMIT 251',
    professionals: 'SELECT id,doctor_id,clinica_id,rol_en_clinica,activo,recibe_citas,agenda_flexible,allow_overlap_confirmation FROM DoctorClinicas WHERE clinica_id IN (66,72) ORDER BY id LIMIT 251',
    equipment: 'SELECT * FROM BookingEquipment WHERE owner_clinic_id IN (66,72) OR group_id=29 ORDER BY id LIMIT 251',
    equipment_memberships: 'SELECT bc.* FROM BookingEquipmentClinics bc INNER JOIN BookingEquipment b ON b.id=bc.equipment_id WHERE b.owner_clinic_id IN (66,72) OR b.group_id=29 ORDER BY bc.equipment_id,bc.clinic_id LIMIT 501',
    equipment_room_policies: 'SELECT p.* FROM BookingEquipmentRoomPolicies p INNER JOIN Instalaciones i ON i.id=p.installation_id WHERE i.clinica_id IN (66,72) ORDER BY p.installation_id LIMIT 251',
    consent_requirements: 'SELECT r.* FROM TreatmentConsentRequirements r INNER JOIN Tratamientos t ON t.id_tratamiento=r.tratamiento_id WHERE t.clinica_id IN (66,72) ORDER BY r.id LIMIT 4001',
    consent_templates: 'SELECT * FROM ClinicConsentTemplates WHERE clinic_id IN (66,72) ORDER BY id LIMIT 501',
    consent_versions: 'SELECT v.* FROM ClinicConsentTemplateVersions v INNER JOIN ClinicConsentTemplates t ON t.id=v.clinic_template_id WHERE t.clinic_id IN (66,72) ORDER BY v.id LIMIT 2001',
    protocols: 'SELECT * FROM TreatmentProtocols WHERE clinic_id IN (66,72) ORDER BY id LIMIT 501',
    appointment_counts: 'SELECT tratamiento_id,estado,COUNT(*) AS row_count,SUM(inicio>=UTC_TIMESTAMP()) AS future_count,MAX(updated_at) AS latest_updated_at FROM CitasPacientes WHERE clinica_id IN (66,72) AND tratamiento_id IS NOT NULL GROUP BY tratamiento_id,estado ORDER BY tratamiento_id,estado LIMIT 20001',
    voucher_counts: 'SELECT treatment_id,status,COUNT(*) AS row_count,SUM(total_units) AS total_units,SUM(available_units) AS available_units FROM PatientVouchers WHERE clinic_id IN (66,72) AND treatment_id IS NOT NULL GROUP BY treatment_id,status ORDER BY treatment_id,status LIMIT 20001',
});
const LIMITS = Object.freeze({ clinics: 2, triggers: 100, treatments: 2000, installations: 250, physical_aliases: 250,
    professionals: 250, equipment: 250, equipment_memberships: 500, equipment_room_policies: 250,
    consent_requirements: 4000, consent_templates: 500, consent_versions: 2000, protocols: 500,
    appointment_counts: 20000, voucher_counts: 20000 });

async function captureCatalog(connection) {
    const snapshot = {};
    for (const [key, sql] of Object.entries(QUERIES)) {
        const [rows] = await connection.query(sql);
        if (!Array.isArray(rows) || rows.length > LIMITS[key]) fail('PREFLIGHT_SCOPE_LIMIT_EXCEEDED');
        snapshot[key] = rows;
    }
    if (snapshot.clinics.length !== 2 || ![66, 72].every(id => snapshot.clinics.some(row =>
        Number(row.id_clinica) === id && Number(row.grupoClinicaId) === 29))) fail('PREFLIGHT_CLINIC_GROUP_CHANGED');
    return snapshot;
}

function checkedMatrix(rows) {
    if (!Array.isArray(rows) || rows.length !== 895 || new Set(rows.map(r => r.matrix_key)).size !== rows.length) fail('PREFLIGHT_MATRIX_IDENTITY_INVALID');
    const concepts = rows.filter(row => row.record_type === 'concept' && row.kind === 'treatment');
    if (concepts.length !== 167) fail('PREFLIGHT_MATRIX_TREATMENT_COUNT_CHANGED');
    for (const row of concepts) {
        if (!/^[a-f0-9]{64}$/.test(row.matrix_key) || row.code !== `BS26-${row.matrix_key.slice(0, 20)}`
            || !['BS Medical', 'BS Capilar'].includes(row.clinic)) fail('PREFLIGHT_MATRIX_SOURCE_INVALID');
        const refs = json(row.source_references_json);
        if (!Array.isArray(refs) || refs.filter(ref => ref.file_sha256 === WORKBOOK_SHA
            && Number.isSafeInteger(ref.source_row) && /^[a-f0-9]{64}$/.test(ref.row_sha256)).length !== 1) fail('PREFLIGHT_MATRIX_SOURCE_INVALID');
    }
    return concepts;
}

function reconcileCatalog(matrixRows, snapshot) {
    const concepts = checkedMatrix(matrixRows);
    if (!Array.isArray(snapshot.treatments)) fail('PREFLIGHT_SNAPSHOT_INVALID');
    const records = concepts.map(row => {
        const clinicId = row.clinic === 'BS Capilar' ? 66 : 72;
        const refs = json(row.source_references_json);
        const source = refs.find(ref => ref.file_sha256 === WORKBOOK_SHA);
        const candidates = snapshot.treatments.filter(t => t.codigo === row.code);
        const result = { matrix_key: row.matrix_key, code: row.code, clinic_id: clinicId,
            source_name: row.name, status: 'missing', candidate_ids: candidates.map(t => Number(t.id_tratamiento)) };
        if (!candidates.length) return result;
        if (candidates.length !== 1) return { ...result, status: 'duplicate_source_code' };
        const current = candidates[0];
        if (Number(current.clinica_id) !== clinicId) return { ...result, status: 'source_code_in_other_clinic' };
        let config;
        try { config = json(current.clinical_config); } catch { return { ...result, status: 'invalid_existing_configuration' }; }
        const origin = config?.source_catalog;
        // Two early imports have the exact source code and full pinned
        // workbook/sheet/row hashes, but predate source_catalog_key. Its absence
        // is not changed provenance; a present, different key is a conflict.
        if ((config?.source_catalog_key != null && config.source_catalog_key !== row.matrix_key) || !origin || origin.file_sha256 !== source.file_sha256
            || origin.sheet !== source.sheet || Number(origin.source_row) !== source.source_row
            || origin.row_sha256 !== source.row_sha256) return { ...result, status: 'source_provenance_changed' };
        // Name changes made by a clinic do not justify making another record.
        // Keep the exact ID and fingerprint; migration planning reviews changes.
        return { ...result, status: 'exact_existing_source', treatment_id: Number(current.id_tratamiento),
            current_name: current.nombre, name_changed: current.nombre !== row.name,
            source_identity_field_missing: config.source_catalog_key == null,
            active: Number(current.activo) === 1, catalog_status: config.catalog_status || null,
            profile_version: config.booking_profile?.version || null,
            current_row_sha256: hash(current), matrix_pending: json(row.pending_json),
            consent_requirement_ids: (snapshot.consent_requirements || []).filter(r => Number(r.tratamiento_id) === Number(current.id_tratamiento)).map(r => Number(r.id)),
            protocol_ids: (snapshot.protocols || []).filter(p => {
                let ids;
                try { ids = json(p.treatment_ids); } catch { return false; }
                return Array.isArray(ids) && ids.some(id => Number(id) === Number(current.id_tratamiento));
            }).map(p => Number(p.id)) };
    });
    const byStatus = records.reduce((result, row) => {
        result[row.status] = (result[row.status] || 0) + 1;
        return result;
    }, {});
    return { records, summary: { individual_concepts: records.length, by_status: byStatus,
        exact_active: records.filter(r => r.status === 'exact_existing_source' && r.active).length,
        exact_with_consent_requirements: records.filter(r => r.status === 'exact_existing_source' && r.consent_requirement_ids.length).length,
        exact_with_protocol_links: records.filter(r => r.status === 'exact_existing_source' && r.protocol_ids.length).length,
        writes: 0, activation_ready: false, migration_plan_created: false } };
}

module.exports = { VERSION, SUPPORTED_VERSIONS, MATRIX_FILE_SHA, QUERIES, LIMITS, captureCatalog, checkedMatrix, reconcileCatalog };
