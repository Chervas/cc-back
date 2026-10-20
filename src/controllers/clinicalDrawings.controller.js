'use strict';
const drawings = require('../services/clinicalDrawings.service');
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');

function createClinicalDrawingsController({ service = () => drawings.current() } = {}) {
  const input = req => ({ patientIdentifier: req.params.id, clinicId: req.query.clinic_id ?? req.body?.clinic_id,
    actorId: req.userData?.userId, id: req.params.drawingId, payload: req.body,
    version: req.query.version, cursor: req.query.cursor, limit: req.query.limit, status: req.query.status });
  const handler = action => clinicalEpisodeHandler(async (req, res) => { res.set('Cache-Control', 'private, no-store'); await action(req, res); });
  return {
    list: handler(async (req, res) => res.json(await service().list(input(req)))),
    get: handler(async (req, res) => res.json(await service().get(input(req)))),
    create: handler(async (req, res) => { const result = await service().create(input(req)); res.status(result.created ? 201 : 200).json(result); }),
    save: handler(async (req, res) => res.json(await service().save(input(req)))),
    revisions: handler(async (req, res) => res.json(await service().revisions(input(req)))),
  };
}
module.exports = { ...createClinicalDrawingsController(), createClinicalDrawingsController };
