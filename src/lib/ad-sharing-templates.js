'use strict';

// Definitions for the existing common catalog. Merely importing this module
// never inserts catalog rows, submits templates, propagates or sends messages.
const PURPOSES = Object.freeze(['lead_ad', 'patient_promotion']);
const FAMILIES = Object.freeze({
  lead_ad: Object.freeze({ IMAGE: 'clinicaclick_enviar_anuncio', VIDEO: 'clinicaclick_enviar_anuncio_video' }),
  patient_promotion: Object.freeze({ IMAGE: 'clinicaclick_compartir_promocion', VIDEO: 'clinicaclick_compartir_promocion_video' }),
});
const BODY = Object.freeze({
  lead_ad: 'Hola {{1}}, desde {{2}} te compartimos el anuncio por el que nos has consultado. {{3}} Si quieres, podemos ayudarte con más información.',
  patient_promotion: 'Hola {{1}}, te compartimos una promoción activa de {{2}}. {{3}} Si te interesa, podemos darte más información.',
});

function adSharingCatalogDefinitions() {
  return PURPOSES.flatMap(purpose => ['IMAGE', 'VIDEO'].map(format => {
    const name = FAMILIES[purpose][format];
    const variables = [
      { position: 1, name: 'nombre_paciente', example: 'Alex', description: 'Nombre del destinatario', template_usage: purpose },
      { position: 2, name: 'nombre_clinica', example: 'Clínica Centro', description: 'Clínica del mensaje', template_usage: purpose },
      { position: 3, name: 'texto_anuncio', example: 'Información de la creatividad seleccionada.',
        description: 'Texto real del único anuncio seleccionado; no inventa precios ni condiciones', template_usage: purpose },
    ];
    return {
      name, family_key: name, locale: 'es', category: 'MARKETING',
      display_name: (purpose === 'lead_ad' ? 'Enviar anuncio' : 'Compartir promociones') + (format === 'VIDEO' ? ' · Vídeo' : ''),
      body_text: BODY[purpose], variables,
      components: [{ type: 'HEADER', format },
        { type: 'BODY', text: BODY[purpose], example: { body_text: [variables.map(variable => variable.example)] } }],
      is_generic: true,
      // A central draft is reviewable without creating an operational template
      // or supplying a fabricated media sample/Meta approval.
      is_active: false,
    };
  }));
}

module.exports = { PURPOSES, FAMILIES, adSharingCatalogDefinitions };
