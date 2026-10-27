'use strict';

const { resolveWhatsappChannelRole } = require('./whatsapp-channel-role');
const { normalizePhoneDigits } = require('./phone');

function publicNumber(asset) {
  return normalizePhoneDigits(asset?.additionalData?.displayPhoneNumber
    || asset?.additionalData?.display_phone_number || asset?.metaAssetName);
}

// Public inbound destinations follow explicit clinic routing, not updatedAt:
// syncing templates or health must never turn a secondary into the web number.
function resolvePublicWhatsapp({ clinic, assets = [], bindings = [], configured = {} }) {
  const clinicId = Number(clinic.id_clinica);
  const inScope = assets.filter(a => [true, 1, '1'].includes(a.isActive)
    && a.assetType === 'whatsapp_phone_number'
    && (a.assignmentScope === 'group'
      ? Number(a.grupoClinicaId) === Number(clinic.grupoClinicaId) && Number(clinic.grupoClinicaId) > 0
      : Number(a.clinicaId) === clinicId));
  const saved = bindings.filter(b => Number(b.clinic_id) === clinicId && [true, 1, '1'].includes(b.is_active));
  const eligible = saved.length
    ? inScope.filter(a => saved.some(b => Number(b.asset_id) === Number(a.id)))
    : inScope.filter(a => !a.additionalData?.routing_disabled && !a.additionalData?.requireClinicSelection);
  const aliases = [...new Set(eligible.map(publicNumber).filter(Boolean))];
  const chosen = normalizePhoneDigits(configured.public_whatsapp);
  if (configured.public_whatsapp != null && configured.public_whatsapp !== '') return {
    whatsapp: chosen && aliases.includes(chosen) ? chosen : null,
    whatsapp_source: chosen && aliases.includes(chosen) ? 'web_selection' : 'web_selection_unavailable',
    whatsapp_connected: Boolean(chosen && aliases.includes(chosen)), whatsapp_aliases: aliases,
  };
  const bound = saved.filter(b => b.role === 'primary');
  const primary = saved.length
    ? eligible.filter(a => bound.some(b => Number(b.asset_id) === Number(a.id)))
    : eligible.filter(a => (resolveWhatsappChannelRole(a) || 'primary') === 'primary');
  const own = primary.filter(a => a.assignmentScope !== 'group');
  const numbers = [...new Set((own.length ? own : primary).map(publicNumber).filter(Boolean))];
  if (saved.length || inScope.length) return {
    whatsapp: numbers.length === 1 ? numbers[0] : null,
    whatsapp_source: numbers.length === 1 ? 'primary_routing' : 'routing_unavailable',
    whatsapp_connected: numbers.length === 1, whatsapp_aliases: aliases,
  };
  const manual = normalizePhoneDigits(clinic.telefono_whatsapp);
  return {whatsapp: manual, whatsapp_source: manual ? 'clinic_manual' : null,
    whatsapp_connected: false, whatsapp_aliases: manual ? [manual] : []};
}

module.exports = { resolvePublicWhatsapp };
