'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  affectedClinicIdsForAsset,
} = require('../lib/sharedMarketingAssetMutationAccess');

function sharedConflict(assetType, assetId, outsideClinicIds) {
  const error = new Error(
    'No se puede desconectar este scope porque uno de sus activos también se usa fuera de él.'
  );
  error.code = 'scope_disconnect_shared_asset_conflict';
  error.httpStatus = 409;
  error.details = { assetType, assetId, outsideClinicIds };
  return error;
}

async function groupClinicIds(groupId, models, transaction) {
  const rows = await models.Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true,
    transaction,
  });
  return rows.map((row) => Number(row.id_clinica)).filter(Number.isInteger);
}

async function inheritedClinicIds({
  provider,
  groupId,
  clinicIds,
  models,
  transaction,
}) {
  const Assignment = provider === 'google'
    ? models.GoogleConnectionAssignment
    : models.MetaConnectionAssignment;
  if (!clinicIds.length) return [];
  const overrides = await Assignment.findAll({
    where: {
      assignmentScope: 'clinic',
      clinicaId: { [Op.in]: clinicIds },
      status: { [Op.in]: ['active', 'reauthorization_required'] },
    },
    attributes: ['clinicaId'],
    raw: true,
    transaction,
  });
  const overridden = new Set(overrides.map((row) => Number(row.clinicaId)));
  return clinicIds.filter((clinicId) => !overridden.has(clinicId));
}

function metaSharedAssetType(assetType) {
  if (assetType === 'ad_account') return 'meta.ad_account';
  if (assetType === 'instagram_business') return 'meta.instagram_business';
  if (assetType === 'whatsapp_business_account') return 'meta.whatsapp_business_account';
  if (assetType === 'whatsapp_phone_number') return 'meta.whatsapp_phone_number';
  return 'meta.facebook_page';
}

async function assertRowsContainedInScope({
  rows,
  assetType,
  assetTypeOf = null,
  ownerClinicIdOf,
  allowedClinicIds,
  transaction,
  assignmentModel,
  models,
}) {
  const allowed = new Set(allowedClinicIds.map(Number));
  for (const row of rows) {
    const resolvedAssetType = assetTypeOf ? assetTypeOf(row) : assetType;
    const affected = await affectedClinicIdsForAsset({
      assetType: resolvedAssetType,
      assetId: row.id,
      ownerClinicId: ownerClinicIdOf(row),
      transaction,
      assignmentModel,
      findImplicitGroupId: async () => (
        (resolvedAssetType === 'google.ads_account' || resolvedAssetType.startsWith('meta.'))
        && row.assignmentScope === 'group'
          ? row.grupoClinicaId
          : null
      ),
      findGroupClinicIds: async (groupId) => groupClinicIds(groupId, models, transaction),
    });
    const outside = affected.filter((clinicId) => !allowed.has(Number(clinicId)));
    if (outside.length) {
      throw sharedConflict(resolvedAssetType, row.id, outside);
    }
  }
}

async function lockRows(Model, where, transaction) {
  return Model.findAll({
    where,
    transaction,
    lock: transaction.LOCK.UPDATE,
    order: [['id', 'ASC']],
  });
}

async function deactivateRows(rows, field, transaction) {
  for (const row of rows) {
    await row.update({ [field]: false }, { transaction });
  }
  return rows.length;
}

