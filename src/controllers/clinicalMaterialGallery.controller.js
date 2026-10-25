'use strict';
const service = require('../services/clinicalMaterialGallery.service');
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
module.exports = { read: clinicalEpisodeHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await service.read({ patientIdentifier: req.params.id, clinicId: req.query.clinic_id, actorId: req.userData?.userId, episodeIds: req.query.episode_ids, query: req.query }));
}) };
