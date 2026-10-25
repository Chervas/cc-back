'use strict';
const service = require('../services/clinicalPhotoPairs.service');
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
function createController({ pairs = service } = {}) {
  const input = req => ({ patientIdentifier: req.params.id, id: req.params.pairId || req.params.attachmentId,
    clinicId: req.query.clinic_id ?? req.body?.clinic_id, actorId: req.userData?.userId, payload: req.body || {}, query: req.query || {}, version: req.query.version });
  const run = method => clinicalEpisodeHandler(async (req, res) => { res.set('Cache-Control', 'private, no-store'); const result = await pairs[method](input(req)); res.status(result.created ? 201 : 200).json(result); });
  return Object.fromEntries(['list', 'get', 'create', 'save', 'archive', 'classifyAttachment', 'archiveAttachment'].map(method => [method, run(method)]));
}
module.exports = { ...createController(), createController };
