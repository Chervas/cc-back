'use strict';

// Definitions for the existing common catalog. Merely importing this module
// never inserts catalog rows, submits templates, propagates or sends messages.
const PURPOSES = Object.freeze(['lead_ad', 'patient_promotion']);
const FAMILIES = Object.freeze({
  lead_ad: Object.freeze({ IMAGE: 'clinicaclick_enviar_anuncio', VIDEO: 'clinicaclick_enviar_anuncio_video' }),
  patient_promotion: Object.freeze({ IMAGE: 'clinicaclick_compartir_promocion', VIDEO: 'clinicaclick_compartir_promocion_video' }),
});
const NEUTRAL_PROMOTION_FAMILIES = Object.freeze({
  IMAGE: 'clinicaclick_compartir_promocion_sin_consulta',
  VIDEO: 'clinicaclick_compartir_promocion_video_sin_consulta',
});
const AD_SHARING_FAMILIES = Object.freeze([
  ...Object.values(FAMILIES).flatMap(Object.values),
  ...Object.values(NEUTRAL_PROMOTION_FAMILIES),
]);
const BODY = Object.freeze({
  lead_ad: 'Hola {{1}}, desde {{2}} te compartimos el anuncio por el que nos has consultado. {{3}} Si quieres, podemos ayudarte con más información.',
  patient_promotion: 'Hola {{1}}, te compartimos una promoción activa de {{2}}. {{3}} Si te interesa, podemos darte más información.',
});
const NEUTRAL_PROMOTION_BODY = 'Hola {{1}}, desde {{2}} queremos compartir contigo esta información. {{3}} Si te interesa, podemos darte más detalles.';
const TEMPLATE_SAMPLE_BASE = 'https://crm.clinicaclick.com/assets/whatsapp/template-samples/20261118-v1';

function catalogDefinition({ purpose, format, name, title, body, sampleUrl }) {
  const variables = [
    { position: 1, name: 'nombre_paciente', example: 'Alex', description: 'Nombre del destinatario', template_usage: purpose },
    { position: 2, name: 'nombre_clinica', example: 'Clínica Centro', description: 'Clínica del mensaje', template_usage: purpose },
    { position: 3, name: 'texto_anuncio', example: 'Información de la creatividad seleccionada.',
      description: 'Texto del anuncio seleccionado, editable para este envío', template_usage: purpose },
  ];
  return {
    name, family_key: name, locale: 'es', category: 'MARKETING',
    display_name: title + (format === 'VIDEO' ? ' · Vídeo' : ''),
    body_text: body, variables,
    components: [{ type: 'HEADER', format, ...(sampleUrl ? { example: { header_handle: [sampleUrl] } } : {}) },
      { type: 'BODY', text: body, example: { body_text: [variables.map(variable => variable.example)] } }],
    is_generic: true,
    is_active: false,
  };
}

function neutralPromotionCatalogDefinitions() {
  return Object.entries(NEUTRAL_PROMOTION_FAMILIES).map(([format, name]) => catalogDefinition({
    purpose: 'patient_promotion', format, name, title: 'Compartir promoción sin consulta previa',
    body: NEUTRAL_PROMOTION_BODY, sampleUrl: `${TEMPLATE_SAMPLE_BASE}/sample.${format === 'VIDEO' ? 'mp4' : 'png'}`,
  }));
}

function adSharingCatalogDefinitions() {
  return [
    ...PURPOSES.flatMap(purpose => Object.entries(FAMILIES[purpose]).map(([format, name]) => catalogDefinition({
      purpose, format, name, body: BODY[purpose],
      title: purpose === 'lead_ad' ? 'Enviar anuncio' : 'Compartir promociones',
    }))),
    ...neutralPromotionCatalogDefinitions(),
  ];
}

if (require.main === module) {
  // Draft payloads for the existing catalog UI/API. No database or Meta calls.
  process.stdout.write(`${JSON.stringify(neutralPromotionCatalogDefinitions(), null, 2)}\n`);
}

module.exports = { PURPOSES, FAMILIES, NEUTRAL_PROMOTION_FAMILIES, AD_SHARING_FAMILIES, adSharingCatalogDefinitions };
