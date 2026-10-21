'use strict';
const C = require('../lib/clinical-episode-contract'), { isGlobalAdmin } = require('../lib/role-helpers');
function createClinicalTemplateCatalogController({ catalog = require('../services/clinicalTemplateCatalog.service'), canAccess = input => require('../lib/access-policy').canUserAccessFeature(input), globalAdmin = isGlobalAdmin } = {}) {
  const handler = action => (req, res) => Promise.resolve().then(async () => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.userData?.userId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    await action(req, res, C.integer(req.userData.userId, 'actor_id'));
  }).catch(error => {
    const schemaPending = ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.original?.code || error.parent?.code);
    if (schemaPending) return res.status(503).json({ error: { code: 'clinical_catalog_schema_pending', message: 'El catálogo de plantillas está pendiente de habilitación técnica.' } });
    const status = [400, 401, 403, 404, 409, 413, 428, 503].includes(error.statusCode) ? error.statusCode : 500;
    return res.status(status).json({ error: { code: status === 500 ? 'clinical_catalog_unavailable' : error.code, message: status === 500 ? 'No se pudo acceder al catálogo de plantillas.' : error.message } });
  });
  function requireAdmin(actorId) { if (!globalAdmin(actorId)) throw C.error(403, 'access_policy_forbidden', 'Solo administración global puede publicar plantillas del sistema.'); }
  async function scope(req, actorId, writing = false) {
    const clinicId = req.query.clinic_id == null ? null : C.integer(req.query.clinic_id, 'clinic_id');
    const admin = req.query.admin === 'true';
    if (admin || !clinicId) requireAdmin(actorId);
    if (clinicId) {
      const features = writing ? ['clinic.settings.edit', 'patients.view', 'patients.sensitive.view', 'clinical.reports.manage'] : ['clinic.settings.view', 'patients.view', 'patients.sensitive.view', 'clinical.reports.view'];
      if ((await Promise.all(features.map(featureKey => canAccess({ actorId, clinicId, featureKey })))).some(value => !value))
        throw C.error(403, 'access_policy_forbidden', 'No tienes permisos para estas plantillas de la clínica.');
    }
    return { clinicId, admin };
  }
  const read = method => handler(async (req, res, actorId) => res.json(await catalog[method]({ ...await scope(req, actorId), id: req.params.id, version: req.query.version, query: req.query })));
  const write = method => handler(async (req, res, actorId) => {
    requireAdmin(actorId); const result = await catalog[method]({ id: req.params.id, actorId, payload: req.body });
    res.status(result.created ? 201 : 200).json(result);
  });
  return { list: read('list'), get: read('get'), create: write('create'), save: write('save'),
    versions: handler(async (req, res, actorId) => { requireAdmin(actorId); res.json(await catalog.versions({ id: req.params.id, query: req.query })); }),
    presets: handler(async (req, res, actorId) => { requireAdmin(actorId); res.json(await catalog.presets()); }),
    adopt: handler(async (req, res, actorId) => {
      const { clinicId } = await scope(req, actorId, true);
      if (!clinicId) throw C.error(400, 'clinical_catalog_clinic_required', 'Selecciona una clínica para añadir la plantilla.');
      const result = await catalog.adopt({ id: req.params.id, clinicId, actorId, payload: req.body }); res.status(result.created ? 201 : 200).json(result);
    }) };
}
module.exports = { ...createClinicalTemplateCatalogController(), createClinicalTemplateCatalogController };
