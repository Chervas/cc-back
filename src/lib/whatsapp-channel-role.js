'use strict';

function normalizeWhatsappChannelRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'primary' || normalized === 'secondary' ? normalized : null;
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

module.exports = {
  normalizeWhatsappChannelRole,
  resolveWhatsappChannelRole,
};
