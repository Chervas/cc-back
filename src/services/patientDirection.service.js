'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const whatsappService = require('./whatsapp.service');
const { queues } = require('./queue.service');
const { isGlobalAdmin } = require('../lib/role-helpers');

const {
  PatientDirectionSetting,
  PatientDirectionProfile,
  PatientDirectionAssignment,
  PatientDirectionEvent,
  UsuarioClinica,
  Usuario,
  Clinica,
  ClinicMetaAsset,
  LeadIntake,
  LeadContactAttempt,
  Conversation,
  Message,
  CitaPaciente,
  WhatsappTemplate,
  WhatsappTemplateCatalog,
} = db;

const ACTIVE_STATUSES = ['active', 'unassigned', 'handoff_pending'];
const TERMINAL_LEAD_STATUSES = ['acudio_cita', 'convertido', 'descartado'];

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePhone(value) {
  return whatsappService.normalizePhoneNumber(value);
}

function activePhoneKey(phone, directorPhoneAssetId) {
  const normalized = normalizePhone(phone);
  const assetId = positiveInt(directorPhoneAssetId);
  return normalized && assetId
    ? `patient-direction:${assetId}:${normalized.replace(/\D/g, '')}`
    : null;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function isConsentPurpose(purpose) {
  const normalized = cleanText(purpose).toLowerCase();
  return normalized.includes('consent');
}

async function getSetting(clinicId, options = {}) {
  const id = positiveInt(clinicId);
  if (!id || !PatientDirectionSetting) return null;
  return PatientDirectionSetting.findOne({
    where: { clinic_id: id },
    ...options,
  });
}

async function getDirectorMembership(userId, clinicId, options = {}) {
  const uid = positiveInt(userId);
  const cid = positiveInt(clinicId);
  if (!uid || !cid) return null;
  return UsuarioClinica.findOne({
    where: { id_usuario: uid, id_clinica: cid, estado_invitacion: 'aceptada' },
    ...options,
  });
}

async function getPatientDirectorProfile(userId, options = {}) {
  const uid = positiveInt(userId);
  if (!uid || !PatientDirectionProfile) return null;
  return PatientDirectionProfile.findByPk(uid, options);
}

async function isPatientDirector(userId, clinicId = null) {
  const uid = positiveInt(userId);
  if (!uid) return false;
  const profile = await getPatientDirectorProfile(uid, {
    attributes: ['user_id', 'is_active'],
    raw: true,
  });
  if (!profile?.is_active) return false;
  const cid = positiveInt(clinicId);
  if (!cid) return true;
  return Boolean(await PatientDirectionSetting.findOne({
    where: { clinic_id: cid, director_user_id: uid },
    attributes: ['id'],
    raw: true,
  }));
}

async function getAssignedClinicIds(userId) {
  const uid = positiveInt(userId);
  if (!uid || !PatientDirectionProfile || !PatientDirectionSetting) return [];
  const profile = await getPatientDirectorProfile(uid, {
    attributes: ['user_id', 'is_active'],
    raw: true,
  });
  if (!profile?.is_active) return [];
  const settings = await PatientDirectionSetting.findAll({
    where: { director_user_id: uid },
    attributes: ['clinic_id'],
    raw: true,
  });
  return Array.from(new Set(
    settings
      .map((row) => positiveInt(row.clinic_id))
      .filter(Boolean)
  ));
}

async function getProfileDetails(userId, { actorUserId = null } = {}) {
  const uid = positiveInt(userId);
  if (!uid) throw Object.assign(new Error('user_required'), { statusCode: 400 });
  const user = await Usuario.findByPk(uid, {
    attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar', 'email_usuario'],
    raw: true,
  });
  if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });

  const profile = await getPatientDirectorProfile(uid, {
    include: [{
      model: ClinicMetaAsset,
      as: 'whatsappPhone',
      attributes: ['id', 'metaAssetName', 'waVerifiedName', 'additionalData', 'assignmentScope'],
      required: false,
    }],
  });
  const settings = await PatientDirectionSetting.findAll({
    where: { director_user_id: uid },
    include: [{ model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'], required: true }],
    attributes: ['clinic_id', 'is_enabled'],
    order: [[{ model: Clinica, as: 'clinic' }, 'nombre_clinica', 'ASC']],
  });

  const assetWhere = {
    assetType: 'whatsapp_phone_number',
    isActive: true,
    [Op.or]: [
      { assignmentScope: 'unassigned' },
      ...(positiveInt(profile?.whatsapp_phone_asset_id)
        ? [{ id: positiveInt(profile.whatsapp_phone_asset_id) }]
        : []),
    ],
  };
  const actorId = positiveInt(actorUserId);
  const assets = await ClinicMetaAsset.findAll({
    where: assetWhere,
    include: [{
      model: db.MetaConnection,
      as: 'metaConnection',
      attributes: [],
      required: true,
      ...(!isGlobalAdmin(actorId) ? { where: { userId: actorId } } : {}),
    }],
    attributes: ['id', 'metaAssetName', 'waVerifiedName', 'phoneNumberId', 'additionalData', 'assignmentScope'],
    order: [['metaAssetName', 'ASC'], ['id', 'ASC']],
    subQuery: false,
    raw: true,
  });

  return {
    user,
    profile: profile ? {
      user_id: profile.user_id,
      is_active: Boolean(profile.is_active),
      whatsapp_phone_asset_id: profile.whatsapp_phone_asset_id || null,
      whatsapp: profile.whatsappPhone ? {
        id: profile.whatsappPhone.id,
        name: profile.whatsappPhone.metaAssetName || profile.whatsappPhone.waVerifiedName || null,
        phone: profile.whatsappPhone.additionalData?.display_phone_number || null,
        scope: profile.whatsappPhone.assignmentScope || null,
      } : null,
    } : null,
    clinics: settings.map((row) => ({
      id: row.clinic_id,
      name: row.clinic?.nombre_clinica || `Clínica ${row.clinic_id}`,
      enabled: Boolean(row.is_enabled),
    })),
    whatsapp_assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.metaAssetName || asset.waVerifiedName || `WhatsApp ${asset.id}`,
      phone: asset.additionalData?.display_phone_number || null,
      scope: asset.assignmentScope || null,
    })),
  };
}

