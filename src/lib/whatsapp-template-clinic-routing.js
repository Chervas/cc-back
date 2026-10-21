'use strict';

const { buildWhatsappRoutingAdditionalData, selectWhatsappPhoneAsset } = require('./whatsapp-channel-role');
const { current: manualDisconnect } = require('./whatsappManualDisconnect');
const enabled = value => value === true || value === 1;

// Use the same primary/secondary selection as sends, then check credentials.
// Filtering a stopped primary first could silently select a historical number.
function templateAssetsForClinic({ clinic, assets = [], channelBindings = [], authorizedBindings = null }) {
  const clinicId = Number(clinic?.id_clinica), groupId = Number(clinic?.grupoClinicaId);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) return [];
  const bindings = channelBindings.filter(row => Number(row.clinic_id) === clinicId && enabled(row.is_active));
  const explicitPrimary = bindings.some(row => row.role === 'primary');
  const candidates = assets.filter(row => row.assetType === 'whatsapp_phone_number'
    && (!explicitPrimary || bindings.some(binding => Number(binding.asset_id) === Number(row.id)))
    && (row.assignmentScope === 'clinic' && Number(row.clinicaId) === clinicId
      || row.assignmentScope === 'group' && groupId > 0 && Number(row.grupoClinicaId) === groupId))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0) || Number(b.id) - Number(a.id))
    .map(row => {
      const binding = bindings.find(binding => Number(binding.asset_id) === Number(row.id));
      const authorization = authorizedBindings?.find(b => Number(b.clinicId) === clinicId && Number(b.assetId) === Number(row.id)
        && b.phoneId === row.phoneNumberId && b.wabaId === row.wabaId);
      const asset = authorization ? { ...row, whatsappAuthorizedBinding: authorization } : row;
      return binding ? { ...asset, routing_binding_id: binding.id, routing_binding_role: binding.role,
        additionalData: buildWhatsappRoutingAdditionalData(row.additionalData, { role: binding.role,
          purposes: binding.purposes, unavailableAction: binding.unavailable_action }) } : asset;
    });
  const selected = new Map();
  for (const purpose of [null, 'bulk_campaigns', 'review_requests']) {
    const row = selectWhatsappPhoneAsset({ clinicAssets: candidates.filter(row => row.assignmentScope === 'clinic'),
      groupAssets: candidates.filter(row => row.assignmentScope === 'group'), purpose });
    if (row) selected.set(Number(row.id), row);
  }
  return [...selected.values()].filter(row => {
    if (!enabled(row.isActive) || !row.phoneNumberId || !row.wabaId || row.additionalData?.routing_disabled
      || row.additionalData?.whatsappArchive?.archivedAt) return false;
    const binding = authorizedBindings?.find(binding => Number(binding.clinicId) === clinicId
      && Number(binding.assetId) === Number(row.id) && binding.phoneId === row.phoneNumberId && binding.wabaId === row.wabaId);
    if (manualDisconnect(row, binding)) return false;
    return authorizedBindings !== null ? binding?.sendEnabled === true
      : enabled(row.hasCredentials) || !!row.waAccessToken;
  });
}

module.exports = { templateAssetsForClinic };
