'use strict';
const C = require('../lib/clinical-episode-contract');
const { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
function createController({ service = require('../services/clinicalTemplateDefaults.service') } = {}) {
  const handler = method => clinicalEpisodeHandler(async (req,res) => {
    res.set('Cache-Control','private, no-store');
    if (!req.userData?.userId) throw C.error(401,'unauthenticated','Usuario no autenticado.');
    res.json(await service[method]({ actorId:C.integer(req.userData.userId),clinicId:C.integer(req.query.clinic_id),
      treatmentId:req.params.id,patientIdentifier:req.params.patientId,query:req.query,payload:req.body }));
  });
  return { list:handler('list'),treatments:handler('treatments'),save:handler('save'),resolve:handler('resolve') };
}
module.exports = {...createController(),createController};
