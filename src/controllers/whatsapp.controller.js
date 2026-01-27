'use strict';
const db = require('../../models');
const { Op } = require('sequelize');
const axios = require('axios');
const crypto = require('crypto');
const whatsappService = require('../services/whatsapp.service');
const { enqueueSyncPhonesJob } = require('../services/whatsappPhones.service');

const {
  ClinicMetaAsset,
  UsuarioClinica,
  Clinica,
  WhatsappTemplate,
  MetaConnection,
  GrupoClinica,
  WhatsappTemplateCatalog,
  WhatsappTemplateCatalogDiscipline,
} = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1').split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !Number.isNaN(n));
const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';
const PHONE_SYNC_THROTTLE_MS = 5 * 60 * 1000;
const phoneSyncThrottle = new Map();

async function getUserClinics(userId) {
  const isAdmin = ADMIN_USER_IDS.includes(Number(userId));
  if (isAdmin) {
    const clinics = await Clinica.findAll({ attributes: ['id_clinica'], raw: true });
    return {
      clinicIds: clinics.map((c) => c.id_clinica),
      isAggregateAllowed: true,
    };
  }
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
  const clinicIds = memberships.map((m) => m.id_clinica);
  const roles = memberships.map((m) => m.rol_clinica);
  const isAggregateAllowed = roles.some((r) => ROLE_AGGREGATE.includes(r));
  return { clinicIds, isAggregateAllowed };
}

function assertAdmin(req, res) {
  const uid = Number(req.userData?.userId);
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

async function getUserGroupIds({ clinicIds, isAggregateAllowed }) {
  if (isAggregateAllowed) {
    const clinics = await Clinica.findAll({
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    return Array.from(
      new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
    );
  }

  if (!clinicIds.length) {
    return [];
  }

  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['grupoClinicaId'],
    raw: true,
  });
  return Array.from(
    new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
  );
}

function parseWaError(err) {
  const base = err?.response?.data || err?.message || err;
  const nestedError = base?.error?.error || base?.error || base;
  const code = nestedError?.code || null;
  const message = nestedError?.message || String(base?.message || base || '');
  return { code, message, raw: base };
}

function generateAutoPin() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

async function ensureAutoPin(asset) {
  const additionalData = asset.additionalData || {};
  const registration = additionalData.registration || {};
  if (registration.autoPin) {
    return registration.autoPin;
  }
  const autoPin = generateAutoPin();
  additionalData.registration = {
    ...registration,
    autoPin,
  };
  asset.additionalData = additionalData;
  await asset.save();
  return autoPin;
}

async function updateRegistrationOnAsset(asset, registration) {
  const additionalData = asset.additionalData || {};
  additionalData.registration = {
    ...(additionalData.registration || {}),
    ...registration,
  };
  asset.additionalData = additionalData;
  await asset.save();
}

async function fetchPhoneStatus({ phoneNumberId, accessToken }) {
  if (!phoneNumberId || !accessToken) {
    return null;
  }
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          fields:
            'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type',
        },
      }
    );
    return resp.data;
  } catch (err) {
    return null;
  }
}

