'use strict';
const service = require('../services/clinicalEpisodeConsumables.service'), { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
function createController({ consumables = service } = {}) {
  const handler = name => clinicalEpisodeHandler(async (req, res) => { res.set('Cache-Control', 'private, no-store'); res.json(await consumables[name]({
    id: req.params.id, clinicId: req.query.clinic_id, actorId: req.userData?.userId, payload: req.body, query: req.query,
  })); });
  return { read: handler('read'), products: handler('products'), save: handler('save') };
}
module.exports = { ...createController(), createController };
