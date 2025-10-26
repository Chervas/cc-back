'use strict';

const { Op } = require('sequelize');
const {
  sequelize,
  GrupoClinica,
  Clinica,
  ClinicMetaAsset,
  ClinicWebAsset,
  ClinicAnalyticsProperty,
  ClinicBusinessLocation,
  ClinicGoogleAdsAccount
} = require('../../models');

const MODE_VALUES = ['group', 'clinic'];

const META_TYPES = {
  facebook: 'facebook_page',
  instagram: 'instagram_business'
};

const GOOGLE_MODE_CONFIG = {
  searchConsole: {
    modeField: 'search_console_assignment_mode',
    primaryField: 'search_console_primary_asset_id',
    updatedField: 'search_console_assignment_updated_at',
    model: ClinicWebAsset,
    activeField: 'isActive',
    clinicField: 'clinicaId',
    extraFields: ['siteUrl', 'propertyType', 'permissionLevel', 'googleConnectionId']
  },
  analytics: {
    modeField: 'analytics_assignment_mode',
    primaryField: 'analytics_primary_property_id',
    updatedField: 'analytics_assignment_updated_at',
    model: ClinicAnalyticsProperty,
    activeField: 'isActive',
    clinicField: 'clinicaId',
    extraFields: ['propertyName', 'propertyDisplayName', 'measurementId', 'googleConnectionId']
  },
  businessProfile: {
    modeField: 'business_profile_assignment_mode',
    primaryField: 'business_profile_primary_location_id',
    updatedField: 'business_profile_assignment_updated_at',
    model: ClinicBusinessLocation,
    activeField: 'is_active',
    clinicField: 'clinica_id',
    extraFields: ['location_name', 'location_id', 'google_connection_id']
  }
};

const CONNECTION_STATUSES = {
  connected: 'connected',
  disconnected: 'disconnected'
};

async function _loadGroupContext(groupId) {
  const group = await GrupoClinica.findByPk(groupId, {
    include: [{ model: Clinica, as: 'clinicas', attributes: ['id_clinica', 'nombre_clinica', 'url_web'] }]
  });

  if (!group) {
    return null;
  }

  const plainGroup = group.get({ plain: true });
  const clinics = Array.isArray(plainGroup.clinicas) ? plainGroup.clinicas : [];
  const clinicIds = clinics.map(c => c.id_clinica).filter(Number.isInteger);

  return {
    group: plainGroup,
    clinics,
    clinicIds
  };
}

function _buildConnectionStatus(records, connectionModel) {
  if (!records.length) {
    return {
      status: CONNECTION_STATUSES.disconnected,
      connections: []
    };
  }

  const connectionIds = Array.from(
    new Set(
      records
        .map(item => item[connectionModel.field])
        .filter(Boolean)
    )
  );

  return {
    status: connectionIds.length ? CONNECTION_STATUSES.connected : CONNECTION_STATUSES.disconnected,
    connections: connectionIds
  };
}

function _serializeMetaAsset(asset) {
  return {
    id: asset.id,
    assetId: asset.metaAssetId,
    name: asset.metaAssetName,
    type: asset.assetType,
    clinicaId: asset.clinicaId,
    assignmentScope: asset.assignmentScope,
    grupoClinicaId: asset.grupoClinicaId,
    isActive: asset.isActive,
    avatarUrl: asset.assetAvatarUrl,
    connectionId: asset.metaConnectionId
  };
}

function _serializeGoogleAsset(asset, activeFieldName, clinicField) {
  const plain = asset.get ? asset.get({ plain: true }) : asset;
  const clinicId = plain.clinicaId ?? plain.clinica_id ?? plain[clinicField] ?? null;
  const json = {
    ...plain,
    id: plain.id,
    clinicaId: clinicId
  };

  if (activeFieldName) {
    json.isActive = Boolean(plain[activeFieldName]);
  }

  delete json.created_at;
  delete json.updated_at;
  delete json.clinica;
  delete json.connection;

  return json;
}

