'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { adapt, pendingReason, FAMILY_KEY, NODE_ID, FLAG } = require('../../lib/day-before-acknowledgement-review');
const { planEntry, hash, preservedNodes, publishEntry } = require('../../lib/day-before-acknowledgement-publication');
const fixture = () => ({ id: 101, version: 1, published_at: '2030-01-01', clinic_id: 31, group_id: null,
  public_id: 'flw_fictitious', template_key: FAMILY_KEY + '__clinic_31', trigger_type: 'appointment_reminder_window',
  name: 'Fictitious reminder', is_active: true, is_system: false, description: null, entry_node_id: 'N3', trigger_config: {},
  nodes: [
    { id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent', instruction: 'UNCHANGED' }, outputs: { on_success: 'N16' } },
    { id: 'N16', type: 'condition/field_check', config: { mode: 'multi_branch', branch_rules: [{ id: 'branch_ack', label: 'Acknowledgement' }] }, outputs: { branch_ack: null, on_else: 'N33', branch_confirm: 'N13' } },
    { id: 'N33', type: 'action/send_system_notification', config: { title: 'Reception', message: 'Review', display_mode: 'persistent_alert', assignee_type: 'user', assignee_id: 1 }, outputs: { on_success: null } },
    { id: 'N13', type: 'action/change_status', config: { status: 'recordatorio_confirmado' }, outputs: {} },
  ] });
const inputs = () => ({ appointment: { id_cita: 901, clinica_id: 31, paciente_id: 41, inicio: '2030-01-02T12:00:00Z', estado: 'recordatorio_enviado' },
  context: { appointment: { id_cita: 901, paciente_id: 41, inicio: '2030-01-02T12:00:00Z' }, last_response_context: { response_message_id: 101 } },
  execution: { id: 501, clinic_id: 31 }, state: { execution_id: 501, appointment_id: 901, clinic_id: 31, source_message_id: 101, status: 'active' },
  now: new Date('2030-01-01T12:00:00Z') });

test('only the acknowledgment edge and its label change; existing nodes, prompts and switches stay intact', () => {
  const source = fixture(), before = structuredClone(source), nodes = adapt(source);
  assert.deepEqual(source, before);
  for (const node of source.nodes.filter(n => n.id !== 'N16')) assert.deepEqual(nodes.find(n => n.id === node.id), node);
  assert.equal(nodes.length, source.nodes.length + 1);
  assert.equal(nodes.find(n => n.id === 'N16').outputs.branch_ack, NODE_ID);
  const notice = nodes.find(n => n.id === NODE_ID);
  assert.equal(notice.type, 'action/send_system_notification'); assert.equal(notice.config[FLAG], true);
  assert.equal(notice.config.display_mode, 'persistent_alert');
  assert.deepEqual(adapt({ ...source, nodes }), nodes);
  const entry = planEntry(source);
  assert.equal(entry.body.is_active, false);
  assert.deepEqual(preservedNodes(source, entry.body), nodes);
  assert.throws(() => preservedNodes(source, { ...entry.body, nodes: [...nodes, { id: 'extra' }] }), /candidate_changed/);
  assert.throws(() => adapt({ ...source, template_key: 'recordatorio_mismo_d_a_sabes_llegar' }), /out_of_scope/);
  assert.throws(() => adapt({ ...source, nodes: source.nodes.map(n => n.id === 'N16' ? { ...n, outputs: { branch_ack: 'custom' } } : n) }), /requires_review/);
});

test('fresh state rejects confirmed, cancelled, past, attended, rescheduled, foreign or manually resolved appointments', () => {
  const original = inputs(); assert.equal(pendingReason(original), null);
  for (const estado of ['pendiente', 'info_confirmada', 'recordatorio_confirmado', 'cancelada', 'no_acude', 'ha_acudido', 'en_atencion', 'completada', 'cambio_solicitado']) {
    assert.equal(pendingReason({ ...original, appointment: { ...original.appointment, estado } }), 'appointment_no_longer_pending');
  }
  for (const patch of [{ inicio: '2030-01-03T12:00:00Z' }, { clinica_id: 32 }, { paciente_id: 42 },
    { arrived_at: new Date() }, { care_started_at: new Date() }, { care_completed_at: new Date() }]) {
    assert.ok(pendingReason({ ...original, appointment: { ...original.appointment, ...patch } }));
  }
  for (const patch of [{ status: 'completed' }, { execution_id: 502 }, { clinic_id: 32 }, { appointment_id: 902 }, { source_message_id: 102 }]) {
    assert.ok(pendingReason({ ...original, state: { ...original.state, ...patch } }));
  }
  assert.ok(pendingReason({ ...original, appointment: null }));
  assert.ok(pendingReason({ ...original, state: null }));
  assert.ok(pendingReason({ ...original, now: new Date('2030-01-02T12:00:00Z') }));
});

test('waiting executions adopt only a published patch of their own family, with all original timers and inference', () => {
  const { runtimeNodes } = require('../../lib/day-before-acknowledgement-review');
  const old = fixture(), latest = { ...old, version: 2, nodes: adapt(old) };
  assert.deepEqual(runtimeNodes(old, old, old.nodes), old.nodes);
  assert.deepEqual(runtimeNodes(old, { ...latest, clinic_id: 32 }, old.nodes), old.nodes);
  assert.deepEqual(runtimeNodes(old, { ...latest, public_id: 'other' }, old.nodes), old.nodes);
  assert.deepEqual(runtimeNodes(old, latest, old.nodes), latest.nodes);
});

test('native publication is idempotent, preserves activation and never schedules historical events', async () => {
  const source = fixture(), entry = planEntry(source), calls = [];
  const candidate = { ...source, ...entry.body, id: 102, version: 2, published_at: null };
  let published;
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { data: published ? [published, source] : [source], pagination: { total: published ? 2 : 1 } };
    if (url.endsWith('/publish')) { assert.equal(body.acknowledgement_review_source_id, source.id);
      return { data: published = { ...candidate, published_at: '2030-01-02', is_active: source.is_active } }; }
    return { data: candidate };
  };
  assert.equal((await publishEntry(entry, request)).skipped, false);
  assert.equal((await publishEntry(entry, request)).skipped, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 2);
  assert.equal(published.is_active, true);
  await assert.rejects(publishEntry(entry, async () => ({ data: [{ ...source, version: 5 }] })), /source_changed/);
});