async function attemptPhoneRegistration({ asset, pin }) {
  const nowIso = new Date().toISOString();
  const accessToken = asset.waAccessToken;
  const phoneNumberId = asset.phoneNumberId;
  const explicitPin = pin ? String(pin).trim() : null;
  const autoPin = await ensureAutoPin(asset);

  if (!accessToken || !phoneNumberId) {
    const registration = {
      status: 'error',
      requiresPin: false,
      lastAttemptAt: nowIso,
      lastErrorMessage: 'missing_access_token_or_phone_number_id',
      lastErrorCode: null,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: false, registration };
  }

  try {
    // Si el numero ya esta conectado, no forzamos el registro ni pedimos PIN
    const currentStatus = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    const codeStatus = String(currentStatus?.code_verification_status || '').toUpperCase();
    if (currentStatus?.status === 'CONNECTED' && codeStatus === 'VERIFIED') {
      const registration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: nowIso,
        phoneStatus: currentStatus.status,
        codeVerificationStatus: currentStatus.code_verification_status || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        autoPin: explicitPin || autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: true, registration, status: currentStatus };
    }

    await whatsappService.registerPhoneNumber({
      phoneNumberId,
      accessToken,
      pin: explicitPin || undefined,
    });
    const status = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    const registration = {
      status: 'registered',
      requiresPin: false,
      lastAttemptAt: nowIso,
      registeredAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: null,
      lastErrorMessage: null,
      autoPin: explicitPin || autoPin,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: true, registration, status };
  } catch (err) {
    const { code, message, raw } = parseWaError(err);
    const lower = (message || '').toLowerCase();
    const pinRequired = code === 100 && lower.includes('pin');
    const alreadyRegistered = lower.includes('already registered');

    if (alreadyRegistered) {
      const status = await whatsappService.getPhoneNumberStatus({
        phoneNumberId,
        accessToken,
      });
      const registration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: nowIso,
        phoneStatus: status?.status || null,
        codeVerificationStatus: status?.code_verification_status || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        autoPin: explicitPin || autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: true, registration, status };
    }

    // Intento silencioso con PIN auto-generado antes de pedir intervención humana
    if (pinRequired && !explicitPin) {
      try {
        await whatsappService.registerPhoneNumber({
          phoneNumberId,
          accessToken,
          pin: autoPin,
        });
        const status = await whatsappService.getPhoneNumberStatus({
          phoneNumberId,
          accessToken,
        });
        const registration = {
          status: 'registered',
          requiresPin: false,
          lastAttemptAt: nowIso,
          registeredAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: null,
          lastErrorMessage: null,
          autoPinUsed: true,
          autoPin: explicitPin || autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: true, registration, status };
      } catch (autoErr) {
        const autoParsed = parseWaError(autoErr);
        const autoLower = (autoParsed.message || '').toLowerCase();
        if (autoLower.includes('already registered')) {
          const status = await whatsappService.getPhoneNumberStatus({
            phoneNumberId,
            accessToken,
          });
          const registration = {
            status: 'registered',
            requiresPin: false,
            lastAttemptAt: nowIso,
            registeredAt: nowIso,
            phoneStatus: status?.status || null,
            codeVerificationStatus: status?.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: null,
            autoPinUsed: true,
            autoPin: explicitPin || autoPin,
          };
          await updateRegistrationOnAsset(asset, registration);
          return { success: true, registration, status };
        }
        const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
        const registration = {
          status: 'pin_required',
          requiresPin: true,
          lastAttemptAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: autoParsed.code,
          lastErrorMessage: autoParsed.message,
          lastErrorRaw: autoParsed.raw,
          autoPinUsed: true,
          autoPin: explicitPin || autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: false, registration, status };
      }
    }

    const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
    const registration = {
      status: pinRequired ? 'pin_required' : 'error',
      requiresPin: pinRequired,
      lastAttemptAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: code,
      lastErrorMessage: message,
      lastErrorRaw: raw,
      autoPin: explicitPin || autoPin,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: false, registration, status };
  }
}

exports.getStatus = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }

    const asset = await ClinicMetaAsset.findOne({
      where: {
        clinicaId: clinicId,
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      },
      raw: true,
    });

    if (!asset) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      wabaId: asset.wabaId || null,
      phoneNumberId: asset.phoneNumberId || null,
      waVerifiedName: asset.waVerifiedName || null,
      quality_rating: asset.quality_rating || null,
      messaging_limit: asset.messaging_limit || null,
      phoneNumber: asset.metaAssetName || null,
    });
  } catch (err) {
    console.error('Error getStatus', err);
    return res.status(500).json({ error: 'Error obteniendo estado de WhatsApp' });
  }
};

exports.listAccounts = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };
    if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }
    const assets = await ClinicMetaAsset.findAll({
      where,
      include: [
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      raw: true,
    });

    const payload = assets.map((a) => ({
      clinic_id: a.clinicaId,
      clinic_name: a['clinica.nombre_clinica'] || null,
      wabaId: a.wabaId || null,
      phoneNumberId: a.phoneNumberId || null,
      waVerifiedName: a.waVerifiedName || null,
      quality_rating: a.quality_rating || null,
      messaging_limit: a.messaging_limit || null,
      assignmentScope: a.assignmentScope || 'clinic',
    }));
    return res.json(payload);
  } catch (err) {
    console.error('Error listAccounts', err);
    return res.status(500).json({ error: 'Error obteniendo cuentas WhatsApp' });
  }
};

