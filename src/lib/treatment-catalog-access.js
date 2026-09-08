'use strict';

function createTreatmentCatalogAccess({ db = require('../../models'), canAccess = require('./access-policy').canUserAccessFeature, isAdmin = require('./role-helpers').isGlobalAdmin } = {}) {
  const { Op } = db.Sequelize;
  // Must match the integer later consumed by the legacy parseInt controller.
  // Number('0x48') or Number('7.2e1') would authorize a different clinic.
  const integer = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const failure = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
  async function allowed(actorId, clinicId, writing) {
    return canAccess({ actorId, clinicId, featureKey: writing ? 'clinic.settings.edit' : 'appointments.view' });
  }
  async function checkScope(actorId, record, writing) {
    if (isAdmin(actorId)) return;
    if (record.origen === 'sistema') {
      if (writing) throw failure(403, 'Solo administración global puede modificar el catálogo de sistema.');
      const memberships = await db.UsuarioClinica.findAll({ where: { id_usuario: actorId, [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] }, attributes: ['id_clinica'], raw: true });
      for (const item of memberships) if (await allowed(actorId, item.id_clinica, false)) return;
      throw failure(403, 'No tienes acceso al catálogo.');
    }
    const clinics = record.origen === 'grupo'
      ? await db.Clinica.findAll({ where: { grupoClinicaId: integer(record.grupo_clinica_id) || -1 }, attributes: ['id_clinica'], raw: true })
      : [{ id_clinica: integer(record.clinica_id) }];
    if (!clinics.length || clinics.some(c => !c.id_clinica)) throw failure(400, 'Ámbito de clínica o grupo no válido.');
    const access = await Promise.all(clinics.map(c => allowed(actorId, c.id_clinica, writing)));
    if (writing ? access.some(value => !value) : !access.some(Boolean)) throw failure(403, 'No tienes permisos sobre este catálogo.');
  }
  return async function treatmentCatalogAccess(req, res, next) {
    try {
      const actorId = integer(req.userData?.userId);
      if (!actorId) throw failure(401, 'Usuario no autenticado.');
      const writing = !['GET', 'HEAD'].includes(req.method);
      for (const key of ['clinica_id', 'grupo_clinica_id']) {
        if (req.query?.[key] !== undefined && !integer(req.query[key])) throw failure(400, 'Ámbito de catálogo no válido.');
      }
      if (req.query?.origen !== undefined && !['clinica', 'grupo', 'sistema'].includes(req.query.origen)) {
        // The legacy controller builds an OR from these values; an unknown value
        // must not produce an empty OR and therefore an unscoped query.
        throw failure(400, 'Origen de catálogo no válido.');
      }
      if (req.query?.origen === 'grupo' && integer(req.query.clinica_id) && !integer(req.query.grupo_clinica_id)) {
        const clinic = await db.Clinica.findByPk(integer(req.query.clinica_id), { attributes: ['grupoClinicaId'], raw: true });
        if (!integer(clinic?.grupoClinicaId)) throw failure(400, 'La clínica no pertenece a un grupo.');
      }
      if (!integer(req.query?.clinica_id) && integer(req.query?.grupo_clinica_id) && req.query?.origen === 'clinica') throw failure(400, 'Selecciona una clínica para consultar su catálogo propio.');
      if (req.params?.id) {
        const record = await db.Tratamiento.findByPk(req.params.id);
        if (!record) return res.status(404).json({ message: 'Tratamiento no encontrado' });
        const copyOrHide = /\/(personalizar|ocultar|restaurar)$/.test(req.path || '');
        await checkScope(actorId, record, writing && !copyOrHide);
        if (writing && copyOrHide) await checkScope(actorId, { origen: 'clinica', clinica_id: req.body?.clinica_id }, true);
        else if (writing && ['origen', 'clinica_id', 'grupo_clinica_id'].some(key => req.body?.[key] !== undefined)) {
          await checkScope(actorId, { origen: req.body.origen ?? record.origen, clinica_id: req.body.clinica_id ?? record.clinica_id, grupo_clinica_id: req.body.grupo_clinica_id ?? record.grupo_clinica_id }, true);
        }
      } else if (writing) {
        await checkScope(actorId, { ...req.body, origen: req.body?.origen || 'clinica' }, true);
      } else if (!isAdmin(actorId)) {
        const clinicId = integer(req.query.clinica_id);
        const groupId = integer(req.query.grupo_clinica_id);
        if (clinicId) {
          if (!await allowed(actorId, clinicId, false)) throw failure(403, 'No tienes acceso a esta clínica.');
          const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['grupoClinicaId'], raw: true });
          if (groupId && groupId !== Number(clinic?.grupoClinicaId)) throw failure(403, 'La clínica no pertenece al grupo solicitado.');
        } else if (groupId) {
          await checkScope(actorId, { origen: 'grupo', grupo_clinica_id: groupId }, false);
        } else {
          // Legacy global-list consumers must not enumerate unrelated clinics.
          await checkScope(actorId, { origen: 'sistema' }, false);
          req.query.origen = 'sistema';
        }
      }
      next();
    } catch (error) { next(error); }
  };
}
module.exports = { createTreatmentCatalogAccess };
