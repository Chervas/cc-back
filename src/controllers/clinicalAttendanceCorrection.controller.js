'use strict';
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
module.exports = { correct: clinicalEpisodeHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await require('../services/clinicalAttendanceCorrection.service').correct({ appointmentId: req.params.id, clinicId: req.query.clinic_id, actorId: req.userData?.userId, payload: req.body }));
}) };
