'use strict';

const db = require('../../models');
const patientDirection = require('../services/patientDirection.service');
const { queues } = require('../services/queue.service');
const {
  canUserAccessFeature,
  getAccessibleClinicIdsForFeature,
} = require('../lib/access-policy');
const { isGlobalAdmin } = require('../lib/role-helpers');

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendError(res, error) {
  const status = Number(error?.statusCode || error?.status || 500);
  if (status >= 500) console.error('[patient-direction]', error);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.code || error?.message || 'patient_direction_failed',
    message: error?.message || 'No se pudo completar la operación.',
    details: error?.details || null,
  });
}

async function ensureClinicFeature(req, res, featureKey, clinicId) {
  const allowed = await canUserAccessFeature({
    actorId: req.userData?.userId,
    featureKey,
    clinicId,
  });
  if (!allowed) {
    res.status(403).json({ error: 'access_policy_forbidden' });
    return false;
  }
  return true;
}

function ensureGlobalAdmin(req, res) {
  if (isGlobalAdmin(req.userData?.userId)) return true;
  res.status(403).json({ error: 'global_admin_required' });
  return false;
}

async function getRoleAssignmentClinicIds(actorId) {
  if (isGlobalAdmin(actorId)) return null;
  return getAccessibleClinicIdsForFeature({
    actorId,
    featureKey: 'patient_direction.assign_role',
  });
}

