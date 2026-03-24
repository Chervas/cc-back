#!/usr/bin/env node
'use strict';

require('dotenv').config();

const axios = require('axios');
const db = require('../models');
const { syncPhonesForWaba } = require('../src/services/whatsappPhones.service');
const { syncTemplatesForWaba } = require('../src/services/whatsappTemplates.service');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function fetchPhoneDetails({ phoneNumberId, accessToken, version }) {
  if (!phoneNumberId || !accessToken) {
    return null;
  }
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status,status,platform_type,account_mode',
      },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    console.warn('[backfill-whatsapp-legacy-scope] No se pudieron obtener detalles del phone id', err?.response?.data || err?.message || err);
    return null;
  }
}

async function fetchPhoneProfile({ phoneNumberId, accessToken, version }) {
  if (!phoneNumberId || !accessToken) {
    return null;
  }
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/${phoneNumberId}/whatsapp_business_profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        fields: 'about,description,profile_picture_url,vertical,email,websites,address',
      },
      timeout: 20000,
    });
    return Array.isArray(data?.data) ? data.data[0] || null : data || null;
  } catch (err) {
    console.warn('[backfill-whatsapp-legacy-scope] No se pudo obtener el perfil del phone id', err?.response?.data || err?.message || err);
    return null;
  }
}

