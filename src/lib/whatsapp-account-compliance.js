'use strict';

const crypto = require('crypto');

const RESTRICTION_FLAGS = {
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: 'blocks_phone_changes',
  RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING: 'blocks_calling',
  RESTRICTED_BIZ_INITIATED_MESSAGING: 'blocks_business_initiated',
  RESTRICTED_BUSINESS_INITIATED_CALLING: 'blocks_calling',
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: 'blocks_customer_replies',
  RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES: 'blocks_business_initiated',
  RESTRICTED_USER_INITIATED_CALLING: 'blocks_calling',
  RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN: 'blocks_calling',
  RESTRICTED_UTILITY_TEMPLATES: 'blocks_business_initiated',
};

const RESTRICTION_LABELS = {
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: 'No se pueden añadir números a la cuenta',
  RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING: 'No se pueden realizar ni recibir llamadas',
  RESTRICTED_BIZ_INITIATED_MESSAGING: 'No se pueden iniciar conversaciones con pacientes',
  RESTRICTED_BUSINESS_INITIATED_CALLING: 'No se pueden realizar llamadas salientes',
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: 'No se puede responder a conversaciones iniciadas por pacientes',
  RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES: 'No se pueden enviar plantillas de utilidad mediante Direct Send',
  RESTRICTED_USER_INITIATED_CALLING: 'No se pueden recibir llamadas de usuarios',
  RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN: 'Meta ha ocultado el botón de llamada por baja tasa de respuesta',
  RESTRICTED_UTILITY_TEMPLATES: 'No se pueden crear plantillas de utilidad',
};

const VIOLATION_LABELS = {
  ADULT: 'Productos o servicios para adultos',
  ALCOHOL: 'Alcohol',
  ANIMALS: 'Venta de animales',
  BODY_PARTS_FLUIDS: 'Partes o fluidos corporales',
  DATING: 'Servicios de citas',
  DIGITAL_SERVICES_PRODUCTS: 'Productos o servicios digitales restringidos',
  DRUGS: 'Drogas o productos relacionados',
  GAMBLING: 'Juego o apuestas',
  HEALTHCARE: 'Productos o servicios sanitarios restringidos',
  ILLEGAL_PRODUCTS: 'Productos o servicios ilegales',
  MISLEADING: 'Contenido engañoso',
  OVERTLY_SEXUALIZED_POSITIONING: 'Contenido sexualizado',
  REAL_FAKE_CURRENCY: 'Moneda real o falsificada',
  SCAM: 'Posible fraude',
  SUPPLEMENTS: 'Suplementos no permitidos',
  THIRD_PARTY_INFRINGEMENTS: 'Derechos de terceros',
  TOBACCO: 'Tabaco',
  UNAUTHORIZED_MEDIA: 'Contenido multimedia no autorizado',
  WEAPONS: 'Armas',
};

const VIOLATION_DESCRIPTIONS = {
  ADULT: 'Transacciones o promoción de productos y servicios para adultos.',
  ALCOHOL: 'Transacciones relacionadas con la venta de alcohol.',
  ANIMALS: 'Transacciones relacionadas con la venta de animales o partes prohibidas.',
  BODY_PARTS_FLUIDS: 'Transacciones relacionadas con partes del cuerpo humano o fluidos corporales.',
  DATING: 'Servicios de citas en internet.',
  DIGITAL_SERVICES_PRODUCTS: 'Venta o distribución de cuentas, suscripciones o contenido digital restringido.',
  DRUGS: 'Venta de drogas ilegales, recreativas o medicamentos con receta.',
  GAMBLING: 'Apuestas, juegos de habilidad o loterías con dinero.',
  HEALTHCARE: 'Transacciones relacionadas con determinados productos sanitarios restringidos.',
  ILLEGAL_PRODUCTS: 'Productos o servicios ilegales.',
  MISLEADING: 'Modelo de negocio, producto o servicio que Meta considera engañoso o que ejerce presión indebida.',
  OVERTLY_SEXUALIZED_POSITIONING: 'Presentación sexualmente sugerente de productos o servicios.',
  REAL_FAKE_CURRENCY: 'Venta de dinero real, falso o virtual e instrumentos equivalentes.',
  SCAM: 'Actividad que promociona o facilita fraude.',
  SUPPLEMENTS: 'Venta de suplementos ingeribles que WhatsApp considera no seguros.',
  THIRD_PARTY_INFRINGEMENTS: 'Posible infracción de derechos de autor, marca u otros derechos de terceros.',
  TOBACCO: 'Venta de tabaco o accesorios relacionados.',
  UNAUTHORIZED_MEDIA: 'Dispositivos que facilitan acceso o transmisión no autorizada de contenido.',
  WEAPONS: 'Venta o uso de armas, munición o explosivos.',
};

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function buildDedupeKey({ wabaId, field, entry, value }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    wabaId: wabaId || null,
    field: field || null,
    entryTime: entry?.time || null,
    value: value || null,
  })).digest('hex');
}

