'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { precedingConversationMessages } = require('../../lib/automation-conversation-context');
const { buildCanonicalSameDayFlow, CANONICAL_PILOT_PUBLIC_ID, DELIVERY_NODE_IDS } = require('../../lib/same-day-canonical-flow');

function fixture() {
  const source = { clinic_id: null, group_id: null, entry_node_id: 'N1', trigger_type: 'appointment_reminder_window',
    trigger_config: { custom_time: '08:00', exclude_if_not_confirmed: true },
    nodes: DELIVERY_NODE_IDS.map((id) => ({ id, type: id === 'N2' || id === 'N7' ? 'action/send_whatsapp' : 'control/join',
      config: { template_id: 'system-current', language_routing: { ca: 'current' } }, outputs: {} })) };
  const pilot = { ...structuredClone(source), clinic_id: 66, public_id: CANONICAL_PILOT_PUBLIC_ID, version: 10 };
  pilot.nodes.forEach((node) => { node.config.template_id = 'pilot-old'; });
  pilot.nodes.push({ id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent' }, outputs: { on_success: 'N10' } },
    { id: 'N10', type: 'condition/field_check', config: { mode: 'multi_branch', branch_rules: Array.from({ length: 6 }, (_, i) => ({ id: 'branch_'+i })) } });
  return { source, pilot };
}

test('BS Capilar provides the comparator and actions; System retains current templates and trigger', () => {
  const { source, pilot } = fixture();
  const before = JSON.stringify({ source, pilot });
  const result = buildCanonicalSameDayFlow(source, pilot);
  assert.equal(JSON.stringify({ source, pilot }), before);
  for (const id of DELIVERY_NODE_IDS) assert.deepEqual(result.nodes.find((node) => node.id === id), source.nodes.find((node) => node.id === id));
  assert.deepEqual(result.nodes.find((node) => node.id === 'N10'), pilot.nodes.find((node) => node.id === 'N10'));
  assert.deepEqual(result.trigger_config, source.trigger_config);
  assert.equal(result.nodes.length, pilot.nodes.length);
});

test('wrong clinic, version or damaged comparator cannot become System', () => {
  for (const changes of [{ clinic_id: 35 }, { version: 9 }, { public_id: 'wrong' }]) {
    const { source, pilot } = fixture();
    assert.throws(() => buildCanonicalSameDayFlow(source, { ...pilot, ...changes }), /scope_mismatch/);
  }
  const { source, pilot } = fixture();
  pilot.nodes.find((node) => node.id === 'N10').config.mode = 'simple';
  assert.throws(() => buildCanonicalSameDayFlow(source, pilot), /comparator_invalid/);
});

test('context stops before the first buffered message, excludes the reference and respects budgets', () => {
  const context = { last_response_context: { response_message_id: 5, response_items: [{ message_id: 4 }],
    responded_at: '2026-10-02T08:00Z', listened_message_preview: 'Reference' },
    conversation_context_messages: [
      { id: 1, direction: 'outbound', sent_at: '2026-10-02T07:00Z', text: 'Earlier' },
      { id: 2, direction: 'outbound', sent_at: '2026-10-02T07:01Z', text: 'Reference' },
      { id: 3, direction: 'inbound', sent_at: '2026-10-02T07:02Z', text: 'Previous' },
      { id: 4, direction: 'inbound', sent_at: '2026-10-02T07:59Z', text: 'First batch item' },
      { id: 5, direction: 'inbound', sent_at: '2026-10-02T08:00Z', text: 'Last batch item' },
    ] };
  assert.deepEqual(precedingConversationMessages(context).map((message) => message.text), ['Earlier', 'Previous']);
  assert.equal(precedingConversationMessages(context, { maxMessages: 1 }).length, 1);
  assert.deepEqual(precedingConversationMessages(context, { maxChars: 5 }), []);
});
