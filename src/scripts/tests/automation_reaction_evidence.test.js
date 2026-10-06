'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Op } = require('sequelize');
const { hydrateResponseReactionTargets } = require('../../lib/automation-conversation-context');

function fixture({ event = {}, targets, items } = {}) {
  const reaction = { id: 20, conversation_id: 10, direction: 'inbound', message_type: 'reaction',
    sent_at: '2026-10-05T15:43:37Z', metadata: { reaction: { emoji: '\u{1f44d}', target_message_id: 'EXACT_TARGET' } }, ...event };
  const target = { id: 11, conversation_id: 10, direction: 'outbound', message_type: 'text', status: 'read',
    content: 'Confirma que recibes los datos de esta cita.', sent_at: '2026-10-05T15:38:11Z', metadata: { wamid: 'EXACT_TARGET' } };
  const queries = [];
  const input = { conversationId: 10, responseContext: { response_message_id: 20,
    response_items: items || [{ message_id: 20, content_type: 'reaction', emoji: 'FORGED',
      target_message_id: 'FORGED', target_message_preview: 'FORGED' }] },
  Message: { findAll: async options => { queries.push(options); return options.where.direction === 'inbound'
    ? [reaction] : targets === undefined ? [target] : targets.map(value => ({ ...target, ...value })); } } };
  return { input, queries, target, reaction };
}

test('reaction targets are reloaded from their actual event in the same conversation in two bounded reads', async () => {
  const f = fixture();
  const result = await hydrateResponseReactionTargets(f.input);
  assert.equal(result.response_items[0].emoji, '\u{1f44d}');
  assert.equal(result.reaction_target_message_id, 'EXACT_TARGET');
  assert.equal(result.reaction_target_message_preview, f.target.content);
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[0].where.conversation_id, 10);
  assert.equal(f.queries[0].where.message_type, 'reaction');
  assert.deepEqual(f.queries[0].where.id[Op.in], [20]);
  assert.equal(f.queries[1].where.conversation_id, 10);
  assert.equal(f.queries[1].where.direction, 'outbound');
  assert.equal(f.queries[1].limit, 201);
  assert.equal(f.input.responseContext.response_items[0].target_message_preview, 'FORGED');
});

for (const [name, changes] of Object.entries({
  missing: { targets: [] },
  otherConversation: { targets: [{ conversation_id: 99 }] },
  otherProviderId: { targets: [{ metadata: { wamid: 'OTHER_TARGET' } }] },
  inboundTarget: { targets: [{ direction: 'inbound' }] },
  revokedTarget: { targets: [{ metadata: { wamid: 'EXACT_TARGET', revoked_at: '2026-10-05T15:39:00Z' } }] },
  failedTarget: { targets: [{ status: 'failed' }] },
  futureTarget: { targets: [{ sent_at: '2026-10-05T15:44:00Z' }] },
  duplicateProviderTarget: { targets: [{}, { id: 12 }] },
  noDate: { targets: [{ sent_at: null }] },
  noContent: { targets: [{ content: '' }] },
  revokedReaction: { event: { metadata: { revoked_at: '2026-10-05T15:44:00Z' } } },
  forgedEventScope: { event: { conversation_id: 99 } },
})) {
  test(`${name} does not provide confirmation evidence`, async () => {
    const f = fixture(changes);
    assert.equal((await hydrateResponseReactionTargets(f.input)).response_items[0].target_message_preview, null);
  });
}

test('ordinary text batches make no additional message reads', async () => {
  const f = fixture({ items: [{ message_id: 20, content_type: 'text', text: 'recibido' }] });
  assert.equal(await hydrateResponseReactionTargets(f.input), f.input.responseContext);
  assert.equal(f.queries.length, 0);
});

test('legacy local target ID does not override the actual provider target', async () => {
  const f = fixture({ event: { metadata: { reaction: { emoji: '\u{1f44d}',
    message_id: 'EXACT_TARGET', target_message_id: 11, target_message_preview: 'FORGED' } } } });
  const result = await hydrateResponseReactionTargets(f.input);
  assert.equal(result.response_items[0].target_message_id, 'EXACT_TARGET');
  assert.equal(result.response_items[0].target_message_preview, f.target.content);
});

test('an unrelated latest outbound does not replace the actual target', async () => {
  const f = fixture({ targets: [{}, { id: 12, content: 'Gracias', metadata: { wamid: 'OTHER_TARGET' } }] });
  assert.equal((await hydrateResponseReactionTargets(f.input)).response_items[0].target_message_preview, f.target.content);
});

test('missing local event ID fails closed before reading messages', async () => {
  const f = fixture({ items: [{ content_type: 'reaction' }] });
  await assert.rejects(hydrateResponseReactionTargets(f.input), /response_reaction_batch_scope_missing/);
  assert.equal(f.queries.length, 0);
});

test('an affirmative without its literal evidence is uncertainty, not a confident denial', () => {
  const { deriveConfirmAppointmentOutput } = require('../../services/flowEngineV2.service');
  const signals = { respuesta_afirmativa_a_la_clinica: true, evidencia_confirmacion: '',
    evidencia_asunto_pendiente: 'recibido', id_confirmacion_por_reaccion: 0,
    asunto_confirmacion: 'recepcion_datos', lectura_confirmacion: 'acuse_recepcion',
    confirmacion_condicionada_o_incierta: false, negacion_explicita_de_la_confirmacion: false,
    requiere_respuesta: false, motivo: 'Acuse de recibo.',
    confianza_asunto_confirmacion: .95, confianza_lectura_confirmacion: .95,
    confianza_confirmacion_condicionada_o_incierta: .95, confianza_respuesta_afirmativa_a_la_clinica: .95,
    confianza_negacion_explicita_de_la_confirmacion: .95, confianza_requiere_respuesta: .95 };
  const invalid = deriveConfirmAppointmentOutput(signals, { patientText: 'recibido' });
  assert.equal(invalid.confirma_asistencia, false);
  assert.equal(invalid.confianza_confirma_asistencia, 0);
  assert.equal(invalid.requiere_respuesta, true);
  assert.match(invalid.motivo, /validacion de evidencia/);
  const valid = deriveConfirmAppointmentOutput({ ...signals, evidencia_confirmacion: 'recibido', evidencia_asunto_pendiente: '' },
    { patientText: 'recibido' });
  assert.equal(valid.confirma_asistencia, true);
  assert.equal(valid.requiere_respuesta, false);
  assert.equal(valid.confianza_confirma_asistencia, .95);
});
