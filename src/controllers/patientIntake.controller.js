'use strict';
const db = require('../../models');
const service = require('../services/patientIntake.service');
const { canUserAccessFeature } = require('../lib/access-policy');
const { error } = require('../lib/patient-intake-questionnaire');
const handler = fn => async (req, res, next) => {
  try { res.json(await fn(req)); }
  catch (e) { if ([400, 401, 403, 404, 409, 410].includes(e.statusCode || e.status)) res.status(e.statusCode || e.status).json({ code: e.code, message: e.message }); else next(e); }
};
async function access(req, feature) {
  const id = String(req.params.id || ''), clinicId = Number(req.body?.clinic_id || req.query.clinic_id), actorId = Number(req.userData?.userId);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) throw error('clinic_scope_required', 'Selecciona una clínica.');
  if (!await canUserAccessFeature({ actorId, featureKey: feature, clinicId })) throw error('intake_access_forbidden', 'No tienes permiso para esta operación.', 403);
  const patient = await db.Paciente.findOne({ where: /^\d+$/.test(id) ? { id_paciente: Number(id) } : { public_id: id }, attributes: ['id_paciente', 'clinica_id'] });
  if (!patient || Number(patient.clinica_id) !== clinicId) throw error('intake_patient_not_found', 'Paciente no encontrado en esta clínica.', 404);
  return { patientId: patient.id_paciente, clinicId, actorId };
}
exports.prepare = handler(async req => service.prepare(await access(req, 'consents.manage')));
exports.review = handler(async req => service.reviewView(await access(req, 'clinical.reports.view')));
exports.confirm = handler(async req => service.confirm({ ...await access(req, 'clinical.reports.manage'), payload: req.body }));
exports.submit = handler(async req => {
  const pkg = await require('../services/consentimientos.service').resolveActivePublicPackage(req.params.token);
  const result = await service.submit(pkg, req.body);
  await require('../services/consentimientos.service').refreshPackageCounts(pkg.id);
  return result;
});
