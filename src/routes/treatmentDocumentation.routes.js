'use strict';
const router = require('express').Router();
const asyncHandler = require('express-async-handler');
const { canUserAccessFeature } = require('../lib/access-policy');
const { createTreatmentDocumentationService, fail } = require('../services/treatmentDocumentation.service');
const service = createTreatmentDocumentationService();
router.use(require('./auth.middleware'));
router.use(asyncHandler(async (req, res, next) => {
  const clinicId = Number(req.query.clinic_id ?? (req.method === 'POST' ? req.body?.clinic_id : null));
  const actorId = Number(req.userData?.userId);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) throw fail(400, 'clinic_required', 'Selecciona una clínica.');
  const writing = !['GET', 'HEAD'].includes(req.method);
  const required = writing ? ['clinic.settings.edit', 'clinical.reports.manage'] : ['appointments.view'];
  if ((await Promise.all(required.map(featureKey => canUserAccessFeature({ actorId, clinicId, featureKey })))).some(result => !result)) throw fail(403, 'access_policy_forbidden', 'No tienes permisos sobre esta documentación.');
  req.documentationContext = { clinicId, actorId };
  res.set('Cache-Control', 'no-store');
  next();
}));
router.get('/coverage', asyncHandler(async (req, res) => res.json(await service.coverage({ ...req.documentationContext, query: req.query }))));
router.get('/for-appointment/:id', asyncHandler(async (req, res) => {
  const { actorId, clinicId } = req.documentationContext;
  const required = ['patients.view', 'patients.sensitive.view', 'clinical.reports.view'];
  if ((await Promise.all(required.map(featureKey => canUserAccessFeature({ actorId, clinicId, featureKey })))).some(allowed => !allowed)) throw fail(403, 'access_policy_forbidden', 'No tienes permisos para la documentación de esta cita.');
  res.json(await service.forAppointment({ ...req.documentationContext, appointmentId: req.params.id, query: req.query }));
}));
router.get('/treatments', asyncHandler(async (req, res) => res.json(await service.options({ ...req.documentationContext, query: req.query }))));
router.get('/protocols', asyncHandler(async (req, res) => res.json(await service.list({ ...req.documentationContext, query: req.query }))));
router.get('/protocols/:id', asyncHandler(async (req, res) => res.json(await service.get({ ...req.documentationContext, id: req.params.id, version: req.query.version }))));
router.post('/protocols', asyncHandler(async (req, res) => res.status(201).json(await service.save({ ...req.documentationContext, payload: req.body }))));
router.patch('/protocols/:id', asyncHandler(async (req, res) => res.json(await service.save({ ...req.documentationContext, id: req.params.id, payload: req.body }))));
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const candidate = Number(error.statusCode || error.status);
  const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
  const message = status === 500 ? 'No se pudo procesar la documentación.' : error.message;
  const code = status === 500 ? 'documentation_failed' : error.code || 'documentation_request_failed';
  res.status(status).json({ message, code, error: { code, message } });
});
module.exports = router;
