'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractParameters, rewrite } = require('../qa/historical-appointment-copy-context');

test('historical reply fixtures get the new outgoing text consistently, without changing the patient reply', () => {
  const old = 'Hola {{1}}. Cita a las {{2}}.', next = 'Hola, {{1}}. Tu cita es a las {{2}}.';
  const text = 'Hola TESTONLY. Cita a las 10:30.';
  assert.deepEqual(extractParameters(old, text), { 1: 'TESTONLY', 2: '10:30' });
  assert.equal(extractParameters(old, 'different'), null);
  const source = { clinic_id: 1, messages: [{ direction: 'outbound', message_type: 'template', content: text }],
    context: { last_prompt: text, last_response: 'TESTONLY sí', conversation_today: text + '\nTESTONLY sí',
      last_response_context: { listened_message_preview: text, response_text: 'TESTONLY sí' } } };
  const result = rewrite(source, { catalogPlan: [{ source: { body_text: old }, next: { body_text: next } }] });
  assert.equal(result.changed, 1);
  assert.equal(result.item.context.last_prompt, result.item.messages[0].content);
  assert.equal(result.item.context.last_response_context.listened_message_preview, result.item.messages[0].content);
  assert.equal(result.item.context.last_response, 'TESTONLY sí');
  assert.equal(source.context.last_prompt, text);
});
