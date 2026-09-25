'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../services/marketingBulkSends.service');
const whatsappService = require('../../services/whatsapp.service');

const {
  getReviewWabaIdForScope,
  hasWhatsappConfigForClinic,
  isAllowedReviewRequestTemplateCopy,
  isWhatsappRoutingConfigAvailable,
  selectApprovedReviewTemplateCandidate,
} = service.__testing;

test('review readiness accepts an exact tokenless broker authorization', () => {
  const config = {
    originId: 398,
    phoneNumberId: '1408462885673079',
    wabaId: '1752472712729778',
    clinicId: 56,
    routingUnavailable: false,
    authorizedBroker: {
      assetId: 398,
      phoneId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      sendEnabled: true,
    },
  };

  assert.equal(Object.hasOwn(config, 'accessToken'), false);
  assert.equal(isWhatsappRoutingConfigAvailable(config), true);
});

test('review readiness remains closed for paused or mismatched broker bindings', () => {
  const base = {
    originId: 398,
    phoneNumberId: '1408462885673079',
    wabaId: '1752472712729778',
    clinicId: 56,
    routingUnavailable: false,
    authorizedBroker: {
      assetId: 398,
      phoneId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      sendEnabled: true,
    },
  };

  assert.equal(isWhatsappRoutingConfigAvailable({
    ...base,
    authorizedBroker: { ...base.authorizedBroker, sendEnabled: false },
  }), false);
  assert.equal(isWhatsappRoutingConfigAvailable({
    ...base,
    authorizedBroker: { ...base.authorizedBroker, assetId: 399 },
  }), false);
  assert.equal(isWhatsappRoutingConfigAvailable({ ...base, routingUnavailable: true }), false);
});

test('review readiness preserves support for a complete legacy configuration', () => {
  assert.equal(isWhatsappRoutingConfigAvailable({
    originId: 12,
    phoneNumberId: '401',
    wabaId: '501',
    clinicId: 56,
    accessToken: 'SYNTHETIC_LEGACY_TOKEN',
  }), true);
});

test('review readiness resolves the sender selected for review requests', async (t) => {
  const calls = [];
  t.mock.method(whatsappService, 'getClinicConfig', async (clinicId, options) => {
    calls.push({ clinicId, options });
    return {
      originId: 398,
      phoneNumberId: '1408462885673079',
      wabaId: '1752472712729778',
      clinicId: 56,
      routingUnavailable: false,
      authorizedBroker: {
        assetId: 398,
        phoneId: '1408462885673079',
        wabaId: '1752472712729778',
        clinicId: 56,
        sendEnabled: true,
      },
    };
  });

  assert.equal(await hasWhatsappConfigForClinic(56), true);
  assert.deepEqual(calls, [{ clinicId: 56, options: { purpose: 'review_requests' } }]);
});

test('review templates resolve the WABA selected for review requests', async (t) => {
  const calls = [];
  t.mock.method(whatsappService, 'getClinicConfig', async (clinicId, options) => {
    calls.push({ clinicId, options });
    return { wabaId: 'waba-review-secondary' };
  });

  const wabaId = await getReviewWabaIdForScope({ clinicIds: [56] });

  assert.equal(wabaId, 'waba-review-secondary');
  assert.deepEqual(calls, [{ clinicId: 56, options: { purpose: 'review_requests' } }]);
});

test('an approved admin review template may keep the category accepted by Meta', () => {
  const template = {
    name: 'cc_solicitud_de_opinion_tras_visita_test',
    origin: 'custom',
    created_by_user_id: 1,
    category: 'UTILITY',
    variables: [
      { position: 1, name: 'nombre_paciente', template_usage: 'solicitud_resena' },
      { position: 2, name: 'firma_resenas', template_usage: 'solicitud_resena' },
      { position: 3, name: 'nombre_clinica', template_usage: 'solicitud_resena' },
      { position: 4, name: 'fecha_ultima_cita_asistida', template_usage: 'solicitud_resena' },
    ],
    components: [{
      type: 'BODY',
      text: 'Hola {{1}}, soy {{2}} de {{3}}. Queremos saber cómo te atendimos en tu visita del {{4}}. ¿Cómo valorarías tu experiencia?\n\nResponde con un número:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nTu valoración nos ayuda mucho.',
    }],
  };

  assert.equal(isAllowedReviewRequestTemplateCopy(template), true);
});

test('a clinic-specific approved photo template wins over the generic catalog copy', () => {
  const components = [{
    type: 'HEADER',
    format: 'IMAGE',
  }, {
    type: 'BODY',
    text: 'Hola {{1}}, soy {{2}} de {{3}}. Queremos saber cómo te atendimos en tu visita del {{4}}. ¿Cómo valorarías tu experiencia?\n\nResponde con un número:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nTu valoración nos ayuda mucho.',
  }];
  const custom = {
    id: 4714,
    name: 'cc_solicitud_de_opinion_tras_visita_test',
    origin: 'custom',
    created_by_user_id: 1,
    category: 'UTILITY',
    clinic_id: 56,
    waba_id: 'waba-review-secondary',
    components,
    variables: [{ name: 'nombre_paciente', template_usage: 'solicitud_resena' }],
  };
  const catalog = {
    id: 4552,
    name: 'clinicaclick_solicitar_resena_foto_v1',
    origin: 'catalog',
    category: 'MARKETING',
    clinic_id: null,
    waba_id: 'waba-review-secondary',
    components,
    variables: [{ name: 'nombre_paciente', template_usage: 'solicitud_resena' }],
    catalog: { body_text: components[1].text },
  };

  const selected = selectApprovedReviewTemplateCandidate([catalog, custom], {
    clinicIds: [56],
    targetWabaId: 'waba-review-secondary',
    preferPhoto: true,
  });

  assert.equal(selected.id, 4714);
});
