'use strict';

const service = require('../services/clinicalEpisodes.service');
const C = require('../lib/clinical-episode-contract');

function clinicalEpisodeHandler(action) {
  return (req, res) => Promise.resolve().then(() => action(req, res)).catch(error => {
    res.set('Cache-Control', 'private, no-store');
    const schemaPending = ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.original?.code || error.parent?.code);
    if (schemaPending) return res.status(503).json({ error: { code: 'clinical_episode_schema_pending', message: 'Los episodios están pendientes de habilitación técnica.' } });
    if ([400, 401, 403, 404, 409, 413, 428, 503].includes(error.statusCode) && typeof error.code === 'string') {
      return res.status(error.statusCode).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    return res.status(500).json({ error: { code: 'clinical_episode_unavailable', message: 'No se pudo acceder al episodio. Inténtalo de nuevo.' } });
  });
}

function createClinicalEpisodesController({ episodes = service,
  canAccess = (...args) => require('../lib/access-policy').canUserAccessFeature(...args),
  findAppointment = id => require('../../models').CitaPaciente.findByPk(id, { attributes: ['id_cita', 'clinica_id'] }),
} = {}) {
  async function context(req, writing = false, actualClinicId = null) {
    if (!req.userData?.userId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    const actorId = C.integer(req.userData.userId, 'actor_id');
    const clinicId = actualClinicId === null
      ? C.integer(req.query.clinic_id ?? req.body?.clinic_id, 'clinic_id') : C.integer(actualClinicId, 'clinic_id');
    if (actualClinicId !== null && req.query.clinic_id !== undefined && C.integer(req.query.clinic_id, 'clinic_id') !== clinicId) {
      throw C.error(404, 'appointment_not_found', 'Cita no encontrada.');
    }
    const checks = await Promise.all(['patients.view', 'patients.sensitive.view', writing ? 'clinical.reports.manage' : 'clinical.reports.view']
      .map(featureKey => canAccess({ actorId, clinicId, featureKey })));
    if (checks.some(allowed => !allowed)) throw C.error(403, 'access_policy_forbidden', 'No tienes permisos para este episodio.');
    return { actorId, clinicId };
  }
  const handler = action => clinicalEpisodeHandler(async (req, res) => { res.set('Cache-Control', 'private, no-store'); await action(req, res); });
  return {
    list: handler(async (req, res) => res.json(await episodes.list({ ...await context(req), patientIdentifier: req.params.id, query: req.query }))),
    create: handler(async (req, res) => {
      const result = await episodes.create({ ...await context(req, true), patientIdentifier: req.params.id, payload: req.body });
      res.status(result.created ? 201 : 200).json(result);
    }),
    get: handler(async (req, res) => res.json(await episodes.get({ ...await context(req), id: req.params.id }))),
    save: handler(async (req, res) => res.json(await episodes.save({ ...await context(req, true), id: req.params.id, payload: req.body, mode: 'save' }))),
    finalize: handler(async (req, res) => res.json(await episodes.save({ ...await context(req, true), id: req.params.id, payload: req.body, mode: 'finalize' }))),
    reopen: handler(async (req, res) => res.json(await episodes.save({ ...await context(req, true), id: req.params.id, payload: req.body, mode: 'reopen' }))),
    revisions: handler(async (req, res) => res.json(await episodes.revisions({ ...await context(req), id: req.params.id, query: req.query }))),
    professionals: handler(async (req, res) => res.json(await episodes.professionals({ ...await context(req, true), id: req.params.id }))),
    treatmentOptions: handler(async (req, res) => res.json(await episodes.treatmentOptions({ ...await context(req, true), patientIdentifier: req.params.id, query: req.query }))),
    getForAppointment: handler(async (req, res) => {
      const appointmentId = C.integer(req.params.id, 'appointment_id');
      if (!req.userData?.userId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
      const appointment = await findAppointment(appointmentId);
      if (!appointment) throw C.error(404, 'appointment_not_found', 'Cita no encontrada.');
      res.json(await episodes.getForAppointment({ ...await context(req, false, appointment.clinica_id), appointmentId }));
    }),
  };
}
module.exports = { ...createClinicalEpisodesController(), createClinicalEpisodesController, clinicalEpisodeHandler };