exports.templatesSummary = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }
    const asset = await ClinicMetaAsset.findOne({
      where: {
        clinicaId: clinicId,
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
      },
      raw: true,
    });
    if (!asset?.wabaId) {
      const placeholders = await WhatsappTemplate.findAll({
        where: { clinic_id: clinicId, waba_id: null, is_active: true },
        attributes: ['status', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
        group: ['status'],
        raw: true,
      });
      const summary = { total: 0, approved: 0, pending: 0, rejected: 0, sin_conectar: 0 };
      placeholders.forEach((row) => {
        summary.total += Number(row.count);
        const st = (row.status || '').toLowerCase();
        if (st === 'sin_conectar') summary.sin_conectar += Number(row.count);
      });
      return res.json(summary);
    }
    const wabaId = asset.wabaId;
    const totals = await WhatsappTemplate.findAll({
      where: { waba_id: wabaId },
      attributes: ['status', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
      group: ['status'],
      raw: true,
    });
    const summary = { total: 0, approved: 0, pending: 0, rejected: 0, sin_conectar: 0 };
    totals.forEach((row) => {
      summary.total += Number(row.count);
      const st = (row.status || '').toLowerCase();
      if (st === 'approved' || st === 'approved_pending') summary.approved += Number(row.count);
      else if (st === 'pending' || st === 'in_review') summary.pending += Number(row.count);
      else if (st === 'rejected') summary.rejected += Number(row.count);
      else if (st === 'sin_conectar') summary.sin_conectar += Number(row.count);
    });
    return res.json(summary);
  } catch (err) {
    console.error('Error templatesSummary', err);
    return res.status(500).json({ error: 'Error obteniendo resumen de plantillas' });
  }
};

async function resolveWabaFromContext({ clinicId, phoneNumberId, userId }) {
  const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
  const where = {
    isActive: true,
    assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
  };

  // Resolver grupo de la clinica para soportar numeros con scope de grupo
  let clinicGroupId = null;
  let userGroupIds = [];
  if (clinicId) {
    const clinic = await Clinica.findOne({
      where: { id_clinica: clinicId },
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    clinicGroupId = clinic?.grupoClinicaId || null;
  }

  if (!isAggregateAllowed && clinicIds.length) {
    const clinics = await Clinica.findAll({
      where: { id_clinica: { [Op.in]: clinicIds } },
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    userGroupIds = Array.from(
      new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
    );
  }

  if (phoneNumberId) {
    where.phoneNumberId = phoneNumberId;
  } else if (clinicId) {
    const clinicScope = [{ clinicaId: clinicId }];
    if (clinicGroupId) {
      clinicScope.push({ assignmentScope: 'group', grupoClinicaId: clinicGroupId });
    }
    where[Op.or] = clinicScope;
  }

  const asset = await ClinicMetaAsset.findOne({
    where,
    include: [{ model: MetaConnection, as: 'metaConnection', attributes: ['userId'] }],
    order: [['updatedAt', 'DESC']],
  });

  if (!asset || isAggregateAllowed) {
    return asset;
  }

  const hasClinicAccess = asset.clinicaId && clinicIds.includes(asset.clinicaId);
  const hasGroupAccess =
    asset.assignmentScope === 'group' &&
    asset.grupoClinicaId &&
    userGroupIds.includes(asset.grupoClinicaId);
  const isUnassignedOwner =
    asset.assignmentScope === 'unassigned' && asset.metaConnection?.userId === userId;

  if (!hasClinicAccess && !hasGroupAccess && !isUnassignedOwner) {
    return null;
  }

  return asset;
}

exports.listTemplatesForClinic = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    let templates = [];
    if (!asset || !asset.wabaId) {
      if (!clinicId) {
        return res.json([]);
      }
      templates = await WhatsappTemplate.findAll({
        where: {
          clinic_id: clinicId,
          waba_id: null,
          is_active: true,
        },
        order: [['name', 'ASC']],
      });
      return res.json(templates);
    }

    templates = await WhatsappTemplate.findAll({
      where: {
        waba_id: asset.wabaId,
        is_active: true,
      },
      order: [['name', 'ASC']],
    });

    return res.json(templates);
  } catch (err) {
    console.error('Error listTemplatesForClinic', err);
    return res.status(500).json({ error: 'Error obteniendo plantillas' });
  }
};

exports.syncTemplates = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId || !asset.waAccessToken) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueSyncTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error syncTemplates', err);
    return res.status(500).json({ error: 'Error sincronizando plantillas' });
  }
};

exports.createTemplatesFromCatalog = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueCreateTemplatesJob({
      wabaId: asset.wabaId,
      clinicId: asset.clinicaId || null,
      groupId: asset.grupoClinicaId || null,
      assignmentScope: asset.assignmentScope || 'clinic',
    });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error createTemplatesFromCatalog', err);
    return res.status(500).json({ error: 'Error creando plantillas' });
  }
};