async function getGroupConfig(groupId) {
  const ctx = await _loadGroupContext(groupId);
  if (!ctx) {
    return null;
  }

  const { group, clinics } = ctx;
  let clinicIds = Array.isArray(ctx.clinicIds) ? [...ctx.clinicIds] : [];

  // Ads existentes (Meta/Google Ads) se mantienen igual
  const metaAdsAccounts = await ClinicMetaAsset.findAll({
    where: {
      assetType: 'ad_account',
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: group.id_grupo }
      ],
      isActive: true
    },
    attributes: ['id', 'metaAssetId', 'metaAssetName', 'assignmentScope', 'clinicaId', 'grupoClinicaId']
  });

  const googleAdsAccounts = await ClinicGoogleAdsAccount.findAll({
    where: {
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: group.id_grupo }
      ],
      isActive: true
    },
    attributes: ['id', 'customerId', 'descriptiveName', 'assignmentScope', 'clinicaId', 'grupoClinicaId']
  });

  // Meta (Facebook / Instagram)
  const metaAssets = await ClinicMetaAsset.findAll({
    where: {
      assetType: { [Op.in]: Object.values(META_TYPES) },
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: group.id_grupo }
      ]
    },
    order: [['assetType', 'ASC'], ['metaAssetName', 'ASC']]
  });

  const metaByType = {
    facebook: [],
    instagram: []
  };
  metaAssets.forEach(asset => {
    if (asset.assetType === META_TYPES.facebook) {
      metaByType.facebook.push(_serializeMetaAsset(asset));
    }
    if (asset.assetType === META_TYPES.instagram) {
      metaByType.instagram.push(_serializeMetaAsset(asset));
    }
  });

  const metaClinicAssignments = {
    facebook: {},
    instagram: {}
  };

  const tiktokAssignments = {};

  clinicIds.forEach(id => {
    const key = String(id);
    metaClinicAssignments.facebook[key] = null;
    metaClinicAssignments.instagram[key] = null;
    tiktokAssignments[key] = null;
  });

  metaByType.facebook.forEach(asset => {
    if (asset.clinicaId && asset.isActive) {
      metaClinicAssignments.facebook[String(asset.clinicaId)] = asset.id;
    }
  });

  metaByType.instagram.forEach(asset => {
    if (asset.clinicaId && asset.isActive) {
      metaClinicAssignments.instagram[String(asset.clinicaId)] = asset.id;
    }
  });

  const metaConnectionStatus = _buildConnectionStatus(metaAssets, { field: 'metaConnectionId' });

  // Google assets
  const googleData = {};
  const googleConnectionIds = new Set();

  for (const key of Object.keys(GOOGLE_MODE_CONFIG)) {
    const config = GOOGLE_MODE_CONFIG[key];
    const clinicField = config.clinicField || 'clinicaId';
    const whereClause = {};
    whereClause[clinicField] = { [Op.in]: clinicIds };

    const rows = await config.model.findAll({ where: whereClause });

    const items = [];
    const assignments = {};
    clinicIds.forEach(id => { assignments[id] = null; });

    rows.forEach(row => {
      const plain = _serializeGoogleAsset(row, config.activeField, clinicField);
      items.push(plain);

      if (plain.clinicaId && plain.isActive) {
        assignments[plain.clinicaId] = plain.id;
      }

      const connId = plain.googleConnectionId || plain.google_connection_id;
      if (connId) {
        googleConnectionIds.add(connId);
      }
    });

    const assignmentsByClinic = {};
    Object.keys(assignments).forEach(id => {
      assignmentsByClinic[String(id)] = assignments[id];
    });

    googleData[key] = { items, assignments: assignmentsByClinic };
  }

  const googleConnectionStatus = {
    status: googleConnectionIds.size ? CONNECTION_STATUSES.connected : CONNECTION_STATUSES.disconnected,
    connections: Array.from(googleConnectionIds)
  };

  const clinicSummaries = clinics.map(c => ({ id: c.id_clinica, nombre: c.nombre_clinica }));
  const clinicUrlMap = {};
  clinics.forEach(clinic => {
    clinicUrlMap[String(clinic.id_clinica)] = clinic.url_web || null;
  });

  const searchConsoleData = googleData.searchConsole || { items: [], assignments: {} };
  const analyticsData = googleData.analytics || { items: [], assignments: {} };
  const businessProfileData = googleData.businessProfile || { items: [], assignments: {} };

  const response = {
    id: group.id_grupo,
    nombre: group.nombre_grupo,
    ads: {
      mode: group.ads_assignment_mode,
      delimiter: group.ads_assignment_delimiter,
      lastRun: group.ads_assignment_last_run
    },
    web: {
      mode: group.web_assignment_mode,
      primaryUrl: group.web_primary_url,
      updatedAt: group.web_assignment_updated_at,
      clinicUrls: clinicUrlMap
    },
    clinics: clinicSummaries,
    assets: {
      meta: {
        facebook: {
          mode: group.facebook_assignment_mode,
          primaryAssetId: group.facebook_primary_asset_id,
          updatedAt: group.facebook_assignment_updated_at,
          items: metaByType.facebook,
          clinicAssignments: metaClinicAssignments.facebook
        },
        instagram: {
          mode: group.instagram_assignment_mode,
          primaryAssetId: group.instagram_primary_asset_id,
          updatedAt: group.instagram_assignment_updated_at,
          items: metaByType.instagram,
          clinicAssignments: metaClinicAssignments.instagram
        },
        tiktok: {
          mode: group.tiktok_assignment_mode,
          primaryAssetId: group.tiktok_primary_asset_id,
          updatedAt: group.tiktok_assignment_updated_at,
          items: [],
          clinicAssignments: tiktokAssignments
        }
      },
      google: {
        searchConsole: {
          mode: group.search_console_assignment_mode,
          primaryAssetId: group.search_console_primary_asset_id,
          updatedAt: group.search_console_assignment_updated_at,
          items: searchConsoleData.items,
          clinicAssignments: searchConsoleData.assignments
        },
        analytics: {
          mode: group.analytics_assignment_mode,
          primaryAssetId: group.analytics_primary_property_id,
          updatedAt: group.analytics_assignment_updated_at,
          items: analyticsData.items,
          clinicAssignments: analyticsData.assignments
        },
        businessProfile: {
          mode: group.business_profile_assignment_mode,
          primaryAssetId: group.business_profile_primary_location_id,
          updatedAt: group.business_profile_assignment_updated_at,
          items: businessProfileData.items,
          clinicAssignments: businessProfileData.assignments
        }
      },
      ads: {
        meta: metaAdsAccounts,
        google: googleAdsAccounts
      }
    },
    connections: {
      meta: metaConnectionStatus,
      google: googleConnectionStatus
    }
  };

  return response;
}

