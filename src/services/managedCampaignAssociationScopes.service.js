'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const SUPPORTED_PROVIDERS = new Set(['google_ads', 'meta_ads']);
const VISIBLE_AUTHORIZATION_STATUSES = new Set(['active', 'reauthorization_required']);

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value, max = 255) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function cleanAccountId(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 64);
}

function normalizeProvider(value) {
  const provider = cleanString(value, 32);
  return SUPPORTED_PROVIDERS.has(provider) ? provider : null;
}

function displayAccountId(provider, accountId) {
  if (provider === 'meta_ads') return `act_${accountId}`;
  if (provider === 'google_ads' && /^\d{10}$/.test(accountId)) {
    return `${accountId.slice(0, 3)}-${accountId.slice(3, 6)}-${accountId.slice(6)}`;
  }
  return accountId;
}

function isEligibleClinic(row) {
  return [true, 1, '1'].includes(row?.estado_clinica)
    && !/\btest\b/i.test(String(row?.nombre_clinica || ''));
}

function assignmentConnectionId(assignment, provider) {
  return positiveInt(provider === 'google_ads'
    ? assignment?.googleConnectionId ?? assignment?.google_connection_id
    : assignment?.metaConnectionId ?? assignment?.meta_connection_id);
}

function mappingConnectionId(mapping, provider) {
  return positiveInt(provider === 'google_ads'
    ? mapping?.googleConnectionId ?? mapping?.google_connection_id
    : mapping?.metaConnectionId ?? mapping?.meta_connection_id);
}

function authorizationForMapping({ mapping, provider, groupId, eligibleClinicIds, assignments }) {
  const connectionId = mappingConnectionId(mapping, provider);
  if (!connectionId) return null;

  const assignmentScope = String((mapping?.assignmentScope ?? mapping?.assignment_scope) || '').toLowerCase();
  if (assignmentScope !== 'clinic' && assignmentScope !== 'group') return null;
  const mappingClinicId = positiveInt(mapping?.clinicaId ?? mapping?.clinica_id);
  const mappingGroupId = positiveInt(mapping?.grupoClinicaId ?? mapping?.grupo_clinica_id);
  const origin = assignmentScope === 'group' && mappingGroupId === groupId ? 'group' : 'clinic';
  if (origin === 'clinic' && (!mappingClinicId || !eligibleClinicIds.has(mappingClinicId))) return null;

  const applicable = (Array.isArray(assignments) ? assignments : []).filter((assignment) => {
    if (assignmentConnectionId(assignment, provider) !== connectionId) return false;
    const status = String(assignment?.status || '').toLowerCase();
    if (!VISIBLE_AUTHORIZATION_STATUSES.has(status)) return false;
    const scope = String((assignment?.assignmentScope ?? assignment?.assignment_scope) || '').toLowerCase();
    if (scope !== 'clinic' && scope !== 'group') return false;
    const assignmentGroupId = positiveInt(assignment?.grupoClinicaId ?? assignment?.grupo_clinica_id);
    const assignmentClinicId = positiveInt(assignment?.clinicaId ?? assignment?.clinica_id);
    if (scope === 'group') return assignmentGroupId === groupId;
    return origin === 'clinic' && assignmentClinicId === mappingClinicId;
  });
  if (!applicable.length) return null;

  return {
    origin,
    status: applicable.some((assignment) => String(assignment.status).toLowerCase() === 'active')
      ? 'active'
      : 'reauthorization_required',
  };
}

function accountCandidate({ mapping, provider, groupId, eligibleClinicIds, assignments }) {
  if (mapping?.isActive === false || mapping?.is_active === false) return null;
  if (provider === 'meta_ads' && String((mapping?.assetType ?? mapping?.asset_type) || '') !== 'ad_account') return null;
  const rawAccountId = provider === 'google_ads'
    ? mapping?.customerId ?? mapping?.customer_id
    : mapping?.metaAssetId ?? mapping?.meta_asset_id;
  const accountId = cleanAccountId(rawAccountId);
  if (!accountId) return null;
  const authorization = authorizationForMapping({ mapping, provider, groupId, eligibleClinicIds, assignments });
  if (!authorization) return null;

  const accountName = cleanString(provider === 'google_ads'
    ? mapping?.descriptiveName ?? mapping?.descriptive_name
    : mapping?.metaAssetName ?? mapping?.meta_asset_name);
  return {
    provider,
    account_id: accountId,
    display_id: displayAccountId(provider, accountId),
    account_name: accountName,
    assignment_origin: authorization.origin,
    authorization_status: authorization.status,
    selectable: authorization.status === 'active',
  };
}

