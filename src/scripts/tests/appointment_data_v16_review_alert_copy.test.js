'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260905083000-refine-appointment-data-review-alerts-v16');

const oldTitle = 'Confirmación inconclusa';
const oldMessage = 'El paciente {{paciente.nombre}} no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.';
const nodes = migration._test.REVIEW_NODE_IDS.map((id) => ({
  id,
  type: 'action/send_system_notification',
  config: {
    title: oldTitle,
    message: oldMessage,
    display_mode: 'persistent_alert',
  },
}));

const updated = migration._test.applyReviewAlertCopy(nodes);
for (const node of updated) {
  assert.equal(node.config.title, '{{paciente.nombre}} necesita respuesta');
  assert.equal(node.config.message, migration._test.NEW_MESSAGE);
}
assert.equal(nodes[0].config.title, oldTitle, 'the helper must not mutate its input');

assert.deepEqual(
  migration._test.renderExistingAlert(
    oldTitle,
    'El paciente Carlos no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.',
  ),
  {
    title: 'Carlos necesita respuesta',
    message: migration._test.NEW_MESSAGE,
  },
);
assert.equal(migration._test.renderExistingAlert('Otro aviso', 'Otro mensaje'), null);

console.log('appointment_data_v16_review_alert_copy.test.js OK');