async function deactivateGoogleMappingsForScope({
  scope,
  connectionId,
  transaction,
  models = db,
}) {
  const isClinic = scope.assignmentScope === 'clinic';
  const allGroupClinicIds = isClinic
    ? [Number(scope.clinicId)]
    : await groupClinicIds(scope.groupId, models, transaction);
  const inheritedIds = isClinic
    ? allGroupClinicIds
    : await inheritedClinicIds({
      provider: 'google',
      groupId: scope.groupId,
      clinicIds: allGroupClinicIds,
      models,
      transaction,
    });
  const ordinaryClinicIds = inheritedIds.filter(Number.isInteger);
  const emptyId = -1;

  // Bloqueo determinista por tabla: una transacción Sequelize usa una única
  // conexión y no debe lanzar cuatro SELECT ... FOR UPDATE concurrentes.
  const web = await lockRows(models.ClinicWebAsset, {
      googleConnectionId: connectionId,
      clinicaId: { [Op.in]: ordinaryClinicIds.length ? ordinaryClinicIds : [emptyId] },
      isActive: true,
    }, transaction);
  const analytics = await lockRows(models.ClinicAnalyticsProperty, {
      googleConnectionId: connectionId,
      clinicaId: { [Op.in]: ordinaryClinicIds.length ? ordinaryClinicIds : [emptyId] },
      isActive: true,
    }, transaction);
  const local = await lockRows(models.ClinicBusinessLocation, {
      google_connection_id: connectionId,
      clinica_id: { [Op.in]: ordinaryClinicIds.length ? ordinaryClinicIds : [emptyId] },
      is_active: true,
    }, transaction);
  const ads = await lockRows(models.ClinicGoogleAdsAccount, {
      googleConnectionId: connectionId,
      isActive: true,
      [Op.or]: isClinic
        ? [{ clinicaId: scope.clinicId, assignmentScope: 'clinic' }]
        : [
          { assignmentScope: 'group', grupoClinicaId: scope.groupId },
          {
            assignmentScope: 'clinic',
            clinicaId: { [Op.in]: ordinaryClinicIds.length ? ordinaryClinicIds : [emptyId] },
          },
        ],
    }, transaction);

  const sharedArgs = {
    allowedClinicIds: allGroupClinicIds,
    transaction,
    assignmentModel: models.GroupAssetClinicAssignment,
    models,
  };
  await assertRowsContainedInScope({
    ...sharedArgs,
    rows: web,
    assetType: 'google.search_console',
    ownerClinicIdOf: (row) => row.clinicaId,
  });
  await assertRowsContainedInScope({
    ...sharedArgs,
    rows: analytics,
    assetType: 'google.analytics',
    ownerClinicIdOf: (row) => row.clinicaId,
  });
  await assertRowsContainedInScope({
    ...sharedArgs,
    rows: local,
    assetType: 'google.business_profile',
    ownerClinicIdOf: (row) => row.clinica_id,
  });
  await assertRowsContainedInScope({
    ...sharedArgs,
    rows: ads,
    assetType: 'google.ads_account',
    ownerClinicIdOf: (row) => row.clinicaId,
  });

  return {
    web: await deactivateRows(web, 'isActive', transaction),
    analytics: await deactivateRows(analytics, 'isActive', transaction),
    local: await deactivateRows(local, 'is_active', transaction),
    ads: await deactivateRows(ads, 'isActive', transaction),
  };
}

async function deactivateMetaMappingsForScope({
  scope,
  connectionId,
  transaction,
  models = db,
}) {
  const isClinic = scope.assignmentScope === 'clinic';
  const allGroupClinicIds = isClinic
    ? [Number(scope.clinicId)]
    : await groupClinicIds(scope.groupId, models, transaction);
  const inheritedIds = isClinic
    ? allGroupClinicIds
    : await inheritedClinicIds({
      provider: 'meta',
      groupId: scope.groupId,
      clinicIds: allGroupClinicIds,
      models,
      transaction,
    });
  const emptyId = -1;
  const rows = await lockRows(models.ClinicMetaAsset, {
    metaConnectionId: connectionId,
    isActive: true,
    [Op.or]: isClinic
      ? [{ clinicaId: scope.clinicId, assignmentScope: { [Op.in]: ['clinic', 'unassigned'] } }]
      : [
        { assignmentScope: 'group', grupoClinicaId: scope.groupId },
        {
          assignmentScope: { [Op.in]: ['clinic', 'unassigned'] },
          clinicaId: { [Op.in]: inheritedIds.length ? inheritedIds : [emptyId] },
        },
      ],
  }, transaction);

  await assertRowsContainedInScope({
    rows,
    assetTypeOf: (row) => metaSharedAssetType(row.assetType),
    ownerClinicIdOf: (row) => row.clinicaId,
    allowedClinicIds: allGroupClinicIds,
    transaction,
    assignmentModel: models.GroupAssetClinicAssignment,
    models,
  });
  return { meta: await deactivateRows(rows, 'isActive', transaction) };
}

module.exports = {
  deactivateGoogleMappingsForScope,
  deactivateMetaMappingsForScope,
  metaSharedAssetType,
};
