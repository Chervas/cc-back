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
  ClinicGoogleAdsAccount,
  GroupAssetClinicAssignment
} = require('../../models');

const MODE_VALUES = ['group', 'clinic'];

const META_TYPES = {
  facebook: 'facebook_page',
  instagram: 'instagram_business'
};

const GROUP_ASSET_TYPES = {
  META_FACEBOOK: 'meta.facebook_page',
  META_INSTAGRAM: 'meta.instagram_business',
  META_AD_ACCOUNT: 'meta.ad_account',
  GOOGLE_ADS_ACCOUNT: 'google.ads_account',
  GOOGLE_SEARCH_CONSOLE: 'google.search_console',
  GOOGLE_ANALYTICS: 'google.analytics',
  GOOGLE_BUSINESS_PROFILE: 'google.business_profile'
};

const META_GROUP_ASSET_TYPE_BY_SECTION = {
  facebook: GROUP_ASSET_TYPES.META_FACEBOOK,
  instagram: GROUP_ASSET_TYPES.META_INSTAGRAM
};

const META_SECTION_BY_ASSET_TYPE = {
  [META_TYPES.facebook]: 'facebook',
  [META_TYPES.instagram]: 'instagram'
};

const GOOGLE_GROUP_ASSET_TYPE_BY_SECTION = {
  searchConsole: GROUP_ASSET_TYPES.GOOGLE_SEARCH_CONSOLE,
  analytics: GROUP_ASSET_TYPES.GOOGLE_ANALYTICS,
  businessProfile: GROUP_ASSET_TYPES.GOOGLE_BUSINESS_PROFILE
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

function _indexAssignments(rows = []) {
  const byType = new Map();
  rows.forEach(row => {
    const type = row.assetType;
    if (!byType.has(type)) {
      byType.set(type, new Map());
    }
    const typeMap = byType.get(type);
    const assetId = Number(row.assetId);
    if (!typeMap.has(assetId)) {
      typeMap.set(assetId, new Set());
    }
    typeMap.get(assetId).add(Number(row.clinicaId));
  });
  return byType;
}

function _getAssignedClinics(index, assetType, assetId) {
  const typeMap = index.get(assetType);
  if (!typeMap) {
    return [];
  }
  const clinicSet = typeMap.get(Number(assetId));
  return clinicSet ? Array.from(clinicSet) : [];
}

function _buildClinicAssignmentMap(clinicIds, index, assetType) {
  const assignments = {};
  clinicIds.forEach(id => {
    assignments[String(id)] = null;
  });
  const typeMap = index.get(assetType);
  if (!typeMap) {
    return assignments;
  }
  typeMap.forEach((clinicSet, assetId) => {
    clinicSet.forEach(clinicId => {
      if (clinicIds.includes(clinicId)) {
        assignments[String(clinicId)] = assetId;
      }
    });
  });
  return assignments;
}

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

  const assignmentRows = await GroupAssetClinicAssignment.findAll({
    where: { grupoClinicaId: group.id_grupo }
  });
  const assignmentIndex = _indexAssignments(
    assignmentRows.map(row => (row.get ? row.get({ plain: true }) : row))
  );

  // Ads existentes (Meta/Google Ads) se mantienen igual
  const rawMetaAdsAccounts = await ClinicMetaAsset.findAll({
    where: {
      assetType: 'ad_account',
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: group.id_grupo }
      ]
    },
    attributes: ['id', 'metaAssetId', 'metaAssetName', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive']
  });

  const metaAdsAccounts = rawMetaAdsAccounts.map(acc => {
    const plain = acc.get ? acc.get({ plain: true }) : acc;
    const assigned = _getAssignedClinics(assignmentIndex, GROUP_ASSET_TYPES.META_AD_ACCOUNT, plain.id);
    plain.assignedClinicIds = assigned;
    if (!plain.clinicaId && assigned.length) {
      plain.clinicaId = assigned[0];
    }
    return plain;
  });

  const rawGoogleAdsAccounts = await ClinicGoogleAdsAccount.findAll({
    where: {
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: group.id_grupo }
      ]
    },
    attributes: ['id', 'customerId', 'descriptiveName', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive']
  });

  const googleAdsAccounts = rawGoogleAdsAccounts.map(acc => {
    const plain = acc.get ? acc.get({ plain: true }) : acc;
    const assigned = _getAssignedClinics(assignmentIndex, GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT, plain.id);
    plain.assignedClinicIds = assigned;
    if (!plain.clinicaId && assigned.length) {
      plain.clinicaId = assigned[0];
    }
    return plain;
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

  const metaClinicAssignments = {
    facebook: _buildClinicAssignmentMap(clinicIds, assignmentIndex, GROUP_ASSET_TYPES.META_FACEBOOK),
    instagram: _buildClinicAssignmentMap(clinicIds, assignmentIndex, GROUP_ASSET_TYPES.META_INSTAGRAM)
  };

  const tiktokAssignments = {};
  clinicIds.forEach(id => {
    const key = String(id);
    if (!(key in metaClinicAssignments.facebook)) {
      metaClinicAssignments.facebook[key] = null;
    }
    if (!(key in metaClinicAssignments.instagram)) {
      metaClinicAssignments.instagram[key] = null;
    }
    tiktokAssignments[key] = null;
  });

  metaAssets.forEach(asset => {
    const plain = _serializeMetaAsset(asset);
    const section = META_SECTION_BY_ASSET_TYPE[plain.type];
    if (!section) {
      return;
    }
    const assignedFromJoin = new Set(
      _getAssignedClinics(assignmentIndex, META_GROUP_ASSET_TYPE_BY_SECTION[section], plain.id)
    );
    if (!assignedFromJoin.size && plain.clinicaId) {
      assignedFromJoin.add(Number(plain.clinicaId));
    }
    plain.assignedClinicIds = Array.from(assignedFromJoin);
    if (!plain.clinicaId && plain.assignedClinicIds.length) {
      plain.clinicaId = plain.assignedClinicIds[0];
    }
    plain.assignedClinicIds.forEach(clinicId => {
      if (clinicIds.includes(clinicId)) {
        metaClinicAssignments[section][String(clinicId)] = plain.id;
      }
    });
    if (section === 'facebook') {
      metaByType.facebook.push(plain);
    } else if (section === 'instagram') {
      metaByType.instagram.push(plain);
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
    const groupAssetType = GOOGLE_GROUP_ASSET_TYPE_BY_SECTION[key];
    const assignments = _buildClinicAssignmentMap(clinicIds, assignmentIndex, groupAssetType);

    rows.forEach(row => {
      const plain = _serializeGoogleAsset(row, config.activeField, clinicField);
      const assignedFromJoin = new Set(_getAssignedClinics(assignmentIndex, groupAssetType, plain.id));
      if (!assignedFromJoin.size && plain.clinicaId && plain.isActive) {
        assignedFromJoin.add(Number(plain.clinicaId));
      }
      plain.assignedClinicIds = Array.from(assignedFromJoin);
      if (!plain.clinicaId && plain.assignedClinicIds.length) {
        plain.clinicaId = plain.assignedClinicIds[0];
      }
      plain.assignedClinicIds.forEach(clinicId => {
        if (clinicIds.includes(clinicId)) {
          assignments[String(clinicId)] = plain.id;
        }
      });
      items.push(plain);

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
  const assetTypeKey = META_GROUP_ASSET_TYPE_BY_SECTION[type];
  if (!assetType || !assetTypeKey) {
    return;
  }

  const now = new Date();

  const accessibleAssets = await ClinicMetaAsset.findAll({
    where: {
      assetType,
      [Op.or]: [
        { clinicaId: { [Op.in]: clinicIds } },
        { grupoClinicaId: groupId }
      ]
    },
    transaction
  });
  const accessibleAssetIds = accessibleAssets.map(asset => asset.id);

  if (mode === 'group') {
    if (!primaryAssetId || !accessibleAssetIds.includes(Number(primaryAssetId))) {
      throw new Error(`Debes seleccionar un activo principal válido para ${type} en modo grupo`);
    }

    await GroupAssetClinicAssignment.destroy({
      where: { grupoClinicaId: groupId, assetType: assetTypeKey },
      transaction
    });

    const otherAssetIds = accessibleAssetIds.filter(id => id !== Number(primaryAssetId));

    if (otherAssetIds.length) {
      await ClinicMetaAsset.update(
        { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
        { where: { id: { [Op.in]: otherAssetIds } }, transaction }
      );
    }

    await ClinicMetaAsset.update(
      { assignmentScope: 'group', grupoClinicaId: groupId, isActive: true },
      { where: { id: primaryAssetId }, transaction }
    );

    await GrupoClinica.update(
      {
        [`${type}_assignment_mode`]: mode,
        [`${type}_primary_asset_id`]: primaryAssetId,
        [`${type}_assignment_updated_at`]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );

    return;
  }

  // Clinic mode
  await GroupAssetClinicAssignment.destroy({
    where: { grupoClinicaId: groupId, assetType: assetTypeKey },
    transaction
  });

  const assignmentsPerAsset = new Map();
  Object.entries(clinicAssignments || {}).forEach(([clinicKey, rawValue]) => {
    const clinicId = Number.parseInt(clinicKey, 10);
    if (!Number.isInteger(clinicId) || !clinicIds.includes(clinicId)) {
      return;
    }
    if (rawValue == null || rawValue === '') {
      return;
    }
    const assetId = Number(rawValue);
    if (!Number.isFinite(assetId) || !accessibleAssetIds.includes(assetId)) {
      throw new Error(`El activo ${rawValue} no pertenece a este grupo de clínicas`);
    }
    if (!assignmentsPerAsset.has(assetId)) {
      assignmentsPerAsset.set(assetId, new Set());
    }
    assignmentsPerAsset.get(assetId).add(clinicId);
  });

  const bulkRows = [];
  for (const [assetId, clinicSet] of assignmentsPerAsset.entries()) {
    const clinicList = Array.from(clinicSet);
    const primaryClinicId = clinicList[0] ?? null;
    bulkRows.push(
      ...clinicList.map(clinicId => ({
        grupoClinicaId: groupId,
        assetType: assetTypeKey,
        assetId,
        clinicaId
      }))
    );

    const updatePayload = {
      assignmentScope: 'clinic',
      grupoClinicaId: null,
      isActive: clinicList.length > 0
    };
    if (primaryClinicId != null) {
      updatePayload.clinicaId = primaryClinicId;
    }
    await ClinicMetaAsset.update(updatePayload, { where: { id: assetId }, transaction });
  }

  const assignedAssetIds = new Set(assignmentsPerAsset.keys());
  const unassignedAssetIds = accessibleAssetIds.filter(id => !assignedAssetIds.has(id));
  if (unassignedAssetIds.length) {
      await ClinicMetaAsset.update(
        { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
        { where: { id: { [Op.in]: unassignedAssetIds } }, transaction }
      );
  }

  if (bulkRows.length) {
    await GroupAssetClinicAssignment.bulkCreate(bulkRows, { transaction });
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

async function _updateGoogleAssignments({ key, mode, primaryAssetId, clinicAssignments = {}, groupId, clinicIds, transaction }) {
  const config = GOOGLE_MODE_CONFIG[key];
  const assetTypeKey = GOOGLE_GROUP_ASSET_TYPE_BY_SECTION[key];
  if (!config || !assetTypeKey) {
    return;
  }

  const { model, primaryField, modeField, updatedField, activeField, clinicField = 'clinicaId' } = config;
  const now = new Date();

  const accessibleAssets = await model.findAll({
    where: { [clinicField]: { [Op.in]: clinicIds } },
    transaction
  });
  const accessibleAssetIds = accessibleAssets.map(asset => asset.id);

  if (mode === 'group') {
    if (!primaryAssetId || !accessibleAssetIds.includes(Number(primaryAssetId))) {
      throw new Error(`Debes seleccionar un activo principal válido para ${key}`);
    }

    await GroupAssetClinicAssignment.destroy({
      where: { grupoClinicaId: groupId, assetType: assetTypeKey },
      transaction
    });

    if (activeField) {
      await model.update(
        { [activeField]: true },
        { where: { id: primaryAssetId }, transaction }
      );
      const otherIds = accessibleAssetIds.filter(id => id !== Number(primaryAssetId));
      if (otherIds.length) {
        await model.update(
          { [activeField]: false },
          { where: { id: { [Op.in]: otherIds } }, transaction }
        );
      }
    }

    await GrupoClinica.update(
      {
        [modeField]: mode,
        [primaryField]: primaryAssetId,
        [updatedField]: now
      },
      { where: { id_grupo: groupId }, transaction }
    );
    return;
  }

  await GroupAssetClinicAssignment.destroy({
    where: { grupoClinicaId: groupId, assetType: assetTypeKey },
    transaction
  });

  const assignmentsPerAsset = new Map();
  Object.entries(clinicAssignments || {}).forEach(([clinicKey, rawValue]) => {
    const clinicId = Number.parseInt(clinicKey, 10);
    if (!Number.isInteger(clinicId) || !clinicIds.includes(clinicId)) {
      return;
    }
    if (rawValue == null || rawValue === '') {
      return;
    }
    const assetId = Number(rawValue);
    if (!Number.isFinite(assetId) || !accessibleAssetIds.includes(assetId)) {
      throw new Error(`El activo ${rawValue} no pertenece a este grupo de clínicas`);
    }
    if (!assignmentsPerAsset.has(assetId)) {
      assignmentsPerAsset.set(assetId, new Set());
    }
    assignmentsPerAsset.get(assetId).add(clinicId);
  });

  const bulkRows = [];
  for (const [assetId, clinicSet] of assignmentsPerAsset.entries()) {
    bulkRows.push(
      ...Array.from(clinicSet).map(clinicId => ({
        grupoClinicaId: groupId,
        assetType: assetTypeKey,
        assetId,
        clinicaId: clinicId
      }))
    );
  }

  if (bulkRows.length) {
    await GroupAssetClinicAssignment.bulkCreate(bulkRows, { transaction });
  }

  if (activeField) {
    const assignedIds = Array.from(assignmentsPerAsset.keys());
    if (assignedIds.length) {
      await model.update(
        { [activeField]: true },
        { where: { id: { [Op.in]: assignedIds } }, transaction }
      );
    }
    const unassignedIds = accessibleAssetIds.filter(id => !assignmentsPerAsset.has(id));
    if (unassignedIds.length) {
      await model.update(
        { [activeField]: false },
        { where: { id: { [Op.in]: unassignedIds } }, transaction }
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

async function _updateMetaAdAccounts({ mode, primaryAccountId, clinicAssignments = {}, groupId, clinicIds, transaction }) {
  if (!mode) {
    return;
  }

  const where = {
    assetType: 'ad_account',
    [Op.or]: [
      { clinicaId: { [Op.in]: clinicIds } },
      { grupoClinicaId: groupId }
    ]
  };

  const accounts = await ClinicMetaAsset.findAll({ where, transaction });
  if (!accounts.length) {
    return;
  }

  const accountIds = accounts.map(acc => acc.id);

  if (mode === 'group') {
    const parsedPrimary = primaryAccountId != null ? Number(primaryAccountId) : null;
    if (!parsedPrimary || !accountIds.includes(parsedPrimary)) {
      throw new Error('Selecciona una cuenta válida de Meta Ads para el grupo');
    }

    await GroupAssetClinicAssignment.destroy({
      where: { grupoClinicaId: groupId, assetType: GROUP_ASSET_TYPES.META_AD_ACCOUNT },
      transaction
    });

    const remaining = accountIds.filter(id => id !== parsedPrimary);

    if (remaining.length) {
      await ClinicMetaAsset.update(
        { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
        { where: { id: { [Op.in]: remaining } }, transaction }
      );
    }

    await ClinicMetaAsset.update(
      { assignmentScope: 'group', grupoClinicaId: groupId, isActive: true },
      { where: { id: parsedPrimary }, transaction }
    );

    return;
  }

  await GroupAssetClinicAssignment.destroy({
    where: { grupoClinicaId: groupId, assetType: GROUP_ASSET_TYPES.META_AD_ACCOUNT },
    transaction
  });

  const assignmentsPerAccount = new Map();
  Object.entries(clinicAssignments || {}).forEach(([clinicKey, rawValue]) => {
    const clinicId = Number.parseInt(clinicKey, 10);
    if (!Number.isInteger(clinicId) || !clinicIds.includes(clinicId)) {
      return;
    }
    if (rawValue == null || rawValue === '') {
      return;
    }
    const accountId = Number(rawValue);
    if (!Number.isFinite(accountId) || !accountIds.includes(accountId)) {
      throw new Error(`La cuenta de Meta Ads ${rawValue} no pertenece a este grupo de clínicas`);
    }
    if (!assignmentsPerAccount.has(accountId)) {
      assignmentsPerAccount.set(accountId, new Set());
    }
    assignmentsPerAccount.get(accountId).add(clinicId);
  });

  const bulkRows = [];
  for (const [accountId, clinicSet] of assignmentsPerAccount.entries()) {
    const clinicsList = Array.from(clinicSet);
    const primaryClinic = clinicsList[0] ?? null;
    bulkRows.push(
      ...clinicsList.map(clinicId => ({
        grupoClinicaId: groupId,
        assetType: GROUP_ASSET_TYPES.META_AD_ACCOUNT,
        assetId: accountId,
        clinicaId
      }))
    );

    const updatePayload = {
      assignmentScope: 'clinic',
      grupoClinicaId: null,
      isActive: clinicsList.length > 0
    };
    if (primaryClinic != null) {
      updatePayload.clinicaId = primaryClinic;
    }
    await ClinicMetaAsset.update(updatePayload, { where: { id: accountId }, transaction });
  }

  const assignedAccountIds = new Set(assignmentsPerAccount.keys());
  const unassignedIds = accountIds.filter(id => !assignedAccountIds.has(id));
  if (unassignedIds.length) {
    await ClinicMetaAsset.update(
      { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
      { where: { id: { [Op.in]: unassignedIds } }, transaction }
    );
  }

  if (bulkRows.length) {
    await GroupAssetClinicAssignment.bulkCreate(bulkRows, { transaction });
  }
}

async function _updateGoogleAdAccounts({ mode, primaryAccountId, clinicAssignments = {}, groupId, clinicIds, transaction }) {
  if (!mode) {
    return;
  }

  const where = {
    [Op.or]: [
      { clinicaId: { [Op.in]: clinicIds } },
      { grupoClinicaId: groupId }
    ]
  };

  const accounts = await ClinicGoogleAdsAccount.findAll({ where, transaction });
  if (!accounts.length) {
    return;
  }

  const accountIds = accounts.map(acc => acc.id);

  if (mode === 'group') {
    const parsedPrimary = primaryAccountId != null ? Number(primaryAccountId) : null;
    if (!parsedPrimary || !accountIds.includes(parsedPrimary)) {
      throw new Error('Selecciona una cuenta válida de Google Ads para el grupo');
    }

    await GroupAssetClinicAssignment.destroy({
      where: { grupoClinicaId: groupId, assetType: GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT },
      transaction
    });

    const remaining = accountIds.filter(id => id !== parsedPrimary);
    if (remaining.length) {
      await ClinicGoogleAdsAccount.update(
        { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
        { where: { id: { [Op.in]: remaining } }, transaction }
      );
    }

    await ClinicGoogleAdsAccount.update(
      { assignmentScope: 'group', grupoClinicaId: groupId, isActive: true },
      { where: { id: parsedPrimary }, transaction }
    );
    return;
  }

  await GroupAssetClinicAssignment.destroy({
    where: { grupoClinicaId: groupId, assetType: GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT },
    transaction
  });

  const assignmentsPerAccount = new Map();
  Object.entries(clinicAssignments || {}).forEach(([clinicKey, rawValue]) => {
    const clinicId = Number.parseInt(clinicKey, 10);
    if (!Number.isInteger(clinicId) || !clinicIds.includes(clinicId)) {
      return;
    }
    if (rawValue == null || rawValue === '') {
      return;
    }
    const accountId = Number(rawValue);
    if (!Number.isFinite(accountId) || !accountIds.includes(accountId)) {
      throw new Error(`La cuenta de Google Ads ${rawValue} no pertenece a este grupo de clínicas`);
    }
    if (!assignmentsPerAccount.has(accountId)) {
      assignmentsPerAccount.set(accountId, new Set());
    }
    assignmentsPerAccount.get(accountId).add(clinicId);
  });

  const bulkRows = [];
  for (const [accountId, clinicSet] of assignmentsPerAccount.entries()) {
    const clinicsList = Array.from(clinicSet);
    const primaryClinic = clinicsList[0] ?? null;
    bulkRows.push(
      ...clinicsList.map(clinicId => ({
        grupoClinicaId: groupId,
        assetType: GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT,
        assetId: accountId,
        clinicaId: clinicId
      }))
    );

    const updatePayload = {
      assignmentScope: 'clinic',
      grupoClinicaId: null,
      isActive: clinicsList.length > 0
    };
    if (primaryClinic != null) {
      updatePayload.clinicaId = primaryClinic;
    }
    await ClinicGoogleAdsAccount.update(updatePayload, { where: { id: accountId }, transaction });
  }

  const assignedIds = new Set(assignmentsPerAccount.keys());
  const unassigned = accountIds.filter(id => !assignedIds.has(id));
  if (unassigned.length) {
    await ClinicGoogleAdsAccount.update(
      { assignmentScope: 'clinic', grupoClinicaId: null, isActive: false },
      { where: { id: { [Op.in]: unassigned } }, transaction }
    );
  }

  if (bulkRows.length) {
    await GroupAssetClinicAssignment.bulkCreate(bulkRows, { transaction });
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

          await GroupAssetClinicAssignment.destroy({
            where: {
              grupoClinicaId: groupId,
              assetType: GROUP_ASSET_TYPES.META_AD_ACCOUNT
            },
            transaction
          });
          await GroupAssetClinicAssignment.destroy({
            where: {
              grupoClinicaId: groupId,
              assetType: GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT
            },
            transaction
          });
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

    if (payload.adsAccounts) {
      const { meta, google } = payload.adsAccounts;

      if (meta) {
        const mode = _ensureValidMode(meta.mode, 'adsAccounts.meta.mode');
        await _updateMetaAdAccounts({
          mode,
          primaryAccountId: meta.primaryAccountId ?? null,
          clinicAssignments: meta.clinicAssignments || {},
          groupId,
          clinicIds,
          transaction
        });
      }

      if (google) {
        const mode = _ensureValidMode(google.mode, 'adsAccounts.google.mode');
        await _updateGoogleAdAccounts({
          mode,
          primaryAccountId: google.primaryAccountId ?? null,
          clinicAssignments: google.clinicAssignments || {},
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
