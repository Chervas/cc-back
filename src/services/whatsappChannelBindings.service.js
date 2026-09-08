'use strict';

const db = require('../../models');
const {
  buildWhatsappRoutingAdditionalData,
  normalizeWhatsappChannelRole,
  normalizeWhatsappSecondaryPurposes,
  normalizeWhatsappSecondaryUnavailableAction,
} = require('../lib/whatsapp-channel-role');

const { ClinicMetaAsset, Clinica, WhatsappChannelBinding } = db;

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function listClinicBindings(clinicId, options = {}) {
  const normalizedClinicId = toInt(clinicId);
  if (!normalizedClinicId || !WhatsappChannelBinding) return [];
  return WhatsappChannelBinding.findAll({
    where: { clinic_id: normalizedClinicId, is_active: true },
    ...(options.transaction ? { transaction: options.transaction } : {}),
    ...(options.raw === false ? {} : { raw: true }),
  });
}

function applyBindingToAsset(asset, binding) {
  if (!asset || !binding) return asset;
  const plain = asset.get ? asset.get({ plain: true }) : { ...asset };
  const role = normalizeWhatsappChannelRole(binding.role) || 'primary';
  const purposes = role === 'secondary'
    ? normalizeWhatsappSecondaryPurposes(binding.purposes)
    : [];
  const unavailableAction = normalizeWhatsappSecondaryUnavailableAction(binding.unavailable_action);
  return {
    ...plain,
    whatsapp_channel_role: role,
    additionalData: buildWhatsappRoutingAdditionalData(plain.additionalData, {
      role,
      purposes,
      unavailableAction,
    }),
    routing_binding_id: toInt(binding.id),
    routing_binding_clinic_id: toInt(binding.clinic_id),
    routing_binding_role: role,
  };
}

async function applyClinicBindings(clinicId, assets = []) {
  const bindings = await listClinicBindings(clinicId);
  const byAsset = new Map(bindings.map((binding) => [Number(binding.asset_id), binding]));
  return (Array.isArray(assets) ? assets : []).map((asset) => (
    applyBindingToAsset(asset, byAsset.get(Number(asset?.id)))
  ));
}

async function upsertClinicBinding({
  clinicId,
  assetId,
  role,
  purposes = [],
  unavailableAction = 'pause',
  actorUserId = null,
}) {
  const normalizedClinicId = toInt(clinicId);
  const normalizedAssetId = toInt(assetId);
  const normalizedRole = normalizeWhatsappChannelRole(role);
  if (!normalizedClinicId || !normalizedAssetId || !normalizedRole) {
    const error = new Error('invalid_whatsapp_scope_binding');
    error.status = 400;
    throw error;
  }

  return db.sequelize.transaction(async (transaction) => {
    const [clinic, asset] = await Promise.all([
      Clinica.findByPk(normalizedClinicId, {
        attributes: ['id_clinica', 'grupoClinicaId'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
      ClinicMetaAsset.findByPk(normalizedAssetId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
    ]);
    if (!clinic || !asset || asset.assetType !== 'whatsapp_phone_number' || !asset.isActive) {
      const error = new Error('whatsapp_scope_binding_asset_not_found');
      error.status = 404;
      throw error;
    }
    const belongsToClinic = asset.assignmentScope === 'clinic'
      && Number(asset.clinicaId) === normalizedClinicId;
    const belongsToGroup = asset.assignmentScope === 'group'
      && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId || 0);
    if (!belongsToClinic && !belongsToGroup) {
      const error = new Error('whatsapp_scope_binding_asset_outside_clinic');
      error.status = 409;
      throw error;
    }

    await WhatsappChannelBinding.destroy({
      where: { clinic_id: normalizedClinicId, role: normalizedRole },
      transaction,
    });
    await WhatsappChannelBinding.destroy({
      where: { clinic_id: normalizedClinicId, asset_id: normalizedAssetId },
      transaction,
    });
    return WhatsappChannelBinding.create({
      clinic_id: normalizedClinicId,
      asset_id: normalizedAssetId,
      role: normalizedRole,
      purposes: normalizedRole === 'secondary'
        ? normalizeWhatsappSecondaryPurposes(purposes)
        : [],
      unavailable_action: normalizedRole === 'secondary'
        ? normalizeWhatsappSecondaryUnavailableAction(unavailableAction)
        : 'pause',
      is_active: true,
      created_by: toInt(actorUserId),
      updated_by: toInt(actorUserId),
    }, { transaction });
  });
}

async function removeClinicBinding({ clinicId, role, actorUserId = null }) {
  void actorUserId;
  const normalizedClinicId = toInt(clinicId);
  const normalizedRole = normalizeWhatsappChannelRole(role);
  if (!normalizedClinicId || !normalizedRole || !WhatsappChannelBinding) return 0;
  return WhatsappChannelBinding.destroy({
    where: { clinic_id: normalizedClinicId, role: normalizedRole },
  });
}

module.exports = {
  applyBindingToAsset,
  applyClinicBindings,
  listClinicBindings,
  removeClinicBinding,
  upsertClinicBinding,
};