async function fetchWabaDetails({ wabaId, accessToken, version }) {
  if (!wabaId || !accessToken) {
    return null;
  }
  for (const fields of ['id,name,business_id', 'id,name']) {
    try {
      const { data } = await axios.get(`https://graph.facebook.com/${version}/${wabaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { fields },
        timeout: 20000,
      });
      return data;
    } catch (err) {
      const message = err?.response?.data?.error?.message || '';
      if (fields.includes('business_id') && message.includes('nonexisting field')) {
        continue;
      }
      console.warn('[backfill-whatsapp-legacy-scope] No se pudieron obtener detalles del WABA', err?.response?.data || err?.message || err);
      return null;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const groupId = Number(args['group-id']);
  const metaConnectionId = Number(args['meta-connection-id'] || 0);
  const phoneNumberId = String(
    args['phone-number-id'] ||
      process.env.META_WHATSAPP_PHONE_NUMBER_ID ||
      '101717972850686'
  ).trim();
  const wabaId = args['waba-id'] ? String(args['waba-id']).trim() : null;
  const deactivatePhoneId = args['deactivate-phone-id'] ? String(args['deactivate-phone-id']).trim() : null;
  const markRegistered = !!args['mark-registered'];
  const syncRemote = !args['skip-sync'];
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN || null;
  const graphVersion = process.env.META_GRAPH_VERSION || process.env.META_API_VERSION || 'v24.0';

  if (!groupId) {
    throw new Error('group-id_required');
  }
  if (!metaConnectionId) {
    throw new Error('meta-connection-id_required');
  }
  if (!phoneNumberId) {
    throw new Error('phone-number-id_required');
  }

  const { ClinicMetaAsset, GrupoClinica, MetaConnection } = db;

  const group = await GrupoClinica.findOne({
    where: { id_grupo: groupId },
    attributes: ['id_grupo', 'nombre_grupo'],
    raw: true,
  });
  if (!group) {
    throw new Error(`group_not_found:${groupId}`);
  }

  const metaConnection = await MetaConnection.findByPk(metaConnectionId, {
    attributes: ['id', 'userId', 'userEmail', 'userName'],
    raw: true,
  });
  if (!metaConnection) {
    throw new Error(`meta_connection_not_found:${metaConnectionId}`);
  }

  const phoneDetails = await fetchPhoneDetails({
    phoneNumberId,
    accessToken,
    version: graphVersion,
  });
  const phoneProfile = await fetchPhoneProfile({
    phoneNumberId,
    accessToken,
    version: graphVersion,
  });
  const wabaDetails = await fetchWabaDetails({
    wabaId,
    accessToken,
    version: graphVersion,
  });

  const isConnected = phoneDetails?.status === 'CONNECTED';
  const codeStatus = String(phoneDetails?.code_verification_status || '').toUpperCase();
  const inferredRegistered = markRegistered || isConnected;

  const additionalData = {
    source: wabaId ? 'runtime_whatsapp_backfill' : 'legacy_global_backfill',
    migratedFromEnvFallback: !wabaId,
    migratedFromRuntimeMetadata: !!wabaId,
    graphVersion,
    registration: {
      status: inferredRegistered ? 'registered' : 'not_registered',
      requiresPin: !inferredRegistered,
      phoneStatus: phoneDetails?.status || null,
      codeVerificationStatus: phoneDetails?.code_verification_status || null,
      lastAttemptAt: new Date().toISOString(),
      registeredAt: inferredRegistered ? new Date().toISOString() : null,
    },
    nameStatus: phoneDetails?.name_status || null,
    platformType: phoneDetails?.platform_type || null,
    accountMode: phoneDetails?.account_mode || null,
    legacyGroupLabel: group.nombre_grupo || null,
    profileDescription: phoneProfile?.description || phoneProfile?.about || null,
    profileCategory: phoneProfile?.vertical || null,
    profilePictureUrl: phoneProfile?.profile_picture_url || null,
    profileEmail: phoneProfile?.email || null,
    profileWebsite: phoneProfile?.websites?.[0] || null,
    profileAddress: phoneProfile?.address || null,
    runtimeEvidence: wabaId
      ? {
          phoneNumberId,
          wabaId,
          observedConnected: isConnected,
          observedCodeStatus: codeStatus || null,
        }
      : undefined,
  };

  let wabaAsset = null;
  if (wabaId) {
    const wabaDefaults = {
      metaConnectionId,
      assetType: 'whatsapp_business_account',
      metaAssetId: wabaId,
      metaAssetName: wabaDetails?.name || `WABA ${wabaId}`,
      assignmentScope: 'group',
      grupoClinicaId: groupId,
      clinicaId: null,
      isActive: true,
      wabaId,
      phoneNumberId,
      waAccessToken: accessToken,
      additionalData: {
        source: 'runtime_whatsapp_backfill',
        migratedFromRuntimeMetadata: true,
        graphVersion,
        businessId: wabaDetails?.business_id || null,
        legacyGroupLabel: group.nombre_grupo || null,
      },
    };
    const existingWaba = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_business_account',
        assignmentScope: 'group',
        grupoClinicaId: groupId,
        wabaId,
      },
    });
    if (existingWaba) {
      Object.assign(existingWaba, wabaDefaults, {
        additionalData: {
          ...(existingWaba.additionalData || {}),
          ...wabaDefaults.additionalData,
        },
      });
      await existingWaba.save();
      wabaAsset = existingWaba;
    } else {
      wabaAsset = await ClinicMetaAsset.create(wabaDefaults);
    }
  }

  const defaults = {
    metaConnectionId,
    assetType: 'whatsapp_phone_number',
    metaAssetId: phoneNumberId,
    metaAssetName: phoneDetails?.display_phone_number || phoneNumberId,
    assignmentScope: 'group',
    grupoClinicaId: groupId,
    clinicaId: null,
    isActive: true,
    phoneNumberId,
    wabaId: wabaId || null,
    waVerifiedName: phoneDetails?.verified_name || null,
    quality_rating: phoneDetails?.quality_rating || null,
    messaging_limit: phoneDetails?.messaging_limit_tier || null,
    waAccessToken: accessToken,
    additionalData,
  };

  const where = {
    assetType: 'whatsapp_phone_number',
    assignmentScope: 'group',
    grupoClinicaId: groupId,
    phoneNumberId,
  };

  const existing = await ClinicMetaAsset.findOne({ where });
  let asset;
  if (existing) {
    Object.assign(existing, defaults, {
      additionalData: {
        ...(existing.additionalData || {}),
        ...additionalData,
      },
    });
    await existing.save();
    asset = existing;
  } else {
    asset = await ClinicMetaAsset.create(defaults);
  }

  if (deactivatePhoneId) {
    await ClinicMetaAsset.update(
      {
        isActive: false,
        additionalData: db.sequelize.literal(
          `JSON_SET(COALESCE(additionalData, JSON_OBJECT()), '$.deactivatedReason', 'superseded_by_real_runtime_asset', '$.deactivatedAt', '${new Date().toISOString().slice(0, 19).replace('T', ' ')}')`
        ),
      },
      {
        where: {
          assetType: 'whatsapp_phone_number',
          assignmentScope: 'group',
          grupoClinicaId: groupId,
          phoneNumberId: deactivatePhoneId,
          id: { [db.Sequelize.Op.ne]: asset.id },
        },
      }
    );
  }

  if (syncRemote && wabaId) {
    await syncPhonesForWaba({ wabaId, accessToken });
    await syncTemplatesForWaba({ wabaId, accessToken });
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        group: {
          id: group.id_grupo,
          name: group.nombre_grupo,
        },
        metaConnection,
        asset: {
          id: asset.id,
          assignmentScope: asset.assignmentScope,
          grupoClinicaId: asset.grupoClinicaId,
          phoneNumberId: asset.phoneNumberId,
          metaAssetName: asset.metaAssetName,
          wabaId: asset.wabaId || null,
          waVerifiedName: asset.waVerifiedName || null,
          quality_rating: asset.quality_rating || null,
          messaging_limit: asset.messaging_limit || null,
          isActive: asset.isActive,
        },
        wabaAsset: wabaAsset
          ? {
              id: wabaAsset.id,
              metaAssetName: wabaAsset.metaAssetName,
              wabaId: wabaAsset.wabaId,
              assignmentScope: wabaAsset.assignmentScope,
              grupoClinicaId: wabaAsset.grupoClinicaId,
              isActive: wabaAsset.isActive,
            }
          : null,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('[backfill-whatsapp-legacy-scope] failed', err?.stack || err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
