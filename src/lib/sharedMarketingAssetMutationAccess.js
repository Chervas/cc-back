'use strict';

function positiveClinicId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assetInUseError() {
  const error = new Error(
    'El activo también está asignado a otras clínicas sobre las que no tienes permisos de edición.'
  );
  error.code = 'asset_in_use';
  error.httpStatus = 409;
  return error;
}

async function affectedClinicIdsForAsset({
  assetType,
  assetId,
  ownerClinicId,
  transaction = null,
  assignmentModel = null,
  findImplicitGroupId = null,
  findGroupClinicIds = null,
}) {
  const normalizedAssetId = Number.parseInt(String(assetId ?? ''), 10);
  if (!assetType || !Number.isInteger(normalizedAssetId) || normalizedAssetId <= 0) {
    return [];
  }

  const query = {
    where: { assetType, assetId: normalizedAssetId },
    attributes: ['clinicaId'],
    raw: true,
  };
  if (transaction) {
    query.transaction = transaction;
    query.lock = transaction.LOCK.UPDATE;
  }
  const effectiveAssignmentModel = assignmentModel || require('../../models').GroupAssetClinicAssignment;
  const rows = await effectiveAssignmentModel.findAll(query);
  const models = (!findImplicitGroupId || !findGroupClinicIds) ? require('../../models') : null;
  const effectiveFindImplicitGroupId = findImplicitGroupId || (async ({ assetType: type, assetId: id }) => {
    const model = type === 'google.ads_account'
      ? models.ClinicGoogleAdsAccount
      : type.startsWith('meta.')
        ? models.ClinicMetaAsset
        : null;
    if (!model) return null;
    const record = await model.findByPk(id, {
      attributes: ['assignmentScope', 'grupoClinicaId'],
      raw: true,
      ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
    });
    return record?.assignmentScope === 'group'
      ? positiveClinicId(record.grupoClinicaId)
      : null;
  });
  const effectiveFindGroupClinicIds = findGroupClinicIds || (async (groupId) => {
    const clinics = await models.Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
    return clinics.map((clinic) => clinic.id_clinica);
  });
  const implicitGroupId = positiveClinicId(await effectiveFindImplicitGroupId({
    assetType,
    assetId: normalizedAssetId,
    transaction,
  }));
  const implicitGroupClinicIds = implicitGroupId
    ? await effectiveFindGroupClinicIds(implicitGroupId)
    : [];
  return Array.from(new Set([
    positiveClinicId(ownerClinicId),
    ...rows.map((row) => positiveClinicId(row?.clinicaId)),
    ...implicitGroupClinicIds.map(positiveClinicId),
  ].filter(Boolean)));
}

async function assertSharedMarketingAssetMutationAccess({
  userId,
  assetType,
  assetId,
  ownerClinicId,
  transaction = null,
  assignmentModel = null,
  authorizeClinicIds = null,
  findImplicitGroupId = null,
  findGroupClinicIds = null,
}) {
  const clinicIds = await affectedClinicIdsForAsset({
    assetType,
    assetId,
    ownerClinicId,
    transaction,
    assignmentModel,
    findImplicitGroupId,
    findGroupClinicIds,
  });
  if (!clinicIds.length) throw assetInUseError();

  const effectiveAuthorizeClinicIds = authorizeClinicIds
    || require('./marketingScopeAccess').hasMarketingClinicScopeAccess;
  const allowed = await effectiveAuthorizeClinicIds({
    userId,
    clinicIds,
    access: 'write',
  });
  if (!allowed) throw assetInUseError();
  return clinicIds;
}

module.exports = {
  affectedClinicIdsForAsset,
  assertSharedMarketingAssetMutationAccess,
};
