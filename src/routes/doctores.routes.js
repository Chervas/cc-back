const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/doctores.controller');
const db = require('../../models');
const { getAccessibleClinicIdsForFeature } = require('../lib/access-policy');

function positiveId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function accessError(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function asyncAccess(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error('[doctores.access] Error:', error);
    if (res.headersSent) return undefined;
    return accessError(res, 500, 'doctor_scope_check_failed', 'No se pudo validar el acceso al personal.');
  });
}

function actorId(req) {
  return positiveId(req.userData?.userId);
}

async function authorizeClinicIds(req, res, featureKey, clinicIds, { requireAll = true } = {}) {
  const userId = actorId(req);
  const requested = Array.from(new Set((Array.isArray(clinicIds) ? clinicIds : [clinicIds])
    .map(positiveId)
    .filter(Boolean)));
  if (!userId) {
    accessError(res, 401, 'unauthenticated', 'Usuario no autenticado.');
    return null;
  }
  if (!requested.length) {
    accessError(res, 404, 'doctor_scope_not_found', 'No existe un scope de clínica válido para este recurso.');
    return null;
  }

  const allowed = await getAccessibleClinicIdsForFeature({
    actorId: userId,
    featureKey,
    clinicIds: requested,
  });
  if (!allowed.length || (requireAll && allowed.length !== requested.length)) {
    accessError(res, 403, 'access_policy_forbidden', 'No tienes permisos para acceder a este recurso.');
    return null;
  }
  return allowed;
}

async function doctorClinicIds(doctorId) {
  const rows = await db.DoctorClinica.findAll({
    where: { doctor_id: doctorId, activo: true },
    attributes: ['clinica_id'],
    raw: true,
  });
  return Array.from(new Set(rows.map((row) => positiveId(row.clinica_id)).filter(Boolean)));
}

const scopeDoctorList = asyncAccess(async (req, res, next) => {
  const clinicIdRaw = req.query?.clinica_id;
  const groupIdRaw = req.query?.group_id;
  const clinicId = clinicIdRaw === undefined ? null : positiveId(clinicIdRaw);
  const groupId = groupIdRaw === undefined ? null : positiveId(groupIdRaw);
  if ((clinicIdRaw !== undefined && !clinicId) || (groupIdRaw !== undefined && !groupId)) {
    return accessError(res, 400, 'clinic_scope_invalid', 'La clínica o el grupo indicado no es válido.');
  }

  let requestedClinicIds = null;
  if (groupId) {
    const clinics = await db.Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    requestedClinicIds = clinics.map((clinic) => positiveId(clinic.id_clinica)).filter(Boolean);
    if (clinicId && !requestedClinicIds.includes(clinicId)) {
      return accessError(res, 400, 'clinic_group_scope_mismatch', 'La clínica no pertenece al grupo indicado.');
    }
  }
  if (clinicId) requestedClinicIds = [clinicId];

  const featureKey = req.query?.agenda_context === 'true' || req.query?.agenda_context === '1'
    ? 'appointments.view'
    : 'team.view';
  const allowed = await getAccessibleClinicIdsForFeature({
    actorId: actorId(req),
    featureKey,
    clinicIds: requestedClinicIds,
  });
  if (!allowed.length || (requestedClinicIds && allowed.length !== requestedClinicIds.length)) {
    return accessError(res, 403, 'access_policy_forbidden', 'No tienes permisos para consultar el personal solicitado.');
  }
  req.authorizedDoctorClinicIds = allowed;
  return next();
});

function scopeDoctorClinica(featureKey) {
  return asyncAccess(async (req, res, next) => {
    const pivotId = positiveId(req.params.doctorClinicaId);
    if (!pivotId) return accessError(res, 400, 'doctor_clinic_id_invalid', 'La asignación de doctor no es válida.');
    const pivot = await db.DoctorClinica.findByPk(pivotId, {
      attributes: ['id', 'doctor_id', 'clinica_id'],
      raw: true,
    });
    if (!pivot) return accessError(res, 404, 'doctor_clinic_not_found', 'La asignación de doctor no existe.');
    const allowed = await authorizeClinicIds(req, res, featureKey, [pivot.clinica_id]);
    if (!allowed) return undefined;
    req.authorizedDoctorClinicIds = allowed;
    req.authorizedDoctorId = positiveId(pivot.doctor_id);
    return next();
  });
}