function candidatePriority(candidate) {
  return (candidate.selectable ? 0 : 10) + (candidate.assignment_origin === 'group' ? 0 : 1);
}

function dedupeAccountCandidates(candidates) {
  const byAccount = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const key = `${candidate.provider}:${candidate.account_id}`;
    const current = byAccount.get(key);
    if (!current || candidatePriority(candidate) < candidatePriority(current)) {
      byAccount.set(key, candidate);
    }
  }
  return Array.from(byAccount.values()).sort((left, right) => {
    if (left.provider !== right.provider) return left.provider === 'google_ads' ? -1 : 1;
    return String(left.account_name || left.account_id).localeCompare(
      String(right.account_name || right.account_id),
      'es',
      { sensitivity: 'base' }
    );
  });
}

function buildAssociationOptions({
  groups = [],
  clinics = [],
  googleAccounts = [],
  metaAssets = [],
  googleAssignments = [],
  metaAssignments = [],
} = {}) {
  const eligibleClinics = clinics.filter(isEligibleClinic);
  const clinicsByGroup = new Map();
  const clinicGroup = new Map();
  for (const clinic of eligibleClinics) {
    const clinicId = positiveInt(clinic?.id_clinica ?? clinic?.id);
    const groupId = positiveInt(clinic?.grupoClinicaId ?? clinic?.grupo_clinica_id);
    if (!clinicId || !groupId) continue;
    clinicGroup.set(clinicId, groupId);
    const rows = clinicsByGroup.get(groupId) || [];
    rows.push(clinic);
    clinicsByGroup.set(groupId, rows);
  }

  const groupRows = (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      id: positiveInt(group?.id_grupo ?? group?.id),
      name: cleanString(group?.nombre_grupo ?? group?.name) || 'Grupo sin nombre',
    }))
    .filter((group) => group.id && clinicsByGroup.has(group.id));

  return groupRows.map((group) => {
    const groupClinics = clinicsByGroup.get(group.id) || [];
    const eligibleClinicIds = new Set(groupClinics
      .map((clinic) => positiveInt(clinic?.id_clinica ?? clinic?.id))
      .filter(Boolean));
    const belongsToGroup = (mapping) => {
      const mappingGroupId = positiveInt(mapping?.grupoClinicaId ?? mapping?.grupo_clinica_id);
      const mappingClinicId = positiveInt(mapping?.clinicaId ?? mapping?.clinica_id);
      const scope = String((mapping?.assignmentScope ?? mapping?.assignment_scope) || '').toLowerCase();
      if (scope === 'group') return mappingGroupId === group.id;
      if (scope === 'clinic') {
        return eligibleClinicIds.has(mappingClinicId) && clinicGroup.get(mappingClinicId) === group.id;
      }
      return false;
    };
    const candidates = [
      ...googleAccounts.filter(belongsToGroup).map((mapping) => accountCandidate({
        mapping,
        provider: 'google_ads',
        groupId: group.id,
        eligibleClinicIds,
        assignments: googleAssignments,
      })),
      ...metaAssets.filter(belongsToGroup).map((mapping) => accountCandidate({
        mapping,
        provider: 'meta_ads',
        groupId: group.id,
        eligibleClinicIds,
        assignments: metaAssignments,
      })),
    ];

    return {
      group_id: group.id,
      group_name: group.name,
      eligible_clinic_count: eligibleClinicIds.size,
      accounts: dedupeAccountCandidates(candidates),
    };
  }).sort((left, right) => String(left.group_name).localeCompare(
    String(right.group_name),
    'es',
    { sensitivity: 'base' }
  ));
}

function findAssociationAccountInOptions(groups, { groupId, provider, accountId }) {
  const normalizedGroupId = positiveInt(groupId);
  const normalizedProvider = normalizeProvider(provider);
  const normalizedAccountId = cleanAccountId(accountId);
  if (!normalizedGroupId || !normalizedProvider || !normalizedAccountId) return null;
  const group = (Array.isArray(groups) ? groups : [])
    .find((item) => positiveInt(item?.group_id) === normalizedGroupId);
  if (!group) return null;
  const account = (Array.isArray(group.accounts) ? group.accounts : [])
    .find((item) => item.provider === normalizedProvider
      && item.account_id === normalizedAccountId
      && item.selectable === true);
  return account ? { group, account } : null;
}