function isGroupScopedAsset(asset) {
  return clean(asset?.assignmentScope).toLowerCase() === 'group'
    && Number(asset?.grupoClinicaId || 0) > 0;
}

function parseProviderDate(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRestrictions(value, now = new Date()) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  return rows.map((row) => {
    const type = clean(row?.restriction_type || row?.type).toUpperCase();
    const expiration = parseProviderDate(row?.expiration);
    return {
      restriction_type: type || null,
      restriction_label: type ? (RESTRICTION_LABELS[type] || type) : null,
      expiration: expiration ? expiration.toISOString() : null,
      remediation: clean(row?.remediation) || null,
      active: !expiration || expiration.getTime() > now.getTime(),
    };
  });
}

function deriveComplianceSnapshot(value = {}, now = new Date()) {
  const event = clean(value?.event).toUpperCase() || 'ACCOUNT_UPDATE';
  const violationType = clean(value?.violation_info?.violation_type).toUpperCase() || null;
  const banState = clean(value?.ban_info?.waba_ban_state).toUpperCase() || null;
  const banDate = parseProviderDate(value?.ban_info?.waba_ban_date);
  const restrictions = normalizeRestrictions(value?.restriction_info, now);
  const activeRestrictions = restrictions.filter((item) => item.active);
  const flags = {
    blocks_all_sending: false,
    blocks_business_initiated: false,
    blocks_customer_replies: false,
    blocks_phone_changes: false,
    blocks_calling: false,
  };
  activeRestrictions.forEach((restriction) => {
    const flag = RESTRICTION_FLAGS[restriction.restriction_type];
    if (flag) flags[flag] = true;
  });

  let status = 'active';
  let severity = 'info';
  let appealable = null;

  if (event === 'ACCOUNT_VIOLATION') {
    status = 'warning';
    severity = 'warning';
    appealable = typeof value?.appealable === 'boolean' ? value.appealable : null;
  }
  if (event === 'ACCOUNT_RESTRICTION') {
    status = activeRestrictions.length ? 'restricted' : 'active';
    severity = activeRestrictions.length ? 'error' : 'info';
  }
  if (event === 'DISABLED_UPDATE') {
    if (banState === 'DISABLE') {
      status = 'suspended';
      severity = 'error';
      flags.blocks_all_sending = true;
    } else if (banState === 'SCHEDULE_FOR_DISABLE') {
      status = 'scheduled_for_disable';
      severity = 'error';
    } else if (banState === 'REINSTATE') {
      status = 'active';
      severity = 'info';
    }
  }
  if (event === 'ACCOUNT_DELETED') {
    status = 'deleted';
    severity = 'error';
    flags.blocks_all_sending = true;
    appealable = false;
  }

  const remediation = restrictions
    .map((item) => item.remediation)
    .filter(Boolean)
    .join('\n') || null;

  return {
    event,
    status,
    severity,
    violation_type: violationType,
    violation_label: violationType ? (VIOLATION_LABELS[violationType] || violationType) : null,
    violation_description: violationType ? (VIOLATION_DESCRIPTIONS[violationType] || null) : null,
    ban_state: banState,
    ban_date: banDate ? banDate.toISOString() : null,
    restrictions,
    remediation,
    appealable,
    ...flags,
  };
}

module.exports = {
  RESTRICTION_FLAGS,
  RESTRICTION_LABELS,
  VIOLATION_DESCRIPTIONS,
  VIOLATION_LABELS,
  buildDedupeKey,
  deriveComplianceSnapshot,
  isGroupScopedAsset,
  normalizeRestrictions,
  parseProviderDate,
};