function scopeDoctor(featureKey, { requireAll = false } = {}) {
  return asyncAccess(async (req, res, next) => {
    const doctorId = req.params.doctorId === 'me' || !req.params.doctorId
      ? actorId(req)
      : positiveId(req.params.doctorId);
    if (!doctorId) return accessError(res, 400, 'doctor_id_invalid', 'El doctor indicado no es válido.');
    const clinicIds = await doctorClinicIds(doctorId);
    const allowed = await authorizeClinicIds(req, res, featureKey, clinicIds, { requireAll });
    if (!allowed) return undefined;
    req.authorizedDoctorClinicIds = allowed;
    req.authorizedDoctorId = doctorId;
    return next();
  });
}

function scopeClinicSchedule(featureKey) {
  return asyncAccess(async (req, res, next) => {
    const clinicId = positiveId(req.params.clinicaId);
    const doctorId = req.params.doctorId === 'me' || !req.params.doctorId
      ? actorId(req)
      : positiveId(req.params.doctorId);
    if (!clinicId || !doctorId) {
      return accessError(res, 400, 'doctor_clinic_scope_invalid', 'El doctor o la clínica no son válidos.');
    }
    const pivot = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicId, activo: true },
      attributes: ['id'],
      raw: true,
    });
    if (!pivot) return accessError(res, 404, 'doctor_clinic_not_found', 'El doctor no está asignado a esta clínica.');
    const allowed = await authorizeClinicIds(req, res, featureKey, [clinicId]);
    if (!allowed) return undefined;
    req.authorizedDoctorClinicIds = allowed;
    req.authorizedDoctorId = doctorId;
    return next();
  });
}

function scopeBlockMutation({ currentUserOnly = false } = {}) {
  return asyncAccess(async (req, res, next) => {
    const blockId = positiveId(req.params.id);
    if (!blockId) return accessError(res, 400, 'doctor_block_id_invalid', 'El bloqueo indicado no es válido.');
    const block = await db.DoctorBloqueo.findByPk(blockId, { raw: true });
    if (!block) return accessError(res, 404, 'doctor_block_not_found', 'El bloqueo no existe.');

    const blockDoctorId = positiveId(block.doctor_id);
    if (currentUserOnly && blockDoctorId !== actorId(req)) {
      return accessError(res, 403, 'doctor_block_owner_forbidden', 'No puedes modificar el bloqueo de otro profesional.');
    }
    const assignedClinicIds = await doctorClinicIds(blockDoctorId);
    const affectedClinicIds = new Set();
    const currentClinicId = positiveId(block.clinica_id);
    if (currentClinicId) affectedClinicIds.add(currentClinicId);
    else assignedClinicIds.forEach((id) => affectedClinicIds.add(id));

    if (req.method === 'PATCH' && Object.prototype.hasOwnProperty.call(req.body || {}, 'clinica_id')) {
      const nextClinicId = positiveId(req.body.clinica_id);
      if (req.body.clinica_id !== null && req.body.clinica_id !== '' && !nextClinicId) {
        return accessError(res, 400, 'clinic_id_invalid', 'La clínica indicada no es válida.');
      }
      if (nextClinicId) {
        if (!assignedClinicIds.includes(nextClinicId)) {
          return accessError(res, 404, 'doctor_clinic_not_found', 'El doctor no está asignado a la clínica indicada.');
        }
        affectedClinicIds.add(nextClinicId);
      } else {
        assignedClinicIds.forEach((id) => affectedClinicIds.add(id));
      }
    }

    const allowed = await authorizeClinicIds(req, res, 'team.manage', Array.from(affectedClinicIds));
    if (!allowed) return undefined;
    req.authorizedDoctorClinicIds = allowed;
    req.authorizedDoctorId = blockDoctorId;
    req.authorizedDoctorBlock = block;
    return next();
  });
}

