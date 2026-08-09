'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const classifier = require('../../services/reviewResponseClassification.service');
const db = require('../../../models');
const marketingOptOut = require('../../services/marketingOptOut.service');
const migration = require('../../../migrations/20260809113000-version-review-response-classification');

test('clasifica respuestas inequívocas sin consumir IA', () => {
  assert.deepEqual(
    classifier.classifyDeterministically('Os doy un 5 😊'),
    { intent: 'rating', rating: 5, confidence: 1, source: 'rule' },
  );
  assert.equal(
    classifier.classifyDeterministically('No quiero recibir más mensajes ni publicidad').intent,
    'marketing_opt_out',
  );
  assert.equal(
    classifier.classifyDeterministically('Este número ya no pertenece a Luis Felipe').intent,
    'wrong_recipient',
  );
  assert.equal(
    classifier.classifyDeterministically('Prefiero no dejar una reseña').intent,
    'review_refusal',
  );
  assert.equal(
    classifier.classifyDeterministically('Os doy un 5, pero no me escribáis más').intent,
    'marketing_opt_out',
  );
});

test('deja las respuestas no concluyentes para la revisión común de IA', () => {
  const result = classifier.classifyDeterministically('Gracias, luego os cuento');
  assert.equal(result.intent, 'ambiguous');
  assert.equal(result.source, 'rule_none');
});

test('versiona el flujo de reseñas sin duplicar el umbral existente', () => {
  const nodes = migration.__testing.buildNodes([
    { id: 'N5', type: 'condition/field_check', config: { right_value: 4 }, outputs: {} },
    { id: 'N8', type: 'condition/field_check', config: { right_value: 4 }, outputs: {} },
    { id: 'N6', type: 'action/process_review_followup', config: {}, outputs: {} },
    { id: 'N7', type: 'action/process_review_followup', config: {}, outputs: {} },
  ]);
  assert.equal(nodes.filter((node) => node.id === 'N8').length, 1);
  assert.equal(nodes.find((node) => node.id === 'N8').config.right_value, 4);
  assert.equal(nodes.find((node) => node.id === 'N5').outputs.on_false, 'N13');
  assert.ok(nodes.some((node) => node.id === 'N13' && node.type === 'condition/ai_analysis'));
  assert.ok(nodes.some((node) => node.id === 'N14' && node.type === 'action/process_review_response_classification'));
});

test('resolver un número erróneo exige un teléfono realmente distinto y deja trazabilidad', async () => {
  const originals = {
    findAll: db.MarketingContactOptOut.findAll,
    createEvent: db.PatientOperationalEvent.create,
    transaction: db.sequelize.transaction,
  };
  const updates = [];
  const events = [];
  try {
    db.MarketingContactOptOut.findAll = async () => [{
      id: 81,
      clinica_id: 35,
      phone_digits: '34600000000',
      update: async (payload) => updates.push(payload),
    }];
    db.PatientOperationalEvent.create = async (payload) => events.push(payload);
    db.sequelize.transaction = async (callback) => callback({ id: 'tx-test' });

    const unchanged = await marketingOptOut.resolveWhatsappNumberRestrictionAfterChange({
      patientId: 12,
      previousPhone: '+34 600 000 000',
      nextPhone: '+34600000000',
    });
    assert.equal(unchanged.resolved, 0);

    const changed = await marketingOptOut.resolveWhatsappNumberRestrictionAfterChange({
      patientId: 12,
      previousPhone: '+34 600 000 000',
      nextPhone: '+34 611 111 111',
      actorUserId: 9,
    });
    assert.equal(changed.resolved, 1);
    assert.deepEqual(updates, [{ status: 'resolved' }]);
    assert.equal(events[0].event_type, 'patient.whatsapp_number_corrected');
    assert.equal(events[0].actor_user_id, 9);
  } finally {
    db.MarketingContactOptOut.findAll = originals.findAll;
    db.PatientOperationalEvent.create = originals.createEvent;
    db.sequelize.transaction = originals.transaction;
  }
});

test('adjunta restricciones sin consultar timestamps virtuales como columnas reales', async () => {
  const originalFindAll = db.MarketingContactOptOut.findAll;
  let selectedAttributes = [];
  try {
    db.MarketingContactOptOut.findAll = async (options) => {
      selectedAttributes = options.attributes;
      return [{
        id: 44,
        clinica_id: 35,
        paciente_id: 12,
        phone_digits: '34600111222',
        scope: 'marketing',
        reason_text: 'Baja solicitada',
        source: 'whatsapp_inbound',
        opted_out_at: new Date('2026-08-09T10:00:00.000Z'),
      }];
    };

    const restrictions = await marketingOptOut.getActiveContactRestrictionsForConversations([{
      id: 91,
      clinic_id: 35,
      patient_id: 12,
      contact_id: '+34 600 111 222',
    }]);

    assert.equal(selectedAttributes.includes('createdAt'), false);
    assert.equal(restrictions.get(91).marketing_opt_out, true);
  } finally {
    db.MarketingContactOptOut.findAll = originalFindAll;
  }
});