if (process.env.ACK_REVIEW_SOURCES) test('current published clinic graphs retain every other branch and pass the real router', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const rows = JSON.parse(fs.readFileSync(process.env.ACK_REVIEW_SOURCES));
  let checked = 0;
  for (const source of rows) {
    if (!require('../../lib/day-before-acknowledgement-review').inScope(source)) continue;
    const nodes = adapt(source), router = nodes.find(n => n.id === 'N16'), ai = source.nodes.find(n => n.id === 'N3');
    assert.deepEqual(nodes.find(n => n.id === 'N3'), ai);
    const base = { intencion_secundaria: 'ninguna', confianza_intencion_principal: .96, confianza_necesita_respuesta: .96 };
    for (const [intent, needs, target] of [['agradecimiento', false, NODE_ID], ['confirmar_cita', false, 'N13'],
      ['confirmar_cita', true, 'N17'], ['pregunta', true, 'N33'], ['cancelar_cita', false, 'N20'], ['solicitar_cambio_cita', true, 'N30']]) {
      const result = await engine._processNode(router, { outputs: { N3: { ...base, intencion_principal: intent, necesita_respuesta: needs } } }, { simulation: true });
      assert.equal(result.next_node_id, target, 'clinic ' + source.clinic_id + ': ' + intent);
    }
    for (const node of source.nodes.filter(n => n.id !== 'N16')) assert.equal(hash(nodes.find(n => n.id === node.id)), hash(node));
    checked++;
  }
  assert.ok(checked >= 30);
});