exports.getProfile = async (req, res) => {
  try {
    const userId = positiveInt(req.params.userId);
    const actorId = positiveInt(req.userData?.userId);
    if (!userId) return res.status(400).json({ error: 'user_required' });
    const manageableClinicIds = actorId === userId
      ? null
      : await getRoleAssignmentClinicIds(actorId);
    if (!isGlobalAdmin(actorId) && actorId !== userId && !manageableClinicIds?.length) {
      return res.status(403).json({ error: 'patient_direction_profile_forbidden' });
    }
    const response = await patientDirection.getProfileDetails(userId, {
      actorUserId: actorId,
      manageableClinicIds,
    });
    if (!isGlobalAdmin(actorId) && actorId !== userId && !response.profile?.is_active) {
      return res.status(404).json({ error: 'patient_direction_profile_not_found' });
    }
    return res.json(response);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getOwnProfile = async (req, res) => {
  try {
    const actorId = positiveInt(req.userData?.userId);
    if (!actorId) return res.status(401).json({ error: 'user_required' });
    return res.json(await patientDirection.getProfileDetails(actorId, { actorUserId: actorId }));
  } catch (error) {
    return sendError(res, error);
  }
};

exports.saveProfile = async (req, res) => {
  try {
    const userId = positiveInt(req.params.userId);
    const actorId = positiveInt(req.userData?.userId);
    if (!userId) return res.status(400).json({ error: 'user_required' });
    const globalAdmin = isGlobalAdmin(actorId);
    const manageableClinicIds = globalAdmin || actorId === userId
      ? null
      : await getRoleAssignmentClinicIds(actorId);
    const canManageRole = globalAdmin || Boolean(manageableClinicIds?.length);
    if (!canManageRole && actorId !== userId) {
      return res.status(403).json({ error: 'patient_direction_profile_forbidden' });
    }
    let clinicIds = req.body?.clinic_ids;
    let isActive = req.body?.is_active;
    let whatsappPhoneAssetId = req.body?.whatsapp_phone_asset_id;
    if (!globalAdmin && canManageRole) {
      const profile = await patientDirection.getPatientDirectorProfile(userId);
      if (!profile?.is_active) {
        return res.status(422).json({ error: 'patient_direction_agency_requires_existing_director' });
      }
      const requestedIds = Array.isArray(clinicIds)
        ? clinicIds.map(positiveInt).filter(Boolean)
        : [];
      const allowed = new Set(manageableClinicIds);
      if (requestedIds.some((clinicId) => !allowed.has(clinicId))) {
        return res.status(403).json({ error: 'patient_direction_clinic_out_of_scope' });
      }
      const currentIds = await patientDirection.getAssignedClinicIds(userId);
      clinicIds = [
        ...currentIds.filter((clinicId) => !allowed.has(Number(clinicId))),
        ...requestedIds,
      ];
      isActive = undefined;
      whatsappPhoneAssetId = undefined;
    }
    await patientDirection.saveProfile({
      userId,
      isActive,
      whatsappPhoneAssetId,
      clinicIds,
      actorUserId: actorId,
      canManageRole,
    });
    return res.json(await patientDirection.getProfileDetails(userId, {
      actorUserId: actorId,
      manageableClinicIds,
    }));
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getSetting = async (req, res) => {
  try {
    const clinicId = positiveInt(req.query.clinic_id);
    if (!clinicId) return res.status(400).json({ error: 'clinic_required' });
    if (!await ensureClinicFeature(req, res, 'patient_direction.view', clinicId)) return;
    const [setting, catalog] = await Promise.all([
      patientDirection.getSetting(clinicId),
      patientDirection.getCatalog(clinicId, { actorUserId: req.userData?.userId }),
    ]);
    return res.json({
      setting: setting?.get ? setting.get({ plain: true }) : setting,
      catalog,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.saveSetting = async (req, res) => {
  try {
    const clinicId = positiveInt(req.params.clinicId);
    if (!clinicId) return res.status(400).json({ error: 'clinic_required' });
    if (!ensureGlobalAdmin(req, res)) return;
    const setting = await patientDirection.saveSetting({
      clinicId,
      values: req.body || {},
      actorUserId: req.userData?.userId,
    });
    return res.json({ setting: setting.get({ plain: true }) });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.enableSetting = async (req, res) => {
  try {
    const clinicId = positiveInt(req.params.clinicId);
    if (!clinicId) return res.status(400).json({ error: 'clinic_required' });
    if (!ensureGlobalAdmin(req, res)) return;
    const result = await patientDirection.enableSetting({
      clinicId,
      values: req.body || {},
      actorUserId: req.userData?.userId,
    });
    return res.json({
      setting: result.setting.get({ plain: true }),
      activation: result.activation,
      template_provisioning: result.templateProvisioning,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.retryHandoff = async (req, res) => {
  try {
    const assignment = await patientDirection.findAssignment({
      assignmentId: req.params.assignmentId,
      statuses: ['handoff_pending'],
    });
    if (!assignment?.clinic_id) return res.status(404).json({ error: 'patient_direction_handoff_not_pending' });
    if (!await ensureClinicFeature(req, res, 'patient_direction.manage', assignment.clinic_id)) return;
    const result = await patientDirection.retryHandoff({
      assignmentId: assignment.id,
      actorUserId: req.userData?.userId,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.disableSetting = async (req, res) => {
  try {
    const clinicId = positiveInt(req.params.clinicId);
    if (!clinicId) return res.status(400).json({ error: 'clinic_required' });
    if (!ensureGlobalAdmin(req, res)) return;
    const result = await patientDirection.disableSetting({
      clinicId,
      successorUserId: req.body?.successor_user_id,
      actorUserId: req.userData?.userId,
    });
    return res.json({
      setting: result.setting.get({ plain: true }),
      affected: result.affected,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.takeConversation = async (req, res) => {
  try {
    const assignment = await patientDirection.findAssignment({ assignmentId: req.params.assignmentId });
    if (!assignment?.clinic_id) return res.status(404).json({ error: 'patient_direction_assignment_not_found' });
    if (!await ensureClinicFeature(req, res, 'leads.manage', assignment.clinic_id)) return;
    const updated = await patientDirection.registerTake({
      assignmentId: assignment.id,
      actorUserId: req.userData?.userId,
    });
    return res.json({ assignment: updated.get({ plain: true }) });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.assignUnassigned = async (req, res) => {
  try {
    const clinicId = positiveInt(req.body?.clinic_id);
    if (!clinicId) return res.status(400).json({ error: 'clinic_required' });
    const actorId = req.userData?.userId;
    if (!isGlobalAdmin(actorId) && !await patientDirection.isPatientDirector(actorId, clinicId)) {
      return res.status(403).json({ error: 'patient_direction_assignment_forbidden' });
    }
    const result = await patientDirection.assignUnassigned({
      assignmentId: req.params.assignmentId,
      clinicId,
      actorUserId: actorId,
    });
    for (const pending of result.pendingWebhooks) {
      await queues.webhookWhatsApp.add('incoming', {
        body: pending.payload,
        clinic_id: clinicId,
        patient_id: null,
        lead_id: null,
        patient_direction_assignment_id: result.assignment.id,
      });
    }
    return res.json({
      assignment: result.assignment.get({ plain: true }),
      replayed_messages: result.pendingWebhooks.length,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const actorId = positiveInt(req.userData?.userId);
    const requestedDirectorId = positiveInt(req.query.director_user_id);
    const directorUserId = isGlobalAdmin(actorId) && requestedDirectorId ? requestedDirectorId : actorId;
    if (!isGlobalAdmin(actorId) && !await patientDirection.isPatientDirector(actorId)) {
      return res.status(403).json({ error: 'patient_direction_dashboard_forbidden' });
    }
    const requestedClinics = String(req.query.clinic_id || '')
      .split(',')
      .map(positiveInt)
      .filter(Boolean);
    const clinicIds = await getAccessibleClinicIdsForFeature({
      actorId,
      featureKey: 'patient_direction.view',
      clinicIds: requestedClinics.length ? requestedClinics : null,
    });
    const dashboard = await patientDirection.getDashboard({ directorUserId, clinicIds });
    return res.json(dashboard);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getAssignmentForConversation = async (req, res) => {
  try {
    const conversationId = positiveInt(req.params.conversationId);
    const conversation = await db.Conversation.findByPk(conversationId, { attributes: ['clinic_id'] });
    if (!conversation) return res.status(404).json({ error: 'conversation_not_found' });
    if (!await ensureClinicFeature(req, res, 'patient_direction.view', conversation.clinic_id)) return;
    const assignment = await patientDirection.findAssignment({ conversationId });
    if (!assignment) return res.json({ assignment: null });
    const director = await db.Usuario.findByPk(assignment.director_user_id, {
      attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'],
      raw: true,
    });
    return res.json({
      assignment: assignment.get({ plain: true }),
      director: director ? {
        id: director.id_usuario,
        name: [director.nombre, director.apellidos].filter(Boolean).join(' '),
        avatar: director.avatar || null,
      } : null,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
