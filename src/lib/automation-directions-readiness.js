'use strict';

function usesClinicDirections(template) {
  return (Array.isArray(template?.nodes) ? template.nodes : []).some(node => node?.type === 'action/send_whatsapp'
    && (/clinica\.(?:url_como_llegar|url_perfil_google)/.test(JSON.stringify(node.config || {}))
      || /clinicaclick_recordatorio_(?:mismo_dia|dia_antes)/.test(JSON.stringify(node.config || {}))));
}

// Describe the link actually selected by the existing resolver, not a review
// profile alias or a manually stored URL which that resolver does not select.
function directionsReadiness(clinic, location, links) {
  if (location && links.place_id) return { status: 'ready', reason: null };
  if (location) return { status: 'warning', reason: 'profile_location_unverified' };
  if (String(clinic?.direccion || '').trim()) return { status: 'warning', reason: 'address_fallback' };
  return { status: 'warning', reason: 'location_missing' };
}

module.exports = { usesClinicDirections, directionsReadiness };