exports.listPhones = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const clinicIdFilter = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    let groupIdFromClinic = null;
    if (clinicIdFilter) {
      const clinic = await Clinica.findOne({ where: { id_clinica: clinicIdFilter }, attributes: ['grupoClinicaId'], raw: true });
      groupIdFromClinic = clinic?.grupoClinicaId || null;
    }

    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };

    if (clinicIdFilter) {
      where[Op.or] = [
        { clinicaId: clinicIdFilter },
        { assignmentScope: 'group', grupoClinicaId: groupIdFromClinic },
      ];
    } else if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'group', grupoClinicaId: { [Op.in]: clinicIds.length ? clinicIds : [-1] } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }

    const phones = await ClinicMetaAsset.findAll({
      where,
      include: [
        { 
          model: Clinica, 
          as: 'clinica', 
          attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'grupoClinicaId'],
          include: [{
            model: GrupoClinica,
            as: 'grupoClinica',
            attributes: ['id_grupo', 'nombre_grupo']
          }]
        },
        {
          // Necesario cuando el scope es "group" y no hay clinicaId
          model: GrupoClinica,
          as: 'grupoClinica',
          attributes: ['id_grupo', 'nombre_grupo'],
        },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    // Disparar sync on-demand con throttling para reducir estados stale
    const now = Date.now();
    const wabaTokens = new Map();
    for (const p of phones) {
      if (p.wabaId && p.waAccessToken && !wabaTokens.has(p.wabaId)) {
        wabaTokens.set(p.wabaId, p.waAccessToken);
      }
    }
    for (const [wabaId, accessToken] of wabaTokens.entries()) {
      const lastTriggered = phoneSyncThrottle.get(wabaId) || 0;
      if (now - lastTriggered < PHONE_SYNC_THROTTLE_MS) {
        continue;
      }
      phoneSyncThrottle.set(wabaId, now);
      enqueueSyncPhonesJob({ wabaId, accessToken }).catch((err) => {
        console.warn('[whatsapp] No se pudo encolar sync de phones', err?.message || err);
      });
    }

    const payload = [];

    for (const p of phones) {
      const clinica = p.clinica || {};
      const grupoDirecto = p.grupoClinica || {};
      const grupoClinica = clinica.grupoClinica || {};
      const grupo = grupoDirecto.id_grupo ? grupoDirecto : grupoClinica;
      let registration = p.additionalData?.registration || null;

      // Normaliza el estado si el numero ya aparece como CONNECTED en Meta
      if (
        registration?.status !== 'registered' &&
        p.phoneNumberId &&
        p.waAccessToken
      ) {
        const liveStatus = await fetchPhoneStatus({
          phoneNumberId: p.phoneNumberId,
          accessToken: p.waAccessToken,
        });
        const codeStatus = String(liveStatus?.code_verification_status || '').toUpperCase();
        if (liveStatus?.status === 'CONNECTED' && codeStatus === 'VERIFIED') {
          const nowIso = new Date().toISOString();
          registration = {
            status: 'registered',
            requiresPin: false,
            lastAttemptAt: nowIso,
            registeredAt: registration?.registeredAt || nowIso,
            phoneStatus: liveStatus.status,
            codeVerificationStatus: liveStatus.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: null,
          };
          await updateRegistrationOnAsset(p, registration);
        } else if (liveStatus?.status === 'CONNECTED' && codeStatus && registration?.status !== 'registered') {
          const nowIso = new Date().toISOString();
          registration = {
            status: 'not_registered',
            requiresPin: true,
            lastAttemptAt: nowIso,
            registeredAt: registration?.registeredAt || null,
            phoneStatus: liveStatus.status,
            codeVerificationStatus: liveStatus.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: registration?.lastErrorMessage || null,
          };
          await updateRegistrationOnAsset(p, registration);
        }
      }

      const usage = await whatsappService.getOutboundUsageForPhone({
        clinicConfig: {
          assignmentScope: p.assignmentScope,
          clinicaId: p.clinicaId,
          grupoClinicaId: p.grupoClinicaId,
          additionalData: p.additionalData || {},
        },
        displayPhoneNumber: p.metaAssetName || null,
      });

      payload.push({
        id: p.id,
        phoneNumberId: p.phoneNumberId,
        wabaId: p.wabaId,
        phoneNumber: p.metaAssetName || null,
        waVerifiedName: p.waVerifiedName || null,
        quality_rating: p.quality_rating || null,
        messaging_limit: p.messaging_limit || null,
        assignmentScope: p.assignmentScope,
        clinic_id: p.clinicaId || null,
        clinic_name: clinica.nombre_clinica || null,
        clinic_avatar: clinica.url_avatar || null,
        group_id: grupo.id_grupo || p.grupoClinicaId || clinica.grupoClinicaId || null,
        group_name: grupo.nombre_grupo || null,
        name_status: p.additionalData?.nameStatus || null,
        name_status_reason: p.additionalData?.nameStatusReason || null,
        requested_display_name: p.additionalData?.requestedDisplayName || null,
        registration_status: registration?.status || null,
        registration_requires_pin: registration?.requiresPin || false,
        registration_phone_status: registration?.phoneStatus || null,
        registration_last_error: registration?.lastErrorMessage || null,
        limited_mode: usage?.limitedMode || false,
        limited_mode_count: usage?.limitedMode ? usage.count : null,
        limited_mode_limit: usage?.limitedMode ? usage.limit : null,
        createdAt: p.createdAt,
      });
    }

    return res.json({ phones: payload });
  } catch (err) {
    console.error('Error listPhones', err);
    return res.status(500).json({ error: 'Error obteniendo números WhatsApp' });
  }
};

