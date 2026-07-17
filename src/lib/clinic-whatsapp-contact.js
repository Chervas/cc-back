'use strict';

const { normalizePhoneDigits } = require('./phone');

function buildClinicWhatsappContactProjection({ manualPhone = null, connected = null } = {}) {
  const manualWhatsapp = normalizePhoneDigits(manualPhone);
  const connectedPhone = normalizePhoneDigits(connected?.phone);
  const connectedScope = ['clinic', 'group'].includes(connected?.scope) ? connected.scope : null;
  const isClinicConnected = connectedScope === 'clinic' && !!connectedPhone;
  const publicWhatsapp = isClinicConnected
    ? connectedPhone
    : (manualWhatsapp || connectedPhone || null);

  return {
    telefono_whatsapp_conectado: connectedPhone,
    telefono_whatsapp_efectivo: publicWhatsapp,
    whatsapp_connected: !!connectedPhone,
    whatsapp_connection_scope: connectedScope,
    whatsapp_public_source: isClinicConnected
      ? 'clinic_meta'
      : (manualWhatsapp ? 'clinic_manual' : (connectedPhone ? 'group_meta' : null)),
    whatsapp_verified_name: connected?.asset?.waVerifiedName || null,
    whatsapp_quality_rating: connected?.asset?.quality_rating || null,
    whatsapp_public_differs_from_sender: !!(
      publicWhatsapp
      && connectedPhone
      && publicWhatsapp !== connectedPhone
    ),
  };
}

module.exports = { buildClinicWhatsappContactProjection };