function scopeBlockCreate({ currentUserOnly = false } = {}) {
  return asyncAccess(async (req, res, next) => {
    const doctorId = currentUserOnly ? actorId(req) : positiveId(req.params.doctorId);
    if (!doctorId) return accessError(res, 400, 'doctor_id_invalid', 'El doctor indicado no es válido.');
    const assignedClinicIds = await doctorClinicIds(doctorId);
    const clinicId = positiveId(req.body?.clinica_id);
    if (req.body?.clinica_id !== undefined && req.body?.clinica_id !== null && req.body?.clinica_id !== '' && !clinicId) {
      return accessError(res, 400, 'clinic_id_invalid', 'La clínica indicada no es válida.');
    }
    if (clinicId && !assignedClinicIds.includes(clinicId)) {
      return accessError(res, 404, 'doctor_clinic_not_found', 'El doctor no está asignado a la clínica indicada.');
    }
    const affected = clinicId ? [clinicId] : assignedClinicIds;
    const allowed = await authorizeClinicIds(req, res, 'team.manage', affected);
    if (!allowed) return undefined;
    req.authorizedDoctorClinicIds = allowed;
    req.authorizedDoctorId = doctorId;
    return next();
  });
}

const scopeAvailability = asyncAccess(async (req, res, next) => {
  const clinicId = positiveId(req.query?.clinica_id);
  const doctorId = positiveId(req.query?.doctor_id);
  if (!clinicId || !doctorId) {
    return accessError(res, 400, 'availability_scope_required', 'Debes indicar un doctor y una clínica válidos.');
  }
  const pivot = await db.DoctorClinica.findOne({
    where: { doctor_id: doctorId, clinica_id: clinicId, activo: true },
    attributes: ['id'],
    raw: true,
  });
  if (!pivot) return accessError(res, 404, 'doctor_clinic_not_found', 'El doctor no está asignado a esta clínica.');

  const installationId = positiveId(req.query?.instalacion_id);
  if (req.query?.instalacion_id !== undefined && !installationId) {
    return accessError(res, 400, 'installation_id_invalid', 'La instalación indicada no es válida.');
  }
  if (installationId) {
    const installation = await db.Instalacion.findByPk(installationId, {
      attributes: ['id', 'clinica_id'],
      raw: true,
    });
    if (!installation || positiveId(installation.clinica_id) !== clinicId) {
      return accessError(res, 404, 'installation_not_found', 'La instalación no existe en esta clínica.');
    }
  }

  const allowed = await authorizeClinicIds(req, res, 'appointments.view', [clinicId]);
  if (!allowed) return undefined;
  req.authorizedDoctorClinicIds = allowed;
  req.authorizedDoctorId = doctorId;
  return next();
});

router.use(authMiddleware);
router.get('/', scopeDoctorList, controller.list);
router.get('/:doctorClinicaId/horarios', scopeDoctorClinica('team.view'), controller.getHorarios);
router.put('/:doctorClinicaId/horarios', scopeDoctorClinica('team.manage'), controller.updateHorarios);
router.get('/:doctorId/bloqueos', scopeDoctor('team.view'), controller.listBloqueos);
router.post('/me/bloqueos', scopeBlockCreate({ currentUserOnly: true }), controller.createBloqueo);
router.post('/:doctorId/bloqueos', scopeBlockCreate(), controller.createBloqueo);
router.delete('/bloqueos/:id', scopeBlockMutation(), controller.deleteBloqueo);
router.get('/disponibilidad', scopeAvailability, controller.disponibilidad);
router.patch('/bloqueos/:id', scopeBlockMutation(), controller.updateBloqueo);
router.patch('/me/bloqueos/:id', scopeBlockMutation({ currentUserOnly: true }), controller.updateBloqueo);
// Schedules
router.get('/me/schedule', scopeDoctor('team.view'), controller.getScheduleForCurrent);
router.get('/:doctorId/schedule', scopeDoctor('team.view'), controller.getScheduleForDoctor);
router.put('/me/clinicas/:clinicaId/horarios', scopeClinicSchedule('team.manage'), controller.updateHorariosClinica);
router.put('/:doctorId/clinicas/:clinicaId/horarios', scopeClinicSchedule('team.manage'), controller.updateHorariosClinica);

router.__agencyAccessContract = {
  authorizeClinicIds,
  scopeAvailability,
  scopeDoctorList,
};

module.exports = router;