// =======================
// Catálogo de plantillas
// =======================

exports.listCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const items = await WhatsappTemplateCatalog.findAll({
      include: [
        {
          model: WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['id', 'disciplina_code'],
        },
      ],
      order: [['name', 'ASC']],
    });
    return res.json(items);
  } catch (err) {
    console.error('Error listCatalog', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.createCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, display_name, category, body_text, variables, components, is_generic = false, is_active = true } = req.body || {};
    if (!name || !category || !body_text) {
      return res.status(400).json({ error: 'name, category y body_text son obligatorios' });
    }
    const item = await WhatsappTemplateCatalog.create({
      name,
      display_name: display_name || null,
      category,
      body_text,
      variables: variables || null,
      components: components || null,
      is_generic: !!is_generic,
      is_active: !!is_active,
    });
    return res.status(201).json(item);
  } catch (err) {
    console.error('Error createCatalog', err);
    return res.status(500).json({ error: 'Error creando catálogo' });
  }
};

exports.updateCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const { display_name, category, body_text, variables, components, is_generic, is_active, name } = req.body || {};
    await item.update({
      name: name || item.name,
      display_name: display_name !== undefined ? display_name : item.display_name,
      category: category || item.category,
      body_text: body_text || item.body_text,
      variables: variables !== undefined ? variables : item.variables,
      components: components !== undefined ? components : item.components,
      is_generic: is_generic !== undefined ? !!is_generic : item.is_generic,
      is_active: is_active !== undefined ? !!is_active : item.is_active,
    });
    return res.json(item);
  } catch (err) {
    console.error('Error updateCatalog', err);
    return res.status(500).json({ error: 'Error actualizando catálogo' });
  }
};

exports.deleteCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const inUse = await WhatsappTemplate.count({ where: { catalog_template_id: id } });
    if (inUse > 0) {
      return res.status(400).json({ error: 'catalog_in_use' });
    }
    await WhatsappTemplateCatalog.destroy({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleteCatalog', err);
    return res.status(500).json({ error: 'Error eliminando catálogo' });
  }
};

exports.toggleCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });
    const newState = req.body?.is_active;
    if (newState === undefined) {
      item.is_active = !item.is_active;
    } else {
      item.is_active = !!newState;
    }
    await item.save();
    return res.json(item);
  } catch (err) {
    console.error('Error toggleCatalog', err);
    return res.status(500).json({ error: 'Error actualizando estado' });
  }
};