async function saveProfile({ userId, isActive, whatsappPhoneAssetId, actorUserId, canManageRole = false }) {
  const uid = positiveInt(userId);
  const actorId = positiveInt(actorUserId);
  if (!uid || !actorId) throw Object.assign(new Error('user_required'), { statusCode: 400 });
  return db.sequelize.transaction(async (transaction) => {
    const user = await Usuario.findByPk(uid, { transaction });
    if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
    let profile = await getPatientDirectorProfile(uid, { transaction, lock: transaction.LOCK.UPDATE });
    const nextActive = canManageRole && isActive !== undefined
      ? Boolean(isActive)
      : Boolean(profile?.is_active);
    const nextAssetId = whatsappPhoneAssetId === undefined
      ? positiveInt(profile?.whatsapp_phone_asset_id)
      : positiveInt(whatsappPhoneAssetId);

    if (!canManageRole && !profile?.is_active) {
      throw Object.assign(new Error('patient_direction_profile_forbidden'), { statusCode: 403 });
    }
    if (!nextActive && profile?.is_active) {
      const activeClinic = await PatientDirectionSetting.findOne({
        where: { director_user_id: uid, is_enabled: true },
        attributes: ['clinic_id'],
        transaction,
        raw: true,
      });
      if (activeClinic) {
        const error = new Error('patient_direction_profile_has_active_clinics');
        error.statusCode = 409;
        error.details = { clinic_id: activeClinic.clinic_id };
        throw error;
      }
    }

    if (nextAssetId) {
      const asset = await ClinicMetaAsset.findByPk(nextAssetId, {
        include: [{ model: db.MetaConnection, as: 'metaConnection', attributes: ['userId'], required: true }],
        transaction,
      });
      if (!asset || asset.assetType !== 'whatsapp_phone_number' || !asset.isActive) {
        throw Object.assign(new Error('patient_direction_whatsapp_invalid'), { statusCode: 422 });
      }
      if (asset.assignmentScope !== 'unassigned') {
        throw Object.assign(new Error('patient_direction_whatsapp_must_be_unassigned'), { statusCode: 422 });
      }
      if (!isGlobalAdmin(actorId) && Number(asset.metaConnection?.userId) !== actorId) {
        throw Object.assign(new Error('patient_direction_whatsapp_out_of_scope'), { statusCode: 403 });
      }
      const duplicate = await PatientDirectionProfile.findOne({
        where: { whatsapp_phone_asset_id: nextAssetId, user_id: { [Op.ne]: uid } },
        attributes: ['user_id'],
        transaction,
        raw: true,
      });
      if (duplicate) {
        throw Object.assign(new Error('patient_direction_whatsapp_already_assigned'), { statusCode: 409 });
      }
    }

    const payload = {
      is_active: nextActive,
      whatsapp_phone_asset_id: nextAssetId,
      updated_by: actorId,
    };
    if (!profile) {
      profile = await PatientDirectionProfile.create({
        user_id: uid,
        created_by: actorId,
        ...payload,
      }, { transaction });
    } else {
      await profile.update(payload, { transaction });
    }
    await PatientDirectionSetting.update(
      { director_phone_asset_id: nextAssetId },
      { where: { director_user_id: uid }, transaction },
    );
    return profile;
  });
}

async function validateSettingValues({
  clinicId,
  directorUserId,
  directorPhoneAssetId,
  clinicPhoneAssetId,
  successorUserId,
  actorUserId = null,
  transaction = null,
}) {
  const cid = positiveInt(clinicId);
  const directorId = positiveInt(directorUserId);
  const requestedDirectorAssetId = positiveInt(directorPhoneAssetId);
  const clinicAssetId = positiveInt(clinicPhoneAssetId);
  const successorId = positiveInt(successorUserId);
  const errors = [];

  if (!cid) errors.push('clinic_required');
  if (!directorId) errors.push('director_required');
  if (!clinicAssetId) errors.push('clinic_whatsapp_required');
  if (!successorId) errors.push('successor_required');

  const [clinic, directorProfile, successorMembership, clinicAsset, directorSettings] = await Promise.all([
    cid ? Clinica.findByPk(cid, { transaction }) : null,
    directorId ? getPatientDirectorProfile(directorId, { transaction }) : null,
    successorId && cid ? getDirectorMembership(successorId, cid, { transaction }) : null,
    clinicAssetId ? ClinicMetaAsset.findByPk(clinicAssetId, { transaction }) : null,
    directorId ? PatientDirectionSetting.findAll({
      where: { director_user_id: directorId, clinic_id: { [Op.ne]: cid } },
      attributes: ['clinic_id', 'director_phone_asset_id'],
      transaction,
      raw: true,
    }) : [],
  ]);

  if (cid && !clinic) errors.push('clinic_not_found');
  const profileDirectorAssetId = positiveInt(directorProfile?.whatsapp_phone_asset_id);
  const directorAssetId = profileDirectorAssetId || requestedDirectorAssetId;
  const assetSettings = directorAssetId ? await PatientDirectionSetting.findAll({
    where: { director_phone_asset_id: directorAssetId, clinic_id: { [Op.ne]: cid } },
    attributes: ['clinic_id', 'director_user_id'],
    transaction,
    raw: true,
  }) : [];
  if (directorId && !directorProfile?.is_active) {
    errors.push('director_profile_required');
  }
  if (directorId && !profileDirectorAssetId) {
    errors.push('director_whatsapp_required');
  }
  if (requestedDirectorAssetId && profileDirectorAssetId && requestedDirectorAssetId !== profileDirectorAssetId) {
    errors.push('director_whatsapp_profile_mismatch');
  }
  if (successorId && !successorMembership) errors.push('successor_membership_required');
  if (directorAssetId && clinicAssetId && directorAssetId === clinicAssetId) {
    errors.push('director_and_clinic_whatsapp_must_differ');
  }
  if (directorSettings.some((row) => Number(row.director_phone_asset_id) !== directorAssetId)) {
    errors.push('director_whatsapp_must_be_shared_across_clinics');
  }
  if (assetSettings.some((row) => Number(row.director_user_id) !== directorId)) {
    errors.push('director_whatsapp_already_assigned');
  }

  if (!isGlobalAdmin(actorUserId)) {
    const availableAssets = await getAvailableWhatsappAssets(cid, {
      actorUserId,
      transaction,
    });
    const availableAssetIds = new Set(availableAssets.map((asset) => Number(asset.id)));
    if (directorAssetId && !availableAssetIds.has(directorAssetId)) {
      errors.push('director_whatsapp_out_of_scope');
    }
    if (clinicAssetId && !availableAssetIds.has(clinicAssetId)) {
      errors.push('clinic_whatsapp_out_of_scope');
    }
  }

  const directorAsset = profileDirectorAssetId
    ? await ClinicMetaAsset.findByPk(profileDirectorAssetId, { transaction })
    : null;
  if (profileDirectorAssetId && (
    !directorAsset
    || directorAsset.assetType !== 'whatsapp_phone_number'
    || !directorAsset.isActive
    || !directorAsset.phoneNumberId
    || !directorAsset.waAccessToken
  )) {
    errors.push('director_whatsapp_invalid');
  }
  if (clinicAssetId && (
    !clinicAsset
    || clinicAsset.assetType !== 'whatsapp_phone_number'
    || !clinicAsset.isActive
    || !clinicAsset.phoneNumberId
    || !clinicAsset.waAccessToken
  )) {
    errors.push('clinic_whatsapp_invalid');
  }
  return {
    valid: errors.length === 0,
    errors,
    clinic,
    directorProfile,
    successorMembership,
    directorAsset,
    clinicAsset,
  };
}

async function recordEvent(assignment, eventType, { actorUserId = null, payload = {}, transaction = null } = {}) {
  if (!assignment || !PatientDirectionEvent) return null;
  return PatientDirectionEvent.create({
    assignment_id: assignment.id,
    clinic_id: assignment.clinic_id || null,
    event_type: eventType,
    actor_user_id: positiveInt(actorUserId),
    payload,
  }, { transaction });
}

async function materializeConversationEvent(assignment, content, kind, { actorUserId = null, payload = {}, transaction = null } = {}) {
  if (!assignment?.conversation_id || !Message) return null;
  return Message.create({
    conversation_id: assignment.conversation_id,
    sender_id: positiveInt(actorUserId),
    direction: 'outbound',
    content,
    message_type: 'event',
    status: 'sent',
    sent_at: new Date(),
    metadata: {
      source: 'patient_direction',
      kind,
      patient_direction_assignment_id: assignment.id,
      ...payload,
    },
  }, { transaction });
}

async function hasHumanContact(leadId, { transaction = null } = {}) {
  const id = positiveInt(leadId);
  if (!id || !LeadContactAttempt) return false;
  return Boolean(await LeadContactAttempt.findOne({
    where: {
      lead_intake_id: id,
      usuario_id: { [Op.ne]: null },
    },
    attributes: ['id'],
    transaction,
    raw: true,
  }));
}

