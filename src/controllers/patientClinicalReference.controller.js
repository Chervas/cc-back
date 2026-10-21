'use strict';
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
function createPatientClinicalReferenceController({ service = require('../services/patientClinicalReference.service') } = {}) {
  return { read: clinicalEpisodeHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await service.read({ patientIdentifier: req.params.id, clinicId: req.query.clinic_id, actorId: req.userData?.userId }));
  }), update: clinicalEpisodeHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await service.update({ patientIdentifier: req.params.id, clinicId: req.query.clinic_id,
      actorId: req.userData?.userId, payload: req.body }));
  }) };
}
module.exports = { ...createPatientClinicalReferenceController(), createPatientClinicalReferenceController };
