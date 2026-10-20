'use strict';

const PURPOSE_FEATURE = {
  clinical_attachment: 'patients.sensitive.view',
  consent_document_pdf: 'consents.view',
  nutrition_report_pdf: 'nutrition.workspace.view',
  nutrition_clinical_photo: 'nutrition.workspace.view',
};
function fail(code, message, statusCode = 400) { throw Object.assign(new Error(message), { code, statusCode }); }
const positive = v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function createMaterialValidator({ db, canAccess }) {
  return async function validateMaterialRefs({ refs, patientId, clinicId, actorId, transaction = null }) {
    if (!Array.isArray(refs) || refs.length > 100) fail('clinical_materials_invalid', 'La selección de materiales no es válida.');
    const result = [], seen = new Set();
    for (const ref of refs) {
      if (!ref || !['attachment', 'drawing'].includes(ref.kind) || typeof ref.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(ref.id)) fail('clinical_material_invalid', 'Uno de los materiales no es válido.');
      if (ref.kind === 'attachment') {
        const asset = await db.ClinicalPrivateAsset.findOne({ where: {
          public_id: ref.id, patient_id: patientId, clinic_id: clinicId, scope_type: 'clinic', status: 'active',
        }, transaction });
        const featureKey = asset && PURPOSE_FEATURE[asset.purpose];
        if (!asset || !featureKey) fail('clinical_material_not_found', 'El material no está disponible en esta clínica y paciente.', 404);
        if (!await canAccess({ actorId, clinicId, featureKey })) fail('clinical_material_forbidden', 'No tienes permiso para consultar este material.', 403);
        const key = 'attachment:' + asset.public_id;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ kind: 'attachment', id: asset.public_id, title: asset.original_filename || 'Archivo del paciente', sha256: asset.sha256 });
      } else {
        if (!await canAccess({ actorId, clinicId, featureKey: 'patients.sensitive.view' })
          || !await canAccess({ actorId, clinicId, featureKey: 'clinical.reports.view' })) fail('clinical_material_forbidden', 'No tienes permiso para consultar este modelo.', 403);
        const drawing = await db.ClinicalDrawing.findOne({ where: { public_id: ref.id, patient_id: patientId, clinic_id: clinicId }, transaction });
        if (!drawing) fail('clinical_material_not_found', 'El modelo no está disponible en esta clínica y paciente.', 404);
        const version = ref.version === undefined ? Number(drawing.version_number) : ref.version;
        if (!positive(version)) fail('clinical_material_version_invalid', 'La versión del modelo no es válida.');
        const revision = await db.ClinicalDrawingRevision.findOne({ where: { drawing_id: drawing.id, version_number: version }, transaction });
        if (!revision || (drawing.status !== 'active' && ref.version === undefined)) fail('clinical_material_not_found', 'Esta versión del modelo no está disponible.', 404);
        const key = 'drawing:' + drawing.public_id + ':' + version;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ kind: 'drawing', id: drawing.public_id, version, title: revision.snapshot.title || drawing.title,
          template_key: revision.snapshot.template_key || drawing.template_key,
          template_version: Number(revision.snapshot.template_version || drawing.template_version || 1) });
      }
    }
    return result;
  };
}
let validator;
async function validateMaterialRefs(input) {
  if (!validator) validator = createMaterialValidator({ db: require('../../models'), canAccess: require('../lib/access-policy').canUserAccessFeature });
  return validator(input);
}
module.exports = { createMaterialValidator, validateMaterialRefs, PURPOSE_FEATURE };
