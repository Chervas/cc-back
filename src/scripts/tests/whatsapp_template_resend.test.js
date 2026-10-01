'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { canResendFailedTemplate, retryMetadata } = require('../../lib/whatsapp-template-resend');
const failed = () => ({ id: 10, direction: 'outbound', message_type: 'template', status: 'failed', metadata: {
  template_id: 7, template_name: 'clinicaclick_confirmacion_datos_cita_48_v13', template_language: 'es',
  template_params: { 1: 'Fictitious patient', 2: 'Fictitious date' }, template_components: [{ type: 'body', parameters: [] }],
  wabaId: '101', phoneNumberId: '201', execution_id: 11, communication_scope: 'care',
  wamid: 'FICTITIOUS_WAMID', wa_response: { messages: [{ id: 'FICTITIOUS_WAMID' }] },
  wa_status: { status: 'failed', errors: [{ code: 131042 }] }, error_code: 131042, delivery_failed: true,
} });
test('Only an outbound template with a definite provider rejection offers a new attempt', () => {
  assert.equal(canResendFailedTemplate(failed()), true);
  for (const change of [m => m.status = 'pending', m => m.status = 'sent', m => m.status = 'read', m => m.direction = 'inbound',
    m => m.message_type = 'text', m => m.metadata.delivery_unknown = true, m => m.metadata.outcome_unknown = true,
    m => m.metadata.outbound_retry = { reason: 'delivery_unknown' }, m => m.metadata.manual_retry_message_id = 20,
    m => m.metadata.post_acceptance_error = 'local_error', m => m.metadata.wa_status_timestamps = { delivered: 100 },
    m => m.metadata.wa_status_history = [{ status: 'read' }], m => delete m.metadata.wa_status,
    m => m.metadata.wa_status.errors = [], m => delete m.metadata.template_language]) {
    const m = failed(); change(m); assert.equal(canResendFailedTemplate(m), false);
  }
});
test('A new attempt retains exact template variables, sender, clinical context and security holds, not acceptance/history', () => {
  const original = failed(); original.metadata.hold = true; original.metadata.fresh_delivery_reconciled_status = 'failed';
  const retry = retryMetadata(original, 99, new Date('2026-10-01T10:00:00Z'));
  for (const field of ['template_id', 'template_name', 'template_language', 'template_params', 'template_components', 'wabaId', 'phoneNumberId', 'execution_id', 'communication_scope', 'hold']) {
    assert.deepEqual(retry[field], original.metadata[field]);
  }
  for (const field of ['wamid', 'wa_response', 'wa_status', 'error_code', 'delivery_failed', 'fresh_delivery_reconciled_status']) assert.equal(retry[field], undefined);
  assert.equal(retry.manual_retry_of_message_id, 10); assert.equal(retry.manual_retry_requested_by, 99);
  assert.equal(original.metadata.wamid, 'FICTITIOUS_WAMID');
});

