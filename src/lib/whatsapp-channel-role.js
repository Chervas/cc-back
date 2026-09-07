'use strict';

const WHATSAPP_CHANNEL_ROLES = Object.freeze(['primary', 'secondary']);
const WHATSAPP_SECONDARY_PURPOSES = Object.freeze([
  'bulk_campaigns',
  'review_requests',
  'lead_first_contact',
]);
const WHATSAPP_SECONDARY_UNAVAILABLE_ACTIONS = Object.freeze([
  'pause',
  'fallback_primary',
]);

function normalizeWhatsappChannelRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return WHATSAPP_CHANNEL_ROLES.includes(normalized) ? normalized : null;
}

function normalizeWhatsappSecondaryPurposes(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(new Set(
    source
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => WHATSAPP_SECONDARY_PURPOSES.includes(item))
  ));
}

function normalizeWhatsappSecondaryUnavailableAction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return WHATSAPP_SECONDARY_UNAVAILABLE_ACTIONS.includes(normalized)
    ? normalized
    : 'pause';
}

function resolveWhatsappChannelRole(source = {}) {
  const additionalData = source?.additionalData && typeof source.additionalData === 'object'
    ? source.additionalData
    : {};
  const routing = additionalData.routing && typeof additionalData.routing === 'object'
    ? additionalData.routing
    : {};
  return normalizeWhatsappChannelRole(
    source.whatsapp_channel_role
    || source.whatsappChannelRole
    || source.channel_role
    || source.channelRole
    || additionalData.whatsapp_channel_role
    || additionalData.whatsappChannelRole
    || additionalData.messaging_role
    || additionalData.messagingRole
    || routing.whatsapp_channel_role
    || routing.whatsappChannelRole
    || routing.role
  );
}

function resolveWhatsappRouting(source = {}) {
  const additionalData = source?.additionalData && typeof source.additionalData === 'object'
    ? source.additionalData
    : {};
  const routing = additionalData.routing && typeof additionalData.routing === 'object'
    ? additionalData.routing
    : {};
  return {
    role: resolveWhatsappChannelRole(source) || 'primary',
    purposes: normalizeWhatsappSecondaryPurposes(
      routing.secondary_purposes
      || routing.secondaryPurposes
      || routing.purposes
    ),
    unavailableAction: normalizeWhatsappSecondaryUnavailableAction(
      routing.secondary_unavailable_action
      || routing.secondaryUnavailableAction
      || routing.unavailable_action
      || routing.unavailableAction
    ),
  };
}

function buildWhatsappRoutingAdditionalData(source = {}, values = {}) {
  const additionalData = source && typeof source === 'object' && !Array.isArray(source)
    ? { ...source }
    : {};
  const currentRouting = additionalData.routing && typeof additionalData.routing === 'object'
    ? additionalData.routing
    : {};
  const role = normalizeWhatsappChannelRole(values.role) || 'primary';
  const routing = {
    ...currentRouting,
    whatsapp_channel_role: role,
    secondary_purposes: role === 'secondary'
      ? normalizeWhatsappSecondaryPurposes(values.purposes)
      : [],
    secondary_unavailable_action: role === 'secondary'
      ? normalizeWhatsappSecondaryUnavailableAction(values.unavailableAction)
      : 'pause',
  };
  return {
    ...additionalData,
    whatsapp_channel_role: role,
    routing,
  };
}

function selectWhatsappPhoneAsset({
  clinicAssets = [],
  groupAssets = [],
  purpose = null,
  summarizeHealth = () => ({ can_send: true }),
} = {}) {
  const findRole = (assets, role) => (Array.isArray(assets) ? assets : [])
    .find((asset) => resolveWhatsappRouting(asset).role === role) || null;
  const primary = findRole(clinicAssets, 'primary') || findRole(groupAssets, 'primary');
  const secondary = findRole(clinicAssets, 'secondary') || findRole(groupAssets, 'secondary');
  const normalizedPurpose = String(purpose || '').trim().toLowerCase();

  if (!secondary || !normalizedPurpose) return primary;

  const routing = resolveWhatsappRouting(secondary);
  if (!routing.purposes.includes(normalizedPurpose)) return primary;

  const health = summarizeHealth(secondary) || {};
  const secondaryCanSend = Boolean(secondary.waAccessToken && secondary.phoneNumberId)
    && health.can_send !== false;
  if (!secondaryCanSend && routing.unavailableAction === 'fallback_primary') {
    return primary;
  }
  return {
    ...secondary,
    routing_unavailable: !secondaryCanSend,
    routing_purpose: normalizedPurpose,
  };
}

module.exports = {
  WHATSAPP_CHANNEL_ROLES,
  WHATSAPP_SECONDARY_PURPOSES,
  WHATSAPP_SECONDARY_UNAVAILABLE_ACTIONS,
  buildWhatsappRoutingAdditionalData,
  normalizeWhatsappChannelRole,
  normalizeWhatsappSecondaryPurposes,
  normalizeWhatsappSecondaryUnavailableAction,
  resolveWhatsappChannelRole,
  resolveWhatsappRouting,
  selectWhatsappPhoneAsset,
};