function _ensureValidMode(value, field) {
  if (value == null) {
    return null;
  }
  if (!MODE_VALUES.includes(value)) {
    throw new Error(`Valor inválido para ${field}: ${value}`);
  }
  return value;
}

async function _updateMetaAssignments({ type, mode, primaryAssetId, clinicAssignments = {}, groupId, clinicIds, transaction }) {
  const assetType = META_TYPES[type];
  if (!assetType) {
    return;
  }

  const now = new Date();

  if (mode === 'group') {
    if (!primaryAssetId) {
      throw new Error(`Debes seleccionar un activo principal para ${type} en modo grupo`);
    }

    const selectedAsset = await ClinicMetaAsset.findOne({
      where: {
        id: primaryAssetId,
        assetType,
        [Op.or]: [
          { clinicaId: { [Op.in]: clinicIds } },
          { grupoClinicaId: groupId }
        ]
      },
      transaction
    });

    if (!selectedAsset) {
      throw new Error(`El activo seleccionado (${primaryAssetId}) no pertenece a este grupo`);
    }

    await ClinicMetaAsset.update(
      { assignmentScope: 'clinic', grupoClinicaId: null },
      {
        where: {
          assetType,
          clinicaId: { [Op.in]: clinicIds },
          id: { [Op.ne]: primaryAssetId }
        },
        transaction
      }
    );

    await ClinicMetaAsset.update(
      { isActive: false },
      {
        where: {
          assetType,
          clinicaId: { [Op.in]: clinicIds },
          id: { [Op.ne]: primaryAssetId },
          isActive: true
        },
        transaction
      }
    );

    await ClinicMetaAsset.update(
      {
        assignmentScope: 'group',
        grupoClinicaId: groupId,
        isActive: true
      },
      {
        where: { id: primaryAssetId },
        transaction
      }
    );

    await GrupoClinica.update(
      {
        [`${type}_assignment_mode`]: mode,
        [`${type}_primary_asset_id`]: primaryAssetId,
        [`${type}_assignment_updated_at`]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );
  } else if (mode === 'clinic') {
    await ClinicMetaAsset.update(
      { assignmentScope: 'clinic', grupoClinicaId: null },
      {
        where: {
          assetType,
          clinicaId: { [Op.in]: clinicIds }
        },
        transaction
      }
    );

    const clinicIdsToProcess = Object.keys(clinicAssignments).map(id => parseInt(id, 10)).filter(id => clinicIds.includes(id));

    for (const clinicaId of clinicIdsToProcess) {
      const selectedId = clinicAssignments[clinicaId];
      const assets = await ClinicMetaAsset.findAll({
        where: { assetType, clinicaId, isActive: true },
        transaction
      });

      const selected = selectedId
        ? assets.find(a => a.id === selectedId)
        : null;

      if (selectedId && !selected) {
        const exists = await ClinicMetaAsset.findOne({
          where: { id: selectedId, assetType, clinicaId },
          transaction
        });
        if (!exists) {
          throw new Error(`El activo ${selectedId} no pertenece a la clínica ${clinicaId}`);
        }
      }

      const activeIds = assets.map(a => a.id);
      if (activeIds.length) {
        await ClinicMetaAsset.update(
          { isActive: false },
          { where: { id: activeIds }, transaction }
        );
      }

      if (selectedId) {
        await ClinicMetaAsset.update(
          { isActive: true },
          { where: { id: selectedId }, transaction }
        );
      }
    }

    await GrupoClinica.update(
      {
        [`${type}_assignment_mode`]: mode,
        [`${type}_primary_asset_id`]: null,
        [`${type}_assignment_updated_at`]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );
  }
}

async function _updateGoogleAssignments({ key, mode, primaryAssetId, clinicAssignments = {}, groupId, clinicIds, transaction }) {
  const config = GOOGLE_MODE_CONFIG[key];
  if (!config) {
    return;
  }

  const { model, primaryField, modeField, updatedField, activeField, clinicField = 'clinicaId' } = config;
  const now = new Date();

  if (mode === 'group') {
    if (!primaryAssetId) {
      throw new Error(`Debes seleccionar un activo principal para ${key} en modo grupo`);
    }

    const primary = await model.findOne({
      where: {
        id: primaryAssetId,
        [clinicField]: { [Op.in]: clinicIds }
      },
      transaction
    });

    if (!primary) {
      throw new Error(`El activo seleccionado (${primaryAssetId}) no pertenece a este grupo`);
    }

    await GrupoClinica.update(
      {
        [modeField]: mode,
        [primaryField]: primaryAssetId,
        [updatedField]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );
  } else if (mode === 'clinic') {
    const clinicIdsToProcess = Object.keys(clinicAssignments)
      .map(id => parseInt(id, 10))
      .filter(id => clinicIds.includes(id));

    for (const clinicaId of clinicIdsToProcess) {
      const selectedId = clinicAssignments[clinicaId];
      if (!selectedId) {
        if (activeField) {
          await model.update(
            { [activeField]: false },
            {
              where: { [clinicField]: clinicaId },
              transaction
            }
          );
        }
        continue;
      }

      const selected = await model.findOne({
        where: { id: selectedId },
        transaction
      });

      if (!selected) {
        throw new Error(`Activo ${selectedId} no encontrado`);
      }

      const ownerClinicId = Number(selected[clinicField] ?? null);
      const belongsToGroup = ownerClinicId == null || clinicIds.includes(ownerClinicId);

      if (!belongsToGroup) {
        throw new Error(`El activo ${selectedId} no pertenece al grupo`);
      }

      if (ownerClinicId !== clinicaId) {
        const updatePayload = { [clinicField]: clinicaId };
        if (activeField) {
          updatePayload[activeField] = true;
        }
        await model.update(updatePayload, { where: { id: selectedId }, transaction });
      } else if (activeField) {
        await model.update(
          { [activeField]: true },
          { where: { id: selectedId }, transaction }
        );
      }

      if (activeField) {
        await model.update(
          { [activeField]: false },
          {
            where: {
              [clinicField]: clinicaId,
              id: { [Op.ne]: selectedId }
            },
            transaction
          }
        );
      }
    }

    await GrupoClinica.update(
      {
        [modeField]: mode,
        [primaryField]: null,
        [updatedField]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );
  }
}

async function updateGroupConfig(groupId, payload) {
  const ctx = await _loadGroupContext(groupId);
  if (!ctx) {
    throw new Error('Group not found');
  }

  let clinicIds = Array.isArray(ctx.clinicIds) ? [...ctx.clinicIds] : [];
  const groupSnapshot = ctx.group;
  const transaction = await sequelize.transaction();

  try {
    const now = new Date();

    if (payload.nombre_grupo) {
      await GrupoClinica.update(
        { nombre_grupo: payload.nombre_grupo.trim() },
        { where: { id_grupo: groupId }, transaction }
      );
    }

    if (payload.clinics && Array.isArray(payload.clinics.clinicIds)) {
      const targetIds = Array.from(
        new Set(
          payload.clinics.clinicIds
            .map(value => Number.parseInt(value, 10))
            .filter(Number.isInteger)
        )
      );

      const currentSet = new Set(clinicIds);
      const targetSet = new Set(targetIds);

      const toAssign = targetIds.filter(id => !currentSet.has(id));
      const toRemove = clinicIds.filter(id => !targetSet.has(id));

      if (toAssign.length) {
        await Clinica.update(
          { grupoClinicaId: groupId },
          { where: { id_clinica: toAssign }, transaction }
        );
      }

      if (toRemove.length) {
        await Clinica.update(
          { grupoClinicaId: null },
          { where: { id_clinica: toRemove, grupoClinicaId: groupId }, transaction }
        );
      }

      clinicIds = targetIds;
    }

    if (payload.ads) {
      const { mode, delimiter } = payload.ads;
      const updates = {};
      let modeChanged = false;

      if (mode && ['automatic', 'manual'].includes(mode)) {
        updates.ads_assignment_mode = mode;
        modeChanged = mode !== groupSnapshot.ads_assignment_mode;
      }
      if (typeof delimiter === 'string' && delimiter.trim().length) {
        updates.ads_assignment_delimiter = delimiter.trim();
      }
      if (Object.keys(updates).length) {
        await GrupoClinica.update(updates, { where: { id_grupo: groupId }, transaction });
      }

      if (modeChanged) {
        if (mode === 'automatic') {
          await ClinicMetaAsset.update(
            {
              assignmentScope: 'group',
              grupoClinicaId: groupId
            },
            {
              where: {
                clinicaId: { [Op.in]: clinicIds },
                assetType: 'ad_account'
              },
              transaction
            }
          );

          await ClinicGoogleAdsAccount.update(
            {
              assignmentScope: 'group',
              grupoClinicaId: groupId
            },
            {
              where: {
                clinicaId: { [Op.in]: clinicIds }
              },
              transaction
            }
          );
        } else {
          await ClinicMetaAsset.update(
            {
              assignmentScope: 'clinic',
              grupoClinicaId: null
            },
            {
              where: {
                clinicaId: { [Op.in]: clinicIds },
                assetType: 'ad_account'
              },
              transaction
            }
          );

          await ClinicGoogleAdsAccount.update(
            {
              assignmentScope: 'clinic',
              grupoClinicaId: null
            },
            {
              where: {
                clinicaId: { [Op.in]: clinicIds }
              },
              transaction
            }
          );
        }
      }
    }

    if (payload.web) {
      const { mode, primaryUrl, clinicUrls } = payload.web;
      const updates = {};
      if (mode && ['automatic', 'manual'].includes(mode)) {
        updates.web_assignment_mode = mode;
      }
      if (typeof primaryUrl === 'string' && mode === 'automatic') {
        updates.web_primary_url = primaryUrl.trim() || null;
      }
      if (Object.keys(updates).length) {
        updates.web_assignment_updated_at = now;
        await GrupoClinica.update(updates, { where: { id_grupo: groupId }, transaction });
      }

      if (mode === 'manual' && Array.isArray(clinicIds) && clinicIds.length && clinicUrls && typeof clinicUrls === 'object') {
        for (const clinicId of clinicIds) {
          const raw = clinicUrls[String(clinicId)];
          const url = typeof raw === 'string' ? raw.trim() : '';
          await Clinica.update(
            { url_web: url || null },
            { where: { id_clinica: clinicId }, transaction }
          );
        }
      }
    }

    if (payload.meta) {
      const { facebook, instagram, tiktok } = payload.meta;

      if (facebook) {
        const mode = _ensureValidMode(facebook.mode, 'facebook.mode');
        await _updateMetaAssignments({
          type: 'facebook',
          mode,
          primaryAssetId: facebook.primaryAssetId,
          clinicAssignments: facebook.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }

      if (instagram) {
        const mode = _ensureValidMode(instagram.mode, 'instagram.mode');
        await _updateMetaAssignments({
          type: 'instagram',
          mode,
          primaryAssetId: instagram.primaryAssetId,
          clinicAssignments: instagram.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }

      if (tiktok) {
        const mode = _ensureValidMode(tiktok.mode, 'tiktok.mode');
        await GrupoClinica.update(
          {
            tiktok_assignment_mode: mode || 'clinic',
            tiktok_primary_asset_id: mode === 'group' ? (tiktok.primaryAssetId || null) : null,
            tiktok_assignment_updated_at: now
          },
          { where: { id_grupo: groupId }, transaction }
        );
      }
    }

    if (payload.google) {
      const { searchConsole, analytics, businessProfile } = payload.google;

      if (searchConsole) {
        const mode = _ensureValidMode(searchConsole.mode, 'searchConsole.mode');
        await _updateGoogleAssignments({
          key: 'searchConsole',
          mode,
          primaryAssetId: searchConsole.primaryAssetId,
          clinicAssignments: searchConsole.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }

      if (analytics) {
        const mode = _ensureValidMode(analytics.mode, 'analytics.mode');
        await _updateGoogleAssignments({
          key: 'analytics',
          mode,
          primaryAssetId: analytics.primaryAssetId,
          clinicAssignments: analytics.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }

      if (businessProfile) {
        const mode = _ensureValidMode(businessProfile.mode, 'businessProfile.mode');
        await _updateGoogleAssignments({
          key: 'businessProfile',
          mode,
          primaryAssetId: businessProfile.primaryAssetId,
          clinicAssignments: businessProfile.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }
    }

    await transaction.commit();

    return getGroupConfig(groupId);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  getGroupConfig,
  updateGroupConfig
};
