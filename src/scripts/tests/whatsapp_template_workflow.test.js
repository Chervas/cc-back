'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getWhatsappTemplateUsages,
  isReviewWorkflowWhatsappTemplate,
} = require('../../lib/whatsapp-template-workflow');

test('detecta una plantilla administrativa de resenas por su contrato de uso', () => {
  const template = {
    id: 2615,
    name: 'cc_solicitud_de_opinion_tras_visita',
    origin: 'external',
    variables: [
      { position: 1, template_usage: 'solicitud_resena' },
      { position: 2, template_usage: 'solicitud_resena' },
    ],
  };

  assert.deepEqual(getWhatsappTemplateUsages(template), ['solicitud_resena']);
  assert.equal(isReviewWorkflowWhatsappTemplate(template), true);
});

test('detecta las plantillas oficiales del flujo aunque sean copias antiguas', () => {
  assert.equal(isReviewWorkflowWhatsappTemplate({
    name: 'clinicaclick_solicitar_resena_v178',
    catalog_template_id: 9,
  }), true);
  assert.equal(isReviewWorkflowWhatsappTemplate({
    name: 'clinicaclick_recordatorio_resena_sin_respuesta_v4',
  }), true);
});

test('mantiene disponibles las plantillas manuales normales', () => {
  assert.equal(isReviewWorkflowWhatsappTemplate({
    name: 'cc_seguimiento_personal',
    origin: 'custom',
    variables: [{ position: 1, name: 'nombre_paciente' }],
  }), false);
});