exports.setCatalogDisciplines = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const disciplinaCodes = Array.isArray(req.body?.disciplina_codes) ? req.body.disciplina_codes : [];
    await WhatsappTemplateCatalogDiscipline.destroy({ where: { template_catalog_id: id } });

    if (disciplinaCodes.length) {
      const rows = disciplinaCodes.map((code) => ({
        template_catalog_id: id,
        disciplina_code: code,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      await WhatsappTemplateCatalogDiscipline.bulkCreate(rows);
    }
    const updated = await WhatsappTemplateCatalog.findByPk(id, {
      include: [{ model: WhatsappTemplateCatalogDiscipline, as: 'disciplinas', attributes: ['id', 'disciplina_code'] }],
    });
    return res.json(updated);
  } catch (err) {
    console.error('Error setCatalogDisciplines', err);
    return res.status(500).json({ error: 'Error actualizando disciplinas' });
  }
};

exports.assignPhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const { assignmentScope, clinic_id } = req.body || {};

    if (!['group', 'clinic'].includes(assignmentScope)) {
      return res.status(400).json({ success: false, error: 'invalid_assignment_scope' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId: phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        // Ajustar a columna grupoClinicaId (no id_grupo)
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const canManage =
      isOwner ||
      isAggregateAllowed ||
      (phone.clinicaId && clinicIds.includes(phone.clinicaId)) ||
      assignmentScope === 'clinic';

    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    let targetClinicId = null;
    let targetGroupId = null;

    if (assignmentScope === 'clinic') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetClinicId = clinic_id;
      targetGroupId = clinic.grupoClinicaId || null;
    } else if (assignmentScope === 'group') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required_for_group' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetGroupId = clinic.grupoClinicaId || null;
    }

    await phone.update({
      assignmentScope,
      clinicaId: targetClinicId,
      grupoClinicaId: targetGroupId,
    });

    // Encolar creación automática de plantillas al asignar
    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    if (phone.wabaId && assignmentScope !== 'unassigned') {
      enqueueCreateTemplatesJob({
        wabaId: phone.wabaId,
        clinicId: targetClinicId,
        groupId: targetGroupId,
        assignmentScope,
      }).catch((err) => {
        console.error('Error encolando plantillas al asignar número', err?.message || err);
      });
    }

    // Intentar registrar automaticamente el numero en la Cloud API
    let registrationResult = null;
    try {
      registrationResult = await attemptPhoneRegistration({ asset: phone });
    } catch (regErr) {
      console.warn('No se pudo registrar el numero automaticamente', regErr?.message || regErr);
    }

    return res.json({
      success: true,
      phoneNumberId,
      assignmentScope,
      clinic_id: targetClinicId,
      clinic_name: phone.clinica?.nombre_clinica || null,
      registration: registrationResult?.registration || null,
    });
  } catch (err) {
    console.error('Error assignPhone', err);
    return res.status(500).json({ success: false, error: 'assign_failed' });
  }
};

exports.registerPhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const pin = req.body?.pin;

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const result = await attemptPhoneRegistration({ asset: phone, pin });
    const error =
      result.success
        ? null
        : result.registration?.requiresPin
        ? 'pin_required'
        : 'registration_failed';

    return res.json({
      success: result.success,
      phoneNumberId,
      registration: result.registration,
      status: result.status || null,
      error,
    });
  } catch (err) {
    console.error('Error registerPhone', err);
    return res.status(500).json({ success: false, error: 'register_failed' });
  }
};

exports.updatePhoneDisplayName = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const displayName =
      req.body?.display_name ||
      req.body?.displayName ||
      req.body?.name ||
      null;

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ success: false, error: 'phone_number_id_required' });
    }
    if (!displayName) {
      return res
        .status(400)
        .json({ success: false, error: 'display_name_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const additionalData = phone.additionalData || {};
    additionalData.requestedDisplayName = String(displayName).trim();
    additionalData.requestedDisplayNameAt = new Date().toISOString();
    phone.additionalData = additionalData;
    await phone.save();

    return res.json({
      success: true,
      phoneNumberId,
      requestedDisplayName: additionalData.requestedDisplayName,
      manualRequired: true,
      managerUrl: 'https://business.facebook.com/wa/manage/phone-numbers/',
    });
  } catch (err) {
    console.error('Error updatePhoneDisplayName', err);
    return res
      .status(500)
      .json({ success: false, error: 'display_name_update_failed' });
  }
};

exports.deletePhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: { assetType: 'whatsapp_phone_number', phoneNumberId, isActive: true },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId ? clinicIds.includes(phone.clinicaId) : false;
    const canManage = isOwner || isAggregateAllowed || hasClinicAccess;
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    await phone.update({
      isActive: false,
      assignmentScope: 'unassigned',
      clinicaId: null,
      grupoClinicaId: null,
    });

    if (phone.wabaId) {
      await ClinicMetaAsset.update(
        {
          isActive: false,
          assignmentScope: 'unassigned',
          clinicaId: null,
          grupoClinicaId: null,
        },
        { where: { assetType: 'whatsapp_business_account', wabaId: phone.wabaId } }
      );
    }

    return res.json({ success: true, phoneNumberId });
  } catch (err) {
    console.error('Error deletePhone', err);
    return res.status(500).json({ success: false, error: 'delete_failed' });
  }
};