test('The real preflight checks the original rejection and age, current sender, template, contact, opt-out and appointment', async () => {
  const Module = require('node:module'); const load = Module._load;
  const { assertReady } = require('../../services/whatsappTemplateResend.service');
  const original = failed(); original.createdAt = new Date('2026-10-01T10:00:00Z'); original.conversation_id = 1; original.toJSON = () => ({ ...original });
  const conversation = { id: 1, clinic_id: 66, patient_id: 1, contact_id: '+34000000000' };
  const message = { id: 20, createdAt: original.createdAt, direction: 'outbound', status: 'pending', metadata: { ...retryMetadata(original, 99, new Date()), recipient: '+34000000000' } };
  const sender = { wabaId: '101', phoneNumberId: '201', authorizedBroker: { sendEnabled: true, messageNotBefore: '2026-10-01T09:00:00Z' } };
  const { assertMessageEligibility: realEligibility } = require('../../lib/whatsappAuthorizedBrokerClient');
  const template = { name: original.metadata.template_name, language: 'es', waba_id: '101', status: 'APPROVED', is_active: true };
  const patient = { telefono_movil: '+34000000000' }; let blocked = false, confirmed = false; const checks = [];
  const fakeDb = { Message: { findByPk: async () => original }, WhatsappTemplate: { findByPk: async () => template },
    Paciente: { findByPk: async () => patient }, FlowExecutionV2: { findByPk: async () => ({ trigger_entity_type: 'appointment', trigger_entity_id: 1 }) },
    CitaPaciente: { findByPk: async () => ({ estado: confirmed ? 'info_confirmada' : 'pendiente' }) } };
  const modules = {
    '../../models': fakeDb,
    '../lib/whatsappAuthorizedBrokerClient': { assertMessageEligible: m => { realEligibility(m, '2026-10-01T09:00:00Z'); checks.push(['age', m.id]); }, assertMessageEligibility: (m, cutoff) => { realEligibility(m, cutoff); checks.push(['binding', m.id]); } },
    './flowEngineV2.service': { resolveScheduledWhatsappSenderConfig: async () => sender },
    './whatsappAccountHealth.service': { assertCanSend: async () => { if (blocked) throw Object.assign(Error('health'), { code: 'WHATSAPP_SENDER_HEALTH_BLOCKED' }); checks.push('health'); } },
    './securityMonitoring.service': { assertTemplateAllowed: async () => checks.push('security') },
    './whatsapp.service': { normalizePhoneNumber: v => v },
    './marketingOptOut.service': { assertAutomationCommunicationAllowed: async () => checks.push('opt-out') },
    '../lib/whatsappAppointmentEligibility': { assertAutomatedMessageEligibility: async () => checks.push('appointment'), patientImportHeld: () => false },
  };
  Module._load = function(id, parent, main) {
    if (parent.filename.endsWith('/whatsappTemplateResend.service.js') && Object.hasOwn(modules, id)) return modules[id];
    return load.call(this, id, parent, main);
  };
  try {
    await assertReady({ message, conversation });
    assert(checks.some(c => c[0] === 'age' && c[1] === original.id));
    assert(checks.some(c => c[0] === 'binding' && c[1] === original.id));
    assert(checks.includes('health') && checks.includes('security') && checks.includes('opt-out') && checks.includes('appointment'));
    for (const [mutate, undo, code] of [
      [() => original.status = 'delivered', () => original.status = 'failed', 'whatsapp_template_retry_not_safe'],
      [() => sender.authorizedBroker.sendEnabled = false, () => sender.authorizedBroker.sendEnabled = true, 'whatsapp_authorized_send_paused'],
      [() => sender.phoneNumberId = '202', () => sender.phoneNumberId = '201', 'whatsapp_sender_snapshot_scope_mismatch'],
      [() => template.status = 'PENDING', () => template.status = 'APPROVED', 'whatsapp_template_not_available'],
      [() => blocked = true, () => blocked = false, 'WHATSAPP_SENDER_HEALTH_BLOCKED'],
      [() => patient.telefono_movil = '+34000000001', () => patient.telefono_movil = '+34000000000', 'whatsapp_contact_identity_conflict'],
      [() => confirmed = true, () => confirmed = false, 'whatsapp_appointment_already_confirmed'],
      [() => original.createdAt = new Date('2026-10-01T08:00:00Z'), () => original.createdAt = message.createdAt, 'whatsapp_authorized_message_ineligible'],
      [() => original.metadata.hold = true, () => delete original.metadata.hold, 'whatsapp_authorized_message_ineligible'],
    ]) { mutate(); await assert.rejects(assertReady({ message, conversation }), { code }); undo(); }
  } finally { Module._load = load; }
  const worker = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../workers/queue.workers.js'), 'utf8');
  assert.match(worker, /messageMetadata\.manual_retry_of_message_id[\s\S]*whatsappTemplateResend\.service[\s\S]*assertReady/);
});
