'use strict';
const { assertStandalone } = require('./treatment-commercial-policy');
const { requireOperationalProfile } = require('../services/treatmentBookingProfile.service');

function individualBookingEligible(treatment, clinicId, options) {
  try {
    const hidden = typeof treatment.eliminado_por_clinica === 'string' ? JSON.parse(treatment.eliminado_por_clinica) : treatment.eliminado_por_clinica;
    if (!treatment.activo || (Array.isArray(hidden) && hidden.map(Number).includes(clinicId))) return false;
    const config = typeof treatment.clinical_config === 'string' ? JSON.parse(treatment.clinical_config) : treatment.clinical_config || {};
    const product = config.product_type || config.commercial?.product_type || config.budget?.product_type;
    if (['program', 'voucher', 'pack'].includes(product) || (!product && /\bbono\b|\bpack\b|\bpaquete\b/i.test(treatment.nombre || ''))) return false;
    assertStandalone(treatment);
    requireOperationalProfile(treatment, options);
    return true;
  } catch (_) { return false; }
}
module.exports = { individualBookingEligible };