async function findAssignment({
  assignmentId = null,
  clinicId = null,
  phone = null,
  directorPhoneAssetId = null,
  conversationId = null,
  leadId = null,
  patientId = null,
  statuses = ACTIVE_STATUSES,
  transaction = null,
  lock = false,
} = {}) {
  if (!PatientDirectionAssignment) return null;
  const or = [];
  if (positiveInt(conversationId)) or.push({ conversation_id: positiveInt(conversationId) });
  if (positiveInt(leadId)) or.push({ lead_intake_id: positiveInt(leadId) });
  if (positiveInt(patientId)) or.push({ patient_id: positiveInt(patientId) });
  const key = activePhoneKey(phone, directorPhoneAssetId);
  if (key) or.push({ active_phone_key: key });
  else if (normalizePhone(phone)) or.push({ phone_e164: normalizePhone(phone) });
  const where = {
    ...(positiveInt(assignmentId) ? { id: positiveInt(assignmentId) } : {}),
    ...(positiveInt(clinicId) ? { clinic_id: positiveInt(clinicId) } : {}),
    ...(Array.isArray(statuses) && statuses.length ? { status: { [Op.in]: statuses } } : {}),
    ...(!positiveInt(assignmentId) && or.length ? { [Op.or]: or } : {}),
  };
  if (!positiveInt(assignmentId) && !or.length) return null;
  return PatientDirectionAssignment.findOne({
    where,
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

async function ensureAssignment({
  clinicId,
  phone,
  leadId = null,
  conversationId = null,
  patientId = null,
  startReason = 'manual',
  actorUserId = null,
  requireNoHumanContact = true,
  transaction: externalTransaction = null,
} = {}) {
  const cid = positiveInt(clinicId);
  const normalizedPhone = normalizePhone(phone);
  if (!cid || !normalizedPhone || !PatientDirectionAssignment) return null;

  const run = async (transaction) => {
    const setting = await getSetting(cid, { transaction, lock: transaction.LOCK.UPDATE });
    if (!setting?.is_enabled) return null;
    if (requireNoHumanContact && positiveInt(leadId) && await hasHumanContact(leadId, { transaction })) {
      return null;
    }

    const existing = await findAssignment({
      phone: normalizedPhone,
      directorPhoneAssetId: setting.director_phone_asset_id,
      transaction,
      lock: true,
    });
    if (existing) {
      if (existing.clinic_id && Number(existing.clinic_id) !== cid) {
        const error = new Error('patient_direction_phone_already_assigned');
        error.code = 'patient_direction_phone_already_assigned';
        error.assignment = existing;
        throw error;
      }
      const patch = {};
      if (!existing.clinic_id) patch.clinic_id = cid;
      if (!existing.lead_intake_id && positiveInt(leadId)) patch.lead_intake_id = positiveInt(leadId);
      if (!existing.conversation_id && positiveInt(conversationId)) patch.conversation_id = positiveInt(conversationId);
      if (!existing.patient_id && positiveInt(patientId)) patch.patient_id = positiveInt(patientId);
      if (existing.status === 'unassigned') patch.status = 'active';
      if (Object.keys(patch).length) await existing.update(patch, { transaction });
      return existing;
    }

    const assignment = await PatientDirectionAssignment.create({
      clinic_id: cid,
      director_user_id: setting.director_user_id,
      director_phone_asset_id: setting.director_phone_asset_id,
      clinic_phone_asset_id: setting.clinic_phone_asset_id,
      successor_user_id: setting.default_successor_user_id,
      lead_intake_id: positiveInt(leadId),
      conversation_id: positiveInt(conversationId),
      patient_id: positiveInt(patientId),
      phone_e164: normalizedPhone,
      active_phone_key: activePhoneKey(normalizedPhone, setting.director_phone_asset_id),
      status: 'active',
      start_reason: startReason,
      started_by: positiveInt(actorUserId),
      started_at: new Date(),
      metadata: {},
    }, { transaction });

    if (positiveInt(leadId)) {
      await LeadIntake.update(
        { asignado_a: setting.director_user_id },
        { where: { id: positiveInt(leadId) }, transaction }
      );
    }
    await recordEvent(assignment, 'assignment_started', {
      actorUserId,
      payload: { reason: startReason },
      transaction,
    });
    const director = await Usuario.findByPk(setting.director_user_id, {
      attributes: ['nombre', 'apellidos'],
      transaction,
      raw: true,
    });
    const directorName = [director?.nombre, director?.apellidos].filter(Boolean).join(' ') || 'el Director de pacientes';
    await materializeConversationEvent(
      assignment,
      `Este paciente ha comenzado a ser atendido por ${directorName}, Director de pacientes.`,
      'patient_direction_started',
      { actorUserId, transaction }
    );
    return assignment;
  };

  if (externalTransaction) return run(externalTransaction);
  return db.sequelize.transaction(run);
}

async function activateEligibleLeads(setting, { actorUserId = null } = {}) {
  if (!setting?.is_enabled) return { assigned: 0, skipped: 0, conflicts: 0 };
  const leads = await LeadIntake.findAll({
    where: {
      clinica_id: setting.clinic_id,
      status_lead: { [Op.notIn]: TERMINAL_LEAD_STATUSES },
      archived_at: null,
      telefono: { [Op.ne]: null },
    },
    attributes: ['id', 'telefono'],
    raw: true,
  });
  let assigned = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const lead of leads) {
    try {
      const assignment = await ensureAssignment({
        clinicId: setting.clinic_id,
        phone: lead.telefono,
        leadId: lead.id,
        startReason: 'service_activated_existing_lead',
        actorUserId,
        requireNoHumanContact: true,
      });
      if (assignment) assigned += 1;
      else skipped += 1;
    } catch (error) {
      if (error?.code === 'patient_direction_phone_already_assigned') conflicts += 1;
      else throw error;
    }
  }
  return { assigned, skipped, conflicts };
}

async function saveSetting({ clinicId, values, actorUserId, enable = null }) {
  const cid = positiveInt(clinicId);
  if (!cid) throw Object.assign(new Error('clinic_required'), { statusCode: 400 });
  return db.sequelize.transaction(async (transaction) => {
    let setting = await getSetting(cid, { transaction, lock: transaction.LOCK.UPDATE });
    const directorUserId = positiveInt(values?.director_user_id ?? setting?.director_user_id);
    const directorProfile = directorUserId
      ? await getPatientDirectorProfile(directorUserId, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    const directorPhoneAssetId = positiveInt(directorProfile?.whatsapp_phone_asset_id);
    const clinicPhoneAssetId = positiveInt(values?.clinic_phone_asset_id ?? setting?.clinic_phone_asset_id);
    const successorUserId = positiveInt(values?.default_successor_user_id ?? setting?.default_successor_user_id);
    const shouldEnable = enable === null ? Boolean(setting?.is_enabled) : Boolean(enable);

    const hasCompleteConfiguration = Boolean(
      directorUserId && directorPhoneAssetId && clinicPhoneAssetId && successorUserId
    );
    if (shouldEnable || hasCompleteConfiguration) {
      const validation = await validateSettingValues({
        clinicId: cid,
        directorUserId,
        directorPhoneAssetId,
        clinicPhoneAssetId,
        successorUserId,
        actorUserId,
        transaction,
      });
      if (!validation.valid) {
        const error = new Error('patient_direction_configuration_invalid');
        error.code = 'patient_direction_configuration_invalid';
        error.statusCode = 422;
        error.details = validation.errors;
        throw error;
      }
    }

    const payload = {
      clinic_id: cid,
      director_user_id: directorUserId,
      director_phone_asset_id: directorPhoneAssetId,
      clinic_phone_asset_id: clinicPhoneAssetId,
      default_successor_user_id: successorUserId,
      config: values?.config ?? setting?.config ?? {},
      is_enabled: shouldEnable,
      ...(shouldEnable && !setting?.is_enabled ? {
        enabled_by: positiveInt(actorUserId),
        enabled_at: new Date(),
        disabled_by: null,
        disabled_at: null,
      } : {}),
    };
    if (!setting) setting = await PatientDirectionSetting.create(payload, { transaction });
    else await setting.update(payload, { transaction });
    return setting;
  });
}

async function enableSetting({ clinicId, values, actorUserId }) {
  const setting = await saveSetting({ clinicId, values, actorUserId, enable: true });
  const templateProvisioning = await ensureHandoffTemplateForClinic(setting.clinic_id);
  const activation = await activateEligibleLeads(setting, { actorUserId });
  return { setting, activation, templateProvisioning };
}

async function ensureHandoffTemplateForClinic(clinicId) {
  const cid = positiveInt(clinicId);
  if (!cid) return { status: 'clinic_required' };
  const clinicConfig = await whatsappService.getClinicConfig(cid);
  if (!clinicConfig?.wabaId) return { status: 'whatsapp_unavailable' };
  const approved = await WhatsappTemplate.findOne({
    where: {
      is_active: true,
      status: 'APPROVED',
      [Op.or]: [
        { waba_id: clinicConfig.wabaId },
        { clinic_id: cid },
      ],
    },
    include: [{
      model: WhatsappTemplateCatalog,
      as: 'catalog',
      where: { family_key: 'clinicaclick_patient_direction_handoff', locale: 'es' },
      required: true,
    }],
    attributes: ['id'],
  });
  if (approved) return { status: 'ready', template_id: approved.id };

  const catalog = await WhatsappTemplateCatalog.findOne({
    where: {
      family_key: 'clinicaclick_patient_direction_handoff',
      locale: 'es',
      is_active: true,
    },
    attributes: ['id', 'updated_at'],
    raw: true,
  });
  if (!catalog) return { status: 'catalog_missing' };
  const { enqueuePropagateCatalogTemplateJob } = require('./whatsappTemplates.service');
  const job = await enqueuePropagateCatalogTemplateJob({
    templateCatalogId: catalog.id,
    clinicIds: [cid],
    updateCatalogPropagationState: false,
    sourceUpdatedAt: catalog.updated_at || new Date(),
    trigger: 'patient_direction_enable',
  });
  return { status: 'requested', job_id: job?.id || null };
}

async function endAssignment(assignment, {
  reason,
  actorUserId = null,
  successorUserId = null,
  requireHandoff = true,
  transaction = null,
} = {}) {
  if (!assignment || !ACTIVE_STATUSES.includes(assignment.status)) return assignment;
  const finalStatusByReason = {
    first_appointment_attended: 'ended_attended',
    lead_discarded: 'ended_discarded',
    service_disabled: 'ended_service_disabled',
  };
  const finalStatus = finalStatusByReason[reason] || 'handed_off';
  await assignment.update({
    status: requireHandoff ? 'handoff_pending' : finalStatus,
    successor_user_id: positiveInt(successorUserId) || assignment.successor_user_id,
    end_reason: reason,
    ended_by: positiveInt(actorUserId),
    ended_at: new Date(),
    handoff_state: requireHandoff ? 'pending' : 'not_required',
    old_number_notice_state: requireHandoff ? 'pending' : 'not_required',
    active_phone_key: requireHandoff ? assignment.active_phone_key : null,
    metadata: {
      ...(assignment.metadata || {}),
      final_status_after_handoff: finalStatus,
    },
  }, { transaction });
  await recordEvent(assignment, 'assignment_ended', {
    actorUserId,
    payload: { reason, require_handoff: requireHandoff },
    transaction,
  });
  const reasonLabels = {
    first_appointment_attended: 'ya ha asistido a su primera visita',
    lead_discarded: 'el lead ha sido descartado',
    service_disabled: 'se ha desactivado el Director de pacientes en esta clínica',
  };
  await materializeConversationEvent(
    assignment,
    `Este paciente ha dejado de ser atendido por el Director de pacientes porque ${reasonLabels[reason] || 'ha finalizado su seguimiento'}.`,
    'patient_direction_ended',
    { actorUserId, payload: { reason }, transaction }
  );
  return assignment;
}

async function queueHandoff(assignmentOrId) {
  const assignmentId = positiveInt(assignmentOrId?.id || assignmentOrId);
  if (!assignmentId) return { queued: false, reason: 'assignment_required' };
  const assignment = await PatientDirectionAssignment.findByPk(assignmentId, {
    include: [
      { model: Usuario, as: 'director', attributes: ['id_usuario', 'nombre'], required: false },
      { model: Usuario, as: 'successor', attributes: ['id_usuario', 'nombre'], required: false },
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'], required: false },
      { model: Conversation, as: 'conversation', attributes: ['id', 'contact_id'], required: false },
    ],
  });
  if (!assignment || assignment.status !== 'handoff_pending') {
    return { queued: false, reason: 'handoff_not_pending' };
  }
  if (!assignment.conversation_id || !assignment.conversation?.contact_id) {
    await assignment.update({
      status: assignment.metadata?.final_status_after_handoff || 'handed_off',
      handoff_state: 'not_required',
      active_phone_key: null,
    });
    return { queued: false, reason: 'conversation_not_available' };
  }
  const clinicConfig = await whatsappService.getConfigByAssetId(
    assignment.clinic_phone_asset_id,
    { clinicId: assignment.clinic_id }
  );
  if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
    await assignment.update({ handoff_state: 'failed' });
    await recordEvent(assignment, 'handoff_failed', { payload: { reason: 'clinic_whatsapp_unavailable' } });
    return { queued: false, reason: 'clinic_whatsapp_unavailable' };
  }
  const template = await WhatsappTemplate.findOne({
    where: {
      is_active: true,
      status: 'APPROVED',
      [Op.or]: [
        { waba_id: clinicConfig.wabaId || '__missing__' },
        { clinic_id: assignment.clinic_id },
      ],
    },
    include: [{
      model: WhatsappTemplateCatalog,
      as: 'catalog',
      where: { family_key: 'clinicaclick_patient_direction_handoff', locale: 'es' },
      required: true,
    }],
    order: [['updatedAt', 'DESC']],
  });
  if (!template) {
    await assignment.update({ handoff_state: 'failed' });
    await recordEvent(assignment, 'handoff_failed', { payload: { reason: 'approved_template_unavailable' } });
    return { queued: false, reason: 'approved_template_unavailable' };
  }
  const directorName = cleanText(assignment.director?.nombre) || 'mi compañera';
  const successorName = cleanText(assignment.successor?.nombre) || 'el equipo de la clínica';
  const clinicName = cleanText(assignment.clinic?.nombre_clinica) || 'la clínica';
  const templateParams = { 1: directorName, 2: successorName, 3: clinicName };
  const preview = `¡Hola! Has hablado con mi compañera ${directorName}. Soy ${successorName} de ${clinicName}. Sigamos la conversación por este número, que es el de atención al paciente de la clínica. ¿Te parece bien?`;
  const message = await Message.create({
    conversation_id: assignment.conversation_id,
    sender_id: assignment.successor_user_id || null,
    direction: 'outbound',
    content: preview,
    message_type: 'template',
    status: 'pending',
    sent_at: new Date(),
    metadata: {
      source: 'patient_direction',
      kind: 'patient_direction_handoff',
      patient_direction_assignment_id: assignment.id,
      template_id: template.id,
      template_name: template.name,
      template_language: template.language || 'es',
      template_params: templateParams,
      phoneNumberId: clinicConfig.phoneNumberId,
      phoneId: clinicConfig.phoneNumberId,
      wabaId: clinicConfig.wabaId || null,
      sender_origin_id: clinicConfig.originId || null,
    },
  });
  await assignment.update({ handoff_state: 'queued', handoff_message_id: message.id });
  await recordEvent(assignment, 'handoff_queued', { payload: { message_id: message.id } });
  await queues.outboundWhatsApp.add('send', {
    messageId: message.id,
    conversationId: assignment.conversation_id,
    to: normalizePhone(assignment.conversation.contact_id),
    body: preview,
    useTemplate: true,
    templateName: template.name,
    templateLanguage: template.language || 'es',
    templateParams,
    clinicConfig,
  });
  return { queued: true, messageId: message.id };
}

async function retryHandoff({ assignmentId, actorUserId = null }) {
  const assignment = await findAssignment({
    assignmentId,
    statuses: ['handoff_pending'],
  });
  if (!assignment) {
    throw Object.assign(new Error('patient_direction_handoff_not_pending'), { statusCode: 404 });
  }
  await assignment.update({ handoff_state: 'pending' });
  await recordEvent(assignment, 'handoff_retry_requested', { actorUserId });
  return queueHandoff(assignment);
}

async function handleHandoffMessageStatus(message) {
  const metadata = message?.metadata || {};
  if (metadata.kind !== 'patient_direction_handoff') return null;
  const assignmentId = positiveInt(metadata.patient_direction_assignment_id);
  if (!assignmentId) return null;
  const assignment = await PatientDirectionAssignment.findByPk(assignmentId);
  if (!assignment) return null;
  const status = cleanText(message.status).toLowerCase();
  if (status === 'failed') {
    await assignment.update({ handoff_state: 'failed' });
    await recordEvent(assignment, 'handoff_failed', {
      payload: { message_id: message.id, provider_error: metadata.error || null },
    });
    return assignment;
  }
  if (!['sent', 'delivered', 'read'].includes(status)) return assignment;
  if (assignment.handoff_state !== 'sent') {
    await assignment.update({
      status: assignment.metadata?.final_status_after_handoff || 'handed_off',
      handoff_state: 'sent',
      active_phone_key: null,
    });
    await recordEvent(assignment, 'handoff_sent', { payload: { message_id: message.id, status } });
  }
  return assignment;
}

async function disableSetting({ clinicId, successorUserId, actorUserId }) {
  const cid = positiveInt(clinicId);
  const successorId = positiveInt(successorUserId);
  if (!cid || !successorId) {
    throw Object.assign(new Error('clinic_and_successor_required'), { statusCode: 400 });
  }
  const successorMembership = await getDirectorMembership(successorId, cid);
  if (!successorMembership) {
    throw Object.assign(new Error('successor_membership_required'), { statusCode: 422 });
  }

  const result = await db.sequelize.transaction(async (transaction) => {
    const setting = await getSetting(cid, { transaction, lock: transaction.LOCK.UPDATE });
    if (!setting) throw Object.assign(new Error('patient_direction_setting_not_found'), { statusCode: 404 });
    await setting.update({
      is_enabled: false,
      default_successor_user_id: successorId,
      disabled_by: positiveInt(actorUserId),
      disabled_at: new Date(),
    }, { transaction });
    const assignments = await PatientDirectionAssignment.findAll({
      where: { clinic_id: cid, status: { [Op.in]: ['active', 'unassigned', 'handoff_pending'] } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const assignment of assignments) {
      await endAssignment(assignment, {
        reason: 'service_disabled',
        actorUserId,
        successorUserId: successorId,
        requireHandoff: Boolean(assignment.conversation_id),
        transaction,
      });
      if (assignment.lead_intake_id) {
        await LeadIntake.update(
          { asignado_a: successorId },
          { where: { id: assignment.lead_intake_id }, transaction }
        );
      }
    }
    return { setting, affected: assignments.length, assignmentIds: assignments.map((row) => row.id) };
  });
  for (const assignmentId of result.assignmentIds) {
    await queueHandoff(assignmentId).catch((error) => {
      console.warn('[patient-direction] No se pudo encolar el traspaso:', error.message || error);
    });
  }
  return result;
}

async function resolveOutboundPolicy({
  clinicId,
  phone,
  conversationId = null,
  leadId = null,
  patientId = null,
  purpose = 'general',
  actorUserId = null,
  allowTake = false,
  automation = false,
} = {}) {
  const cid = positiveInt(clinicId);
  if (!cid || isConsentPurpose(purpose)) {
    return {
      mode: 'clinic_default',
      clinicConfig: await whatsappService.getClinicConfig(cid),
      assignment: null,
      requiresTakeConfirmation: false,
    };
  }
  let assignment = await findAssignment({
    clinicId: cid,
    phone,
    conversationId,
    leadId,
    patientId,
  });
  if (!assignment && positiveInt(leadId)) {
    assignment = await ensureAssignment({
      clinicId: cid,
      phone,
      leadId,
      conversationId,
      patientId,
      startReason: automation ? 'automatic_first_contact' : 'manual_first_contact',
      actorUserId,
      requireNoHumanContact: true,
    });
  }
  if (!assignment || assignment.status === 'handoff_pending') {
    const setting = await getSetting(cid);
    const clinicConfig = setting?.clinic_phone_asset_id
      ? await whatsappService.getConfigByAssetId(setting.clinic_phone_asset_id, { clinicId: cid })
      : await whatsappService.getClinicConfig(cid);
    return { mode: 'clinic_default', clinicConfig, assignment, requiresTakeConfirmation: false };
  }

  const actorIsDirector = Number(actorUserId) === Number(assignment.director_user_id)
    || await isPatientDirector(actorUserId, cid);
  const takenByUserIds = Array.isArray(assignment.metadata?.taken_by_user_ids)
    ? assignment.metadata.taken_by_user_ids.map(positiveInt).filter(Boolean)
    : [];
  const actorAlreadyTookConversation = takenByUserIds.includes(positiveInt(actorUserId));
  const requiresTakeConfirmation = !automation
    && Boolean(actorUserId)
    && !actorIsDirector
    && !actorAlreadyTookConversation
    && !allowTake;
  const clinicConfig = await whatsappService.getConfigByAssetId(
    assignment.director_phone_asset_id,
    { clinicId: cid }
  );
  if (!clinicConfig) {
    const error = new Error('patient_direction_whatsapp_unavailable');
    error.code = 'patient_direction_whatsapp_unavailable';
    throw error;
  }
  return {
    mode: 'patient_director',
    clinicConfig,
    assignment,
    requiresTakeConfirmation,
    metadata: {
      patient_direction_assignment_id: assignment.id,
      patient_direction_director_user_id: assignment.director_user_id,
      patient_direction_actor_user_id: positiveInt(actorUserId),
      patient_direction_taken_by_clinic_user: !automation && !actorIsDirector,
    },
  };
}

async function registerTake({ assignmentId, actorUserId }) {
  const assignment = await findAssignment({ assignmentId });
  if (!assignment) throw Object.assign(new Error('patient_direction_assignment_not_found'), { statusCode: 404 });
  const userId = positiveInt(actorUserId);
  const takenByUserIds = Array.isArray(assignment.metadata?.taken_by_user_ids)
    ? assignment.metadata.taken_by_user_ids.map(positiveInt).filter(Boolean)
    : [];
  if (userId && !takenByUserIds.includes(userId)) takenByUserIds.push(userId);
  await assignment.update({
    metadata: {
      ...(assignment.metadata || {}),
      taken_by_user_ids: takenByUserIds,
      last_taken_by_user_id: userId,
      last_taken_at: new Date().toISOString(),
    },
  });
  await recordEvent(assignment, 'conversation_taken', {
    actorUserId,
    payload: { sender_remains_director: true },
  });
  await materializeConversationEvent(
    assignment,
    'Un usuario de la clínica ha tomado esta conversación sin cambiar su canal de envío.',
    'patient_direction_taken',
    { actorUserId }
  );
  return assignment;
}

async function handleAppointmentChange({ appointment, previousStatus = null, actorUserId = null }) {
  const cita = appointment?.get ? appointment.get({ plain: true }) : appointment;
  if (!cita) return null;
  const assignment = await findAssignment({
    clinicId: cita.clinica_id,
    leadId: cita.lead_intake_id,
    patientId: cita.paciente_id,
  });
  if (!assignment) return null;
  let shouldLinkAppointment = !assignment.first_appointment_id;
  if (assignment.first_appointment_id && Number(assignment.first_appointment_id) !== Number(cita.id_cita)) {
    const currentFirstAppointment = await CitaPaciente.findByPk(assignment.first_appointment_id, {
      attributes: ['id_cita', 'estado'],
      raw: true,
    });
    shouldLinkAppointment = !currentFirstAppointment
      || ['cancelada', 'no_asistio'].includes(cleanText(currentFirstAppointment.estado).toLowerCase());
  }
  if (shouldLinkAppointment) {
    await assignment.update({ first_appointment_id: cita.id_cita });
    await recordEvent(assignment, 'first_appointment_linked', {
      actorUserId,
      payload: { appointment_id: cita.id_cita },
    });
  }
  if (Number(assignment.first_appointment_id) === Number(cita.id_cita)
      && cleanText(cita.estado).toLowerCase() === 'completada'
      && cleanText(previousStatus).toLowerCase() !== 'completada') {
    const ended = await endAssignment(assignment, {
      reason: 'first_appointment_attended',
      actorUserId,
      successorUserId: assignment.successor_user_id,
      requireHandoff: true,
    });
    await queueHandoff(ended);
    return ended;
  }
  return assignment;
}

async function handleLeadDiscarded({ lead, actorUserId = null }) {
  const row = lead?.get ? lead.get({ plain: true }) : lead;
  if (!row?.id) return null;
  const assignment = await findAssignment({ clinicId: row.clinica_id, leadId: row.id });
  if (!assignment) return null;
  return endAssignment(assignment, {
    reason: 'lead_discarded',
    actorUserId,
    requireHandoff: false,
  });
}

async function resolveInboundDestination({ assetId, phone }) {
  const directorAssetId = positiveInt(assetId);
  const normalizedPhone = normalizePhone(phone);
  if (!directorAssetId || !normalizedPhone) return null;
  const settings = await PatientDirectionSetting.findAll({
    where: { director_phone_asset_id: directorAssetId },
    attributes: ['clinic_id', 'director_user_id', 'is_enabled'],
    raw: true,
  });
  if (!settings.length) return null;
  const assignment = await findAssignment({
    phone: normalizedPhone,
    directorPhoneAssetId,
  });
  if (assignment?.clinic_id) {
    return {
      clinicId: assignment.clinic_id,
      assignmentId: assignment.id,
      source: assignment.status === 'active' ? 'active_assignment' : 'former_assignment',
    };
  }

  const formerAssignment = await PatientDirectionAssignment.findOne({
    where: {
      director_phone_asset_id: directorAssetId,
      phone_e164: normalizedPhone,
      status: { [Op.notIn]: ['active', 'unassigned'] },
    },
    order: [['ended_at', 'DESC'], ['updated_at', 'DESC']],
  });
  if (formerAssignment?.clinic_id) {
    return {
      clinicId: formerAssignment.clinic_id,
      assignmentId: formerAssignment.id,
      source: 'former_assignment',
    };
  }

  const clinicIds = settings.map((row) => positiveInt(row.clinic_id)).filter(Boolean);
  const contactCandidates = [normalizedPhone, normalizedPhone.replace(/^\+/, '')];
  const conversations = await Conversation.findAll({
    where: {
      clinic_id: { [Op.in]: clinicIds },
      channel: 'whatsapp',
      contact_id: { [Op.in]: contactCandidates },
    },
    attributes: ['clinic_id'],
    group: ['clinic_id'],
    raw: true,
  });
  if (conversations.length === 1) {
    return { clinicId: conversations[0].clinic_id, assignmentId: assignment?.id || null, source: 'existing_conversation' };
  }
  const leadCandidates = await LeadIntake.findAll({
    where: { clinica_id: { [Op.in]: clinicIds }, telefono: { [Op.in]: contactCandidates } },
    attributes: ['clinica_id'],
    group: ['clinica_id'],
    raw: true,
  });
  if (leadCandidates.length === 1) {
    return { clinicId: leadCandidates[0].clinica_id, assignmentId: assignment?.id || null, source: 'existing_lead' };
  }
  const enabled = settings.filter((row) => row.is_enabled);
  if (enabled.length === 1) {
    return { clinicId: enabled[0].clinic_id, assignmentId: assignment?.id || null, source: 'single_enabled_clinic' };
  }
  return {
    clinicId: null,
    assignmentId: assignment?.id || null,
    source: 'unassigned',
    directorUserId: settings[0].director_user_id,
  };
}

async function sendOldNumberNotice(assignmentOrId) {
  const assignmentId = positiveInt(assignmentOrId?.id || assignmentOrId);
  const assignment = assignmentId
    ? await PatientDirectionAssignment.findByPk(assignmentId, {
        include: [{ model: Conversation, as: 'conversation', attributes: ['id', 'contact_id'], required: false }],
      })
    : null;
  if (!assignment || assignment.old_number_notice_state === 'sent') {
    return { sent: false, reason: 'notice_not_required' };
  }
  const [directorConfig, clinicAsset] = await Promise.all([
    whatsappService.getConfigByAssetId(assignment.director_phone_asset_id, { clinicId: assignment.clinic_id }),
    ClinicMetaAsset.findByPk(assignment.clinic_phone_asset_id, {
      attributes: ['id', 'additionalData', 'metaAssetName', 'waVerifiedName'],
      raw: true,
    }),
  ]);
  if (!directorConfig?.phoneNumberId || !directorConfig?.accessToken || !assignment.conversation?.contact_id) {
    await assignment.update({ old_number_notice_state: 'failed' });
    return { sent: false, reason: 'director_whatsapp_unavailable' };
  }
  const clinicPhone = cleanText(
    clinicAsset?.additionalData?.display_phone_number
    || clinicAsset?.additionalData?.verified_phone_number
    || clinicAsset?.metaAssetName
  ) || 'habitual de la clínica';
  const content = `Perdona, en este momento no te puedo atender. En breve continuaremos desde el teléfono ${clinicPhone}.`;
  const message = await Message.create({
    conversation_id: assignment.conversation_id,
    sender_id: null,
    direction: 'outbound',
    content,
    message_type: 'text',
    status: 'pending',
    sent_at: new Date(),
    metadata: {
      source: 'patient_direction',
      kind: 'patient_direction_old_number_notice',
      patient_direction_assignment_id: assignment.id,
      phoneNumberId: directorConfig.phoneNumberId,
      phoneId: directorConfig.phoneNumberId,
      wabaId: directorConfig.wabaId || null,
      sender_origin_id: directorConfig.originId || null,
    },
  });
  await queues.outboundWhatsApp.add('send', {
    messageId: message.id,
    conversationId: assignment.conversation_id,
    to: normalizePhone(assignment.conversation.contact_id),
    body: content,
    useTemplate: false,
    clinicConfig: directorConfig,
  });
  await assignment.update({ old_number_notice_state: 'sent' });
  await recordEvent(assignment, 'old_number_notice_sent', { payload: { message_id: message.id } });
  if (assignment.handoff_state !== 'sent') {
    await queueHandoff(assignment).catch(() => null);
  }
  return { sent: true, messageId: message.id };
}

async function captureUnassignedInbound({ assetId, phone, payload }) {
  const normalizedPhone = normalizePhone(phone);
  const settings = await PatientDirectionSetting.findAll({
    where: { director_phone_asset_id: positiveInt(assetId) },
    attributes: ['director_user_id'],
    raw: true,
  });
  if (!normalizedPhone || !settings.length) return null;
  return db.sequelize.transaction(async (transaction) => {
    let assignment = await findAssignment({
      phone: normalizedPhone,
      directorPhoneAssetId: positiveInt(assetId),
      transaction,
      lock: true,
    });
    if (!assignment) {
      assignment = await PatientDirectionAssignment.create({
        clinic_id: null,
        director_user_id: settings[0].director_user_id,
        director_phone_asset_id: positiveInt(assetId),
        phone_e164: normalizedPhone,
        active_phone_key: activePhoneKey(normalizedPhone, positiveInt(assetId)),
        status: 'unassigned',
        start_reason: 'inbound_unassigned',
        metadata: { pending_webhooks: [] },
      }, { transaction });
    }
    const pending = Array.isArray(assignment.metadata?.pending_webhooks)
      ? assignment.metadata.pending_webhooks.slice(-19)
      : [];
    pending.push({ received_at: new Date().toISOString(), payload });
    await assignment.update({
      status: 'unassigned',
      metadata: { ...(assignment.metadata || {}), pending_webhooks: pending },
    }, { transaction });
    await recordEvent(assignment, 'unassigned_inbound_received', { transaction });
    return assignment;
  });
}

async function assignUnassigned({ assignmentId, clinicId, actorUserId }) {
  const aid = positiveInt(assignmentId);
  const cid = positiveInt(clinicId);
  if (!aid || !cid) throw Object.assign(new Error('assignment_and_clinic_required'), { statusCode: 400 });
  return db.sequelize.transaction(async (transaction) => {
    const assignment = await findAssignment({ assignmentId: aid, transaction, lock: true });
    if (!assignment || assignment.status !== 'unassigned') {
      throw Object.assign(new Error('unassigned_inbox_item_not_found'), { statusCode: 404 });
    }
    const setting = await getSetting(cid, { transaction });
    if (!setting || Number(setting.director_phone_asset_id) !== Number(assignment.director_phone_asset_id)) {
      throw Object.assign(new Error('clinic_not_covered_by_director'), { statusCode: 422 });
    }
    const pendingWebhooks = Array.isArray(assignment.metadata?.pending_webhooks)
      ? assignment.metadata.pending_webhooks
      : [];
    await assignment.update({
      clinic_id: cid,
      clinic_phone_asset_id: setting.clinic_phone_asset_id,
      successor_user_id: setting.default_successor_user_id,
      status: 'active',
      metadata: { ...(assignment.metadata || {}), pending_webhooks: [] },
    }, { transaction });
    await recordEvent(assignment, 'unassigned_inbox_assigned', {
      actorUserId,
      payload: { clinic_id: cid, pending_webhooks: pendingWebhooks.length },
      transaction,
    });
    return { assignment, pendingWebhooks };
  });
}

async function getAvailableWhatsappAssets(clinicId, { actorUserId = null, transaction = null } = {}) {
  const cid = positiveInt(clinicId);
  if (!cid) return [];
  const actorId = positiveInt(actorUserId);
  const clinic = await Clinica.findByPk(cid, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    transaction,
    raw: true,
  });
  if (!clinic) return [];

  const where = { assetType: 'whatsapp_phone_number', isActive: true };
  if (!isGlobalAdmin(actorId)) {
    const [currentSetting, actorSettings, actorProfile] = await Promise.all([
      getSetting(cid, { transaction, raw: true }),
      actorId ? PatientDirectionSetting.findAll({
        where: { director_user_id: actorId },
        attributes: ['director_phone_asset_id', 'clinic_phone_asset_id'],
        transaction,
        raw: true,
      }) : [],
      actorId ? getPatientDirectorProfile(actorId, { transaction, raw: true }) : null,
    ]);
    const linkedAssetIds = new Set();
    for (const row of [currentSetting, ...actorSettings].filter(Boolean)) {
      if (positiveInt(row.director_phone_asset_id)) linkedAssetIds.add(positiveInt(row.director_phone_asset_id));
      if (positiveInt(row.clinic_phone_asset_id)) linkedAssetIds.add(positiveInt(row.clinic_phone_asset_id));
    }
    if (positiveInt(actorProfile?.whatsapp_phone_asset_id)) {
      linkedAssetIds.add(positiveInt(actorProfile.whatsapp_phone_asset_id));
    }
    const scope = [
      { clinicaId: cid },
      ...(positiveInt(clinic.grupoClinicaId)
        ? [{ assignmentScope: 'group', grupoClinicaId: positiveInt(clinic.grupoClinicaId) }]
        : []),
      ...(linkedAssetIds.size ? [{ id: { [Op.in]: Array.from(linkedAssetIds) } }] : []),
      ...(actorId ? [{ assignmentScope: 'unassigned', '$metaConnection.userId$': actorId }] : []),
    ];
    where[Op.or] = scope;
  }

  return ClinicMetaAsset.findAll({
    where,
    include: [{
      model: db.MetaConnection,
      as: 'metaConnection',
      attributes: [],
      required: false,
    }],
    attributes: ['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'metaAssetName', 'waVerifiedName', 'phoneNumberId', 'additionalData'],
    order: [['metaAssetName', 'ASC'], ['id', 'ASC']],
    transaction,
    subQuery: false,
    raw: true,
  });
}

async function getCatalog(clinicId, { actorUserId = null } = {}) {
  const cid = positiveInt(clinicId);
  const currentSetting = await getSetting(cid, { raw: true });
  const profileWhere = { is_active: true };
  if (!isGlobalAdmin(actorUserId)) {
    profileWhere.user_id = positiveInt(currentSetting?.director_user_id) || -1;
  }
  const [memberships, assets, profiles] = await Promise.all([
    UsuarioClinica.findAll({
      where: { id_clinica: cid, estado_invitacion: 'aceptada' },
      include: [{ model: Usuario, as: 'Usuario', attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] }],
      order: [[{ model: Usuario, as: 'Usuario' }, 'nombre', 'ASC']],
    }),
    getAvailableWhatsappAssets(cid, { actorUserId }),
    PatientDirectionProfile.findAll({
      where: profileWhere,
      include: [
        { model: Usuario, as: 'user', attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] },
        { model: ClinicMetaAsset, as: 'whatsappPhone', attributes: ['id', 'metaAssetName', 'waVerifiedName', 'additionalData'], required: false },
      ],
      order: [[{ model: Usuario, as: 'user' }, 'nombre', 'ASC']],
    }),
  ]);
  return {
    directors: profiles.map((profile) => ({
      id: profile.user_id,
      name: [profile.user?.nombre, profile.user?.apellidos].filter(Boolean).join(' '),
      avatar: profile.user?.avatar || null,
      whatsapp_asset_id: profile.whatsapp_phone_asset_id || null,
      whatsapp_name: profile.whatsappPhone?.metaAssetName || profile.whatsappPhone?.waVerifiedName || null,
      whatsapp_phone: profile.whatsappPhone?.additionalData?.display_phone_number || null,
    })),
    successors: memberships.map((row) => ({
      id: row.id_usuario,
      name: [row.Usuario?.nombre, row.Usuario?.apellidos].filter(Boolean).join(' '),
      subrole: row.subrol_clinica || null,
      avatar: row.Usuario?.avatar || null,
    })),
    whatsapp_assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.metaAssetName || asset.waVerifiedName || `WhatsApp ${asset.id}`,
      phone: asset.additionalData?.display_phone_number || null,
      clinic_id: asset.clinicaId || null,
      group_id: asset.grupoClinicaId || null,
      scope: asset.assignmentScope || null,
    })),
  };
}

