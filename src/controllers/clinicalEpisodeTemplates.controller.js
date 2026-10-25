'use strict';
const C = require('../lib/clinical-episode-contract'), { clinicalEpisodeHandler } = require('./clinicalEpisodes.controller');
function createClinicalEpisodeTemplatesController({ templates = require('../services/clinicalEpisodeTemplates.service'), canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) } = {}) {
  const handler = (method, writing = false) => clinicalEpisodeHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store'); if (!req.userData?.userId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    const actorId = C.integer(req.userData.userId), clinicId = C.integer(req.query.clinic_id);
    const allowed = await Promise.all(['patients.view', 'patients.sensitive.view', writing ? 'clinical.reports.manage' : 'clinical.reports.view'].map(featureKey => canAccess({ actorId, clinicId, featureKey })));
    if (allowed.some(value => !value)) throw C.error(403, 'access_policy_forbidden', 'No tienes permisos para estas plantillas clínicas.');
    const result = await templates[method]({ id: req.params.id, clinicId, actorId, version: req.query.version, query: req.query, payload: req.body });
    res.status(result.created ? 201 : 200).json(result);
  });
  return { list: handler('list'), get: handler('get'), create: handler('create', true), save: handler('save', true), archive: handler('archive', true), versions: handler('versions') };
}
module.exports = { ...createClinicalEpisodeTemplatesController(), createClinicalEpisodeTemplatesController };
