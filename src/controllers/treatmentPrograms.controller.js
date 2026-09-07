'use strict';
const asyncHandler = require('express-async-handler');
const service = require('../services/treatmentPrograms.service');
const canUserAccessFeature = (...args) => require('../lib/access-policy').canUserAccessFeature(...args);
function createTreatmentProgramsController({ programs = service, canAccess = canUserAccessFeature } = {}) {
  async function context(req, writing = false) {
    if (!req.userData?.userId) throw programs.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
    const actorId = programs.positiveInteger(req.userData.userId, 'actor_id');
    const clinicId = programs.positiveInteger(req.query.clinic_id ?? (req.method === 'POST' ? req.body?.clinic_id : null), 'clinic_id');
    if (!await canAccess({ actorId, clinicId, featureKey: writing ? 'clinic.settings.edit' : 'appointments.view' })) throw programs.domainError(403, 'access_policy_forbidden', 'No tienes permiso para este catálogo.');
    if (req.body?.clinic_id != null && Number(req.body.clinic_id) !== clinicId) throw programs.domainError(400, 'program_scope_conflict', 'La clínica de la solicitud no coincide.');
    return { clinicId, actorId };
  }
  const respond = (handler) => asyncHandler(async (req, res) => { const result = await handler(req); res.set('Cache-Control', 'no-store'); res.status(result.created === true ? 201 : 200).json(result); });
  return {
    list: respond(async (req) => programs.list({ ...await context(req), query: req.query })),
    options: respond(async (req) => programs.options({ ...await context(req), query: req.query })),
    get: respond(async (req) => programs.get({ ...await context(req), id: req.params.id })),
    create: respond(async (req) => programs.create({ ...await context(req, true), payload: req.body })),
    preview: respond(async (req) => programs.preview({ ...await context(req, true), payload: req.body })),
    update: respond(async (req) => programs.update({ ...await context(req, true), id: req.params.id, payload: req.body })),
  };
}
module.exports = { ...createTreatmentProgramsController(), createTreatmentProgramsController };