async function getDashboard({ directorUserId, clinicIds = null }) {
  const uid = positiveInt(directorUserId);
  const scopedClinicIds = Array.isArray(clinicIds)
    ? clinicIds.map(positiveInt).filter(Boolean)
    : [];
  const where = {
    director_user_id: uid,
    ...(scopedClinicIds.length ? {
      [Op.or]: [
        { clinic_id: { [Op.in]: scopedClinicIds } },
        { clinic_id: null, status: 'unassigned' },
      ],
    } : {}),
  };
  const assignments = await PatientDirectionAssignment.findAll({
    where,
    include: [
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'], required: false },
      { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'status_lead', 'callback_reminder_at'], required: false },
      { model: Conversation, as: 'conversation', attributes: ['id', 'unread_count', 'last_inbound_at', 'last_message_at'], required: false },
      { model: CitaPaciente, as: 'firstAppointment', attributes: ['id_cita', 'inicio', 'estado'], required: false },
    ],
    order: [['updated_at', 'DESC']],
    limit: 250,
  });
  const plain = assignments.map((row) => row.get({ plain: true }));
  const conversationIds = plain
    .map((row) => positiveInt(row.conversation_id))
    .filter(Boolean);
  const failedMessages = conversationIds.length
    ? await Message.findAll({
        where: {
          conversation_id: { [Op.in]: conversationIds },
          status: 'failed',
          createdAt: { [Op.gte]: new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)) },
        },
        attributes: ['id', 'metadata'],
        raw: true,
      })
    : [];
  const failedReminderCount = failedMessages.filter((message) => {
    const metadata = JSON.stringify(message.metadata || {}).toLowerCase();
    return metadata.includes('reminder')
      || metadata.includes('recordatorio')
      || metadata.includes('appointment');
  }).length;
  const madridDateKey = (value) => {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const bag = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${bag.year}-${bag.month}-${bag.day}`;
  };
  const todayKey = madridDateKey(new Date());
  const coveredSettings = await PatientDirectionSetting.findAll({
    where: {
      director_user_id: uid,
      ...(scopedClinicIds.length ? { clinic_id: { [Op.in]: scopedClinicIds } } : {}),
    },
    include: [{
      model: Clinica,
      as: 'clinic',
      attributes: ['id_clinica', 'nombre_clinica'],
      required: true,
    }],
    order: [[{ model: Clinica, as: 'clinic' }, 'nombre_clinica', 'ASC']],
  });
  const waitingForPatient = (row) => {
    if (row.status !== 'active' || !row.conversation?.last_message_at) return false;
    if (!row.conversation.last_inbound_at) return true;
    return new Date(row.conversation.last_message_at).getTime()
      > new Date(row.conversation.last_inbound_at).getTime();
  };
  const dashboardAssignment = (row) => {
    const pendingWebhooks = Array.isArray(row.metadata?.pending_webhooks)
      ? row.metadata.pending_webhooks
      : [];
    const latestPayload = pendingWebhooks[pendingWebhooks.length - 1]?.payload || null;
    const latestMessage = latestPayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
    const latestPreview = cleanText(
      latestMessage?.text?.body
      || latestMessage?.button?.text
      || latestMessage?.interactive?.button_reply?.title
      || latestMessage?.interactive?.list_reply?.title
    );
    return {
      id: row.id,
      clinic_id: row.clinic_id,
      director_user_id: row.director_user_id,
      lead_intake_id: row.lead_intake_id,
      conversation_id: row.conversation_id,
      patient_id: row.patient_id,
      first_appointment_id: row.first_appointment_id,
      phone_e164: row.phone_e164,
      status: row.status,
      start_reason: row.start_reason,
      started_at: row.started_at,
      end_reason: row.end_reason,
      ended_at: row.ended_at,
      handoff_state: row.handoff_state,
      old_number_notice_state: row.old_number_notice_state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      clinic: row.clinic || null,
      lead: row.lead || null,
      conversation: row.conversation || null,
      firstAppointment: row.firstAppointment || null,
      unassigned_pending_count: pendingWebhooks.length,
      unassigned_latest_preview: latestPreview || null,
    };
  };
  return {
    counters: {
      new_without_contact: plain.filter((row) => row.status === 'active' && row.lead?.status_lead === 'nuevo').length,
      waiting_reply: plain.filter(waitingForPatient).length,
      pending_confirmation: plain.filter((row) => ['pendiente', 'info_enviada', 'recordatorio_enviado'].includes(row.firstAppointment?.estado)).length,
      first_visits_today: plain.filter((row) => madridDateKey(row.firstAppointment?.inicio) === todayKey).length,
      no_show_managed: plain.filter((row) => row.firstAppointment?.estado === 'no_asistio' && row.status === 'active').length,
      follow_up_calls: plain.filter((row) => row.lead?.callback_reminder_at).length,
      failed_reminders: failedReminderCount,
      unassigned: plain.filter((row) => row.status === 'unassigned').length,
      handoff_pending: plain.filter((row) => row.status === 'handoff_pending').length,
    },
    assignments: plain.map(dashboardAssignment),
    clinics: coveredSettings.map((row) => ({
      id: row.clinic.id_clinica,
      name: row.clinic.nombre_clinica,
      enabled: Boolean(row.is_enabled),
    })),
  };
}

module.exports = {
  ACTIVE_STATUSES,
  activateEligibleLeads,
  assignUnassigned,
  captureUnassignedInbound,
  disableSetting,
  enableSetting,
  ensureHandoffTemplateForClinic,
  ensureAssignment,
  findAssignment,
  getCatalog,
  getAssignedClinicIds,
  getAvailableWhatsappAssets,
  getDashboard,
  getProfileDetails,
  getPatientDirectorProfile,
  getSetting,
  handleAppointmentChange,
  handleHandoffMessageStatus,
  handleLeadDiscarded,
  isPatientDirector,
  queueHandoff,
  registerTake,
  retryHandoff,
  resolveInboundDestination,
  resolveOutboundPolicy,
  sendOldNumberNotice,
  saveProfile,
  saveSetting,
  validateSettingValues,
};