function assignmentBelongsToGroup(assignment, groupId, groupClinicIds = new Set()) {
  const normalizedGroupId = positiveInt(groupId);
  if (!assignment || !normalizedGroupId) return false;
  const row = typeof assignment.get === 'function' ? assignment.get({ plain: true }) : assignment;
  const assignmentGroupId = positiveInt(row.grupo_clinica_id ?? row.grupoClinicaId);
  const clinicId = positiveInt(row.clinica_id ?? row.clinicaId);
  if (assignmentGroupId && assignmentGroupId !== normalizedGroupId) return false;
  if (clinicId && groupClinicIds.size > 0 && !groupClinicIds.has(clinicId)) return false;
  return assignmentGroupId === normalizedGroupId || (!!clinicId && groupClinicIds.has(clinicId));
}

function assignmentScopeConflict(message) {
  const error = new Error(message || 'La campaña ya tiene una decisión revisada en otro grupo.');
  error.httpStatus = 409;
  error.code = 'matching_assignment_scope_conflict';
  return error;
}

async function saveAssignmentWithinScope({
  assignmentModel,
  values,
  groupId,
  groupClinicIds,
  transaction,
  returnMetadata = false,
  prepareValues = null,
  isNoop = null,
} = {}) {
  if (!assignmentModel || !transaction || !values) {
    throw new TypeError('assignmentModel, values y transaction son obligatorios');
  }
  const key = {
    provider: values.provider,
    customer_id: values.customer_id,
    campaign_id: values.campaign_id,
  };
  const findLocked = () => assignmentModel.findOne({
    where: key,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const existing = await findLocked();
  if (existing) {
    if (!assignmentBelongsToGroup(existing, groupId, groupClinicIds)) {
      throw assignmentScopeConflict('La campaña ya tiene una decisión revisada en otro grupo y no puede moverse implícitamente.');
    }
    const previous = typeof existing.get === 'function'
      ? existing.get({ plain: true })
      : { ...existing };
    const nextValues = typeof prepareValues === 'function'
      ? prepareValues(existing, values)
      : values;
    if (typeof isNoop === 'function' && isNoop(previous, nextValues)) {
      return returnMetadata
        ? { row: existing, created: false, previous, changed: false }
        : existing;
    }
    const row = await existing.update(nextValues, { transaction });
    return returnMetadata ? { row, created: false, previous, changed: true } : row;
  }

  try {
    const createValues = typeof prepareValues === 'function'
      ? prepareValues(null, values)
      : values;
    const row = await assignmentModel.create(createValues, { transaction });
    return returnMetadata ? { row, created: true, previous: null, changed: true } : row;
  } catch (error) {
    if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
    const raced = await findLocked();
    if (!raced || !assignmentBelongsToGroup(raced, groupId, groupClinicIds)) {
      throw assignmentScopeConflict('La campaña recibió una decisión concurrente en otro grupo y no puede moverse implícitamente.');
    }
    const previous = typeof raced.get === 'function'
      ? raced.get({ plain: true })
      : { ...raced };
    const nextValues = typeof prepareValues === 'function'
      ? prepareValues(raced, values)
      : values;
    if (typeof isNoop === 'function' && isNoop(previous, nextValues)) {
      return returnMetadata
        ? { row: raced, created: false, previous, changed: false }
        : raced;
    }
    const row = await raced.update(nextValues, { transaction });
    return returnMetadata ? { row, created: false, previous, changed: true } : row;
  }
}

async function listAssociationOptions({
  groupIds = null,
  transaction = null,
  lock = false,
  models = db,
} = {}) {
  const requestedGroupIds = Array.isArray(groupIds)
    ? Array.from(new Set(groupIds.map(positiveInt).filter(Boolean)))
    : null;
  if (requestedGroupIds && !requestedGroupIds.length) return [];
  const queryLock = lock && transaction ? transaction.LOCK.UPDATE : null;

  const clinicWhere = {
    estado_clinica: true,
    grupoClinicaId: requestedGroupIds
      ? { [Op.in]: requestedGroupIds }
      : { [Op.ne]: null },
  };
  const clinics = await models.Clinica.findAll({
    where: clinicWhere,
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  const requestedGroupSet = requestedGroupIds ? new Set(requestedGroupIds) : null;
  const eligibleClinics = clinics.filter((clinic) => {
    if (!isEligibleClinic(clinic)) return false;
    const groupId = positiveInt(clinic.grupoClinicaId ?? clinic.grupo_clinica_id);
    return !requestedGroupSet || requestedGroupSet.has(groupId);
  });
  const resolvedGroupIds = Array.from(new Set(eligibleClinics
    .map((clinic) => positiveInt(clinic.grupoClinicaId ?? clinic.grupo_clinica_id))
    .filter(Boolean)));
  if (!resolvedGroupIds.length) return [];
  const eligibleClinicIds = eligibleClinics
    .map((clinic) => positiveInt(clinic.id_clinica ?? clinic.id))
    .filter(Boolean);
  const scopeWhere = {
    [Op.or]: [
      { grupoClinicaId: { [Op.in]: resolvedGroupIds } },
      { clinicaId: { [Op.in]: eligibleClinicIds } },
    ],
  };

  const loaders = [
    () => models.GrupoClinica.findAll({
      where: { id_grupo: { [Op.in]: resolvedGroupIds } },
      attributes: ['id_grupo', 'nombre_grupo'],
      raw: true,
      transaction,
      ...(queryLock ? { lock: queryLock } : {}),
    }),
    () => models.ClinicGoogleAdsAccount.findAll({
      where: { isActive: true, ...scopeWhere },
      attributes: [
        'clinicaId', 'grupoClinicaId', 'assignmentScope', 'googleConnectionId',
        'customerId', 'descriptiveName', 'isActive',
      ],
      raw: true,
      transaction,
      ...(queryLock ? { lock: queryLock } : {}),
    }),
    () => models.ClinicMetaAsset.findAll({
      where: { isActive: true, assetType: 'ad_account', ...scopeWhere },
      attributes: [
        'clinicaId', 'grupoClinicaId', 'assignmentScope', 'metaConnectionId',
        'assetType', 'metaAssetId', 'metaAssetName', 'isActive',
      ],
      raw: true,
      transaction,
      ...(queryLock ? { lock: queryLock } : {}),
    }),
    () => models.GoogleConnectionAssignment.findAll({
      where: {
        status: { [Op.in]: Array.from(VISIBLE_AUTHORIZATION_STATUSES) },
        ...scopeWhere,
      },
      attributes: [
        'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status',
      ],
      raw: true,
      transaction,
      ...(queryLock ? { lock: queryLock } : {}),
    }),
    () => models.MetaConnectionAssignment.findAll({
      where: {
        status: { [Op.in]: Array.from(VISIBLE_AUTHORIZATION_STATUSES) },
        ...scopeWhere,
      },
      attributes: [
        'assignmentScope', 'clinicaId', 'grupoClinicaId', 'metaConnectionId', 'status',
      ],
      raw: true,
      transaction,
      ...(queryLock ? { lock: queryLock } : {}),
    }),
  ];
  const loaded = [];
  if (queryLock) {
    for (const load of loaders) loaded.push(await load());
  } else {
    loaded.push(...await Promise.all(loaders.map((load) => load())));
  }
  const [groups, googleAccounts, metaAssets, googleAssignments, metaAssignments] = loaded;

  return buildAssociationOptions({
    groups,
    clinics: eligibleClinics,
    googleAccounts,
    metaAssets,
    googleAssignments,
    metaAssignments,
  });
}

async function findAssociationAccountScope({
  groupId,
  provider,
  accountId,
  transaction = null,
  lock = false,
  models = db,
} = {}) {
  const normalizedGroupId = positiveInt(groupId);
  if (!normalizedGroupId) return null;
  const groups = await listAssociationOptions({
    groupIds: [normalizedGroupId],
    transaction,
    lock,
    models,
  });
  return findAssociationAccountInOptions(groups, {
    groupId: normalizedGroupId,
    provider,
    accountId,
  });
}

async function findManagedCampaignAssociationAccountScope({
  groupId,
  clinicId,
  provider,
  accountId,
  transaction = null,
  lock = false,
  models = db,
} = {}) {
  const normalizedGroupId = positiveInt(groupId);
  const normalizedClinicId = positiveInt(clinicId);
  const normalizedProvider = normalizeProvider(provider);
  const normalizedAccountId = cleanAccountId(accountId);
  if ((!normalizedGroupId && !normalizedClinicId) || !normalizedProvider || !normalizedAccountId) {
    return null;
  }

  if (!normalizedClinicId) {
    const resolved = await findAssociationAccountScope({
      groupId: normalizedGroupId,
      provider: normalizedProvider,
      accountId: normalizedAccountId,
      transaction,
      lock,
      models,
    });
    return resolved
      ? {
          scope: { group_id: normalizedGroupId, clinic_id: null },
          account: resolved.account,
        }
      : null;
  }

  const queryLock = lock && transaction ? transaction.LOCK.UPDATE : null;
  const clinic = await models.Clinica.findOne({
    where: { id_clinica: normalizedClinicId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  if (!clinic || !isEligibleClinic(clinic)) return null;
  const resolvedGroupId = positiveInt(clinic.grupoClinicaId ?? clinic.grupo_clinica_id);
  if (normalizedGroupId && resolvedGroupId !== normalizedGroupId) return null;

  const scopeWhere = {
    [Op.or]: [
      ...(resolvedGroupId ? [{ assignmentScope: 'group', grupoClinicaId: resolvedGroupId }] : []),
      { assignmentScope: 'clinic', clinicaId: normalizedClinicId },
    ],
  };
  const mappingModel = normalizedProvider === 'google_ads'
    ? models.ClinicGoogleAdsAccount
    : models.ClinicMetaAsset;
  const assignmentModel = normalizedProvider === 'google_ads'
    ? models.GoogleConnectionAssignment
    : models.MetaConnectionAssignment;
  const mappingAttributes = normalizedProvider === 'google_ads'
    ? [
        'clinicaId', 'grupoClinicaId', 'assignmentScope', 'googleConnectionId',
        'customerId', 'descriptiveName', 'isActive',
      ]
    : [
        'clinicaId', 'grupoClinicaId', 'assignmentScope', 'metaConnectionId',
        'assetType', 'metaAssetId', 'metaAssetName', 'isActive',
      ];
  const assignmentAttributes = normalizedProvider === 'google_ads'
    ? ['assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status']
    : ['assignmentScope', 'clinicaId', 'grupoClinicaId', 'metaConnectionId', 'status'];
  const mappingWhere = {
    isActive: true,
    ...scopeWhere,
    ...(normalizedProvider === 'meta_ads' ? { assetType: 'ad_account' } : {}),
  };
  const authorizationWhere = {
    status: { [Op.in]: Array.from(VISIBLE_AUTHORIZATION_STATUSES) },
    ...scopeWhere,
  };
  const loadMappings = () => mappingModel.findAll({
    where: mappingWhere,
    attributes: mappingAttributes,
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  const loadAssignments = () => assignmentModel.findAll({
    where: authorizationWhere,
    attributes: assignmentAttributes,
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  let mappings;
  let assignments;
  if (queryLock) {
    mappings = await loadMappings();
    assignments = await loadAssignments();
  } else {
    [mappings, assignments] = await Promise.all([loadMappings(), loadAssignments()]);
  }
  const eligibleClinicIds = new Set([normalizedClinicId]);
  const account = dedupeAccountCandidates(mappings.map((mapping) => accountCandidate({
    mapping,
    provider: normalizedProvider,
    groupId: resolvedGroupId,
    eligibleClinicIds,
    assignments,
  }))).find((candidate) => (
    candidate.account_id === normalizedAccountId && candidate.selectable === true
  ));
  return account
    ? {
        scope: { group_id: resolvedGroupId, clinic_id: normalizedClinicId },
        account,
      }
    : null;
}

async function upsertInventoryWithinScope({
  groupId,
  provider,
  accountId,
  rows = [],
  sequelize = db.sequelize,
  inventoryModel = db.ExternalCampaignInventory,
  accountScopeResolver = findAssociationAccountScope,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    const accountScope = await accountScopeResolver({
      groupId,
      provider,
      accountId,
      transaction,
      lock: true,
    });
    if (!accountScope) {
      const error = new Error('La autorización de la cuenta cambió antes de guardar el inventario.');
      error.httpStatus = 403;
      error.code = 'matching_account_scope_forbidden';
      throw error;
    }
    let saved = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      await inventoryModel.upsert(row, { transaction });
      saved += 1;
    }
    return saved;
  });
}

module.exports = {
  buildAssociationOptions,
  findAssociationAccountInOptions,
  findAssociationAccountScope,
  findManagedCampaignAssociationAccountScope,
  assignmentBelongsToGroup,
  cleanAccountId,
  listAssociationOptions,
  normalizeProvider,
  saveAssignmentWithinScope,
  upsertInventoryWithinScope,
};
