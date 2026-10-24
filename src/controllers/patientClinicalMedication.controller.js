'use strict';
const service = require('../services/patientClinicalMedication.service');
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
const handler = method => clinicalEpisodeHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await service[method]({ patientIdentifier: req.params.id, clinicId: req.query.clinic_id, actorId: req.userData?.userId, payload: req.body, version: req.query.version, id: req.query.id }));
});
module.exports = { read: handler('read'), update: handler('update') };
