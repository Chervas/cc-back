'use strict';

// Execute the real flow sender functions with an in-memory routing policy.
// Importing the flow engine would also bootstrap application workers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { selectWhatsappPhoneAsset, isWhatsappRoutingConfigAvailable } = require('../../lib/whatsapp-channel-role');
const { evaluateWhatsappServiceWindow } = require('../../services/whatsappServiceWindow.service');
const templateLocale = require('../../lib/whatsapp-template-locale');
const source = fs.readFileSync(require.resolve('../../services/flowEngineV2.service'), 'utf8');
const whatsappSource = fs.readFileSync(require.resolve('../../services/whatsapp.service'), 'utf8');
const clinicConfigMethod = whatsappSource.match(/^    async getClinicConfig\([\s\S]*?^    }/m)?.[0];
assert(clinicConfigMethod);

function extract(name) {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert(start >= 0, name);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?function \w+/);
  assert(end > 0, name);
  return rest.slice(0, end);
}

function fixture({ primaryAvailable = true, secondaryAvailable = true, directorActive = false } = {}) {
  const primary = { id: 1, phoneNumberId: 'clinic-phone', wabaId: 'clinic-waba', waAccessToken: 'synthetic' };
  const secondary = { id: 2, phoneNumberId: 'group-phone', wabaId: 'group-waba', waAccessToken: secondaryAvailable ? 'synthetic' : null,
    routing_binding_id: 20, routing_binding_role: 'secondary', additionalData: { routing: {
      role: 'secondary', purposes: ['lead_first_contact', 'review_requests', 'bulk_campaigns'], unavailable_action: 'pause',
    } } };
  const policies = [];
  const clinicRequests = [];
  const whatsappService = vm.runInNewContext(`({ ${clinicConfigMethod} })`);
  whatsappService.resolvePhoneAssetByClinic = async (clinicId, options) => {
    clinicRequests.push({ clinicId, purpose: options?.purpose });
    return selectWhatsappPhoneAsset({ clinicAssets: primaryAvailable ? [primary] : [], groupAssets: [secondary], purpose: options?.purpose });
  };
  whatsappService.resolveWabaAssetByClinic = async () => ({
    id: 9, phoneNumberId: 'legacy-waba-phone', waAccessToken: 'synthetic',
  });
  const sandbox = {
    ...templateLocale,
    cleanString: value => String(value || '').trim(),
    toLowerSafe: value => String(value || '').trim().toLowerCase(),
    toIntOrNull: value => Number(value) || null,
    resolveTemplateValue: value => value,
    isWhatsappRoutingConfigAvailable,
    whatsappService,
    require: name => {
      assert.equal(name, '../lib/appointment-single-notice-flow');
      return require('../../lib/appointment-single-notice-flow');
    },
    resolveSpecificSenderConfig: async ({ senderOriginId }) => ({ originId: senderOriginId, phoneNumberId: 'specific-phone', accessToken: 'synthetic' }),
    patientDirectionService: { resolveOutboundPolicy: async options => {
      policies.push(options);
      if (directorActive) return {
        mode: 'patient_director',
        clinicConfig: { originId: 4, phoneNumberId: 'director-phone', wabaId: 'director-waba', accessToken: 'synthetic' },
        metadata: { patient_direction_assignment_id: 17 },
      };
      const asset = selectWhatsappPhoneAsset({ clinicAssets: primaryAvailable ? [primary] : [], groupAssets: [secondary], purpose: options.purpose });
      return { mode: 'clinic_default', clinicConfig: asset ? {
        originId: asset.id, clinicId: options.clinicId, phoneNumberId: asset.phoneNumberId,
        wabaId: asset.wabaId, accessToken: asset.waAccessToken, routingUnavailable: asset.routing_unavailable,
      } : null };
    } },
  };
  vm.createContext(sandbox);
  for (const name of ['resolveAutomationCommunicationScope', 'resolveWhatsappRoutingPurpose',
    'usesPrimaryForAppointmentConfirmation', 'resolveWhatsAppSenderConfig',
    'normalizeWhatsappTemplateComponents', 'extractWhatsappTemplateBodyText', 'normalizeTemplateBodyForComparison',
    'getWhatsappTemplateCatalogBodyText', 'matchesCurrentCatalogBody', 'isTemplateBlockedForSend',
    'getWhatsappTemplateWabaId', 'scoreWhatsappTemplateCandidate', 'selectBestWhatsappTemplateCandidate']) {
    vm.runInContext(extract(name), sandbox);
  }
  return { policies, clinicRequests, selectTemplate: sandbox.selectBestWhatsappTemplateCandidate,
    send: (context = {}, config = {}, extra = {}) => sandbox.resolveWhatsAppSenderConfig({ config, context, clinicId: 10, ...extra }) };
}

test('appointment confirmation and automated replies use the primary with an active Director assignment', async () => {
  const { send, policies, clinicRequests } = fixture({ directorActive: true });
  const context = { appointment: { id: 100 }, lead: { id: 200 } };
  const executions = [
    { trigger_type: 'appointment_created' },
    { trigger_type: 'appointment_rescheduled' },
    { trigger_type: 'appointment_reminder_window', templateVersion: {
      trigger_type: 'appointment_reminder_window', template_key: 'recordatorio_y_confirmacion_bed4b6__clinic_10',
    } },
  ];
  for (const execution of executions) {
    const result = await send(context, { message_mode: 'manual' }, { execution });
    assert.equal(result.clinic_config.phoneNumberId, 'clinic-phone');
    assert.equal(result.patient_direction, undefined);
    const reply = evaluateWhatsappServiceWindow({
      activePhoneNumberId: result.clinic_config.phoneNumberId,
      now: new Date('2026-11-26T10:00:00Z'),
      messages: [{
        direction: 'inbound',
        sent_at: '2026-11-26T09:59:00Z',
        metadata: { phoneNumberId: 'clinic-phone' },
      }],
    });
    assert.equal(reply.open, true);
    assert.equal(reply.matchedBy, 'message_phone_number_id');
  }
  assert.equal(policies.length, 0);
  assert.equal(clinicRequests.length, 3);
});

test('a localized confirmation family takes precedence over an explicit sender override', async () => {
  const { send, policies } = fixture({ directorActive: true });
  const result = await send({}, { sender_mode: 'specific_origin', sender_origin_id: 2 }, {
    contentConfig: { catalog_family_key: 'clinicaclick_confirmacion_datos_cita_reprogramada_24' },
  });
  assert.equal(result.sender_origin_id, 1);
  assert.equal(result.clinic_config.wabaId, 'clinic-waba');
  assert.equal(policies.length, 0);
});

test('a confirmation without an available primary fails without using the Director, secondary or WABA fallback', async () => {
  const { send, policies } = fixture({ primaryAvailable: false, directorActive: true });
  await assert.rejects(
    send({ lead: { id: 200 } }, { template_name: 'clinicaclick_confirmacion_datos_cita_hoy_v7' }),
    /whatsapp_appointment_primary_unavailable/
  );
  assert.equal(policies.length, 0);
});

test('the routing of other appointments can still use the assigned Director', async () => {
  const { send } = fixture({ directorActive: true });
  const result = await send({ appointment: { id: 100 }, lead: { id: 200 } }, {
    template_name: 'clinicaclick_recordatorio_mismo_dia_primera_visita',
  }, { execution: { trigger_type: 'appointment_reminder_window' } });
  assert.equal(result.clinic_config.phoneNumberId, 'director-phone');
  assert.equal(result.patient_direction.patient_direction_assignment_id, 17);
});

for (const [label, context] of Object.entries({
  appointment: { appointment: { id_cita: 100 }, lead: { id: 200 } },
  normalized_appointment: { appointment: { id: 100 }, lead_id: 200 },
  cita: { cita: { id_cita: 100 }, runtime: { lead_id: 200 } },
  trigger: { trigger: { data: { appointment_id: 100, lead_id: 200 } } },
  without_lead: { appointment: { id_cita: 100 } },
})) {
  test(`appointment reminders use the care sender (${label})`, async () => {
    const { send, policies } = fixture();
    const result = await send(context, { template_usage: 'cita_sin_confirmar_noche' });
    assert.equal(policies[0].purpose, 'appointment_automation');
    assert.equal(result.clinic_config.originId, 1);
  });
}

test('an appointment originating from a lead can use its approved template before secondary provisioning', async () => {
  const { send, selectTemplate } = fixture({ directorActive: true, secondaryAvailable: false });
  const { clinic_config: sender } = await send({ appointment: { id_cita: 100 }, lead: { id: 200 } }, {
    template_name: 'clinicaclick_confirmacion_datos_cita_hoy_v7',
  });
  const template = { id: 50, clinic_id: null, waba_id: 'clinic-waba', catalog_template_id: 5,
    name: 'appointment_notice_v1', language: 'es', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: 'Tu cita es mañana a las {{1}}.' }],
    catalog: { name: 'appointment_notice', locale: 'es', body_text: 'Tu cita es mañana a las {{1}}.' } };
  const local = { ...template, clinic_id: 10, waba_id: null };
  const options = { clinicId: 10, expectedLocale: 'es', requireCurrentCatalogBody: true };
  assert.equal(selectTemplate([local, template], { ...options, targetWabaId: sender.wabaId }), template);
  assert.equal(selectTemplate([local, template], { ...options, targetWabaId: 'group-waba' }), null);
});

test('an appointment keeps its approved sender template while revised copy awaits approval', () => {
  const { selectTemplate } = fixture();
  const catalog = { name: 'appointment_notice', locale: 'es', body_text: 'New copy {{1}}.' };
  const approved = { id: 50, clinic_id: null, waba_id: 'clinic-waba', language: 'es',
    status: 'APPROVED', components: [{ type: 'BODY', text: 'Previous copy {{1}}.' }], catalog };
  const pending = { ...approved, id: 60, status: 'PENDING', components: [{ type: 'BODY', text: catalog.body_text }] };
  const options = { clinicId: 10, targetWabaId: 'clinic-waba', expectedLocale: 'es' };
  assert.equal(selectTemplate([pending, approved], options), approved);
  assert.equal(selectTemplate([pending, approved], { ...options, targetWabaId: 'another-waba' }), null);
});

test('an appointment adopts newly approved copy without bypassing emitter or strict catalog checks', () => {
  const { selectTemplate } = fixture();
  const catalog = { name: 'appointment_notice', locale: 'es', body_text: 'New copy {{1}}.' };
  const previous = { id: 50, clinic_id: null, waba_id: 'clinic-waba', language: 'es',
    status: 'APPROVED', components: [{ type: 'BODY', text: 'Previous copy {{1}}.' }], catalog };
  const current = { ...previous, id: 60, components: [{ type: 'BODY', text: catalog.body_text }] };
  const foreign = { ...current, id: 100, waba_id: 'another-waba' };
  const options = { clinicId: 10, targetWabaId: 'clinic-waba', expectedLocale: 'es' };
  assert.equal(selectTemplate([previous, foreign, current], options), current);
  assert.equal(selectTemplate([previous], { ...options, requireCurrentCatalogBody: true }), null);
  assert.equal(selectTemplate([previous, current], { ...options, requireCurrentCatalogBody: true }), current);
});

test('a failed secondary cannot block an appointment reminder', async () => {
  const { send } = fixture({ secondaryAvailable: false });
  assert.equal((await send({ appointment: { id_cita: 100 }, lead: { id: 200 } })).clinic_config.originId, 1);
});

test('a missing care sender does not redirect appointments to a marketing secondary', async () => {
  const { send } = fixture({ primaryAvailable: false });
  await assert.rejects(send({ appointment: { id_cita: 100 }, lead: { id: 200 } }), /whatsapp_config_missing/);
});

for (const [label, context, config, purpose, origin] of [
  ['lead first contact', { lead: { id: 200 } }, {}, 'lead_first_contact', 2],
  ['explicit lead template', {}, { template_usage: 'lead_primera_visita' }, 'lead_first_contact', 2],
  ['appointment takes precedence over a lead template', { appointment: { id: 100 }, lead: { id: 200 } }, { template_usage: 'lead_auto_reply' }, 'appointment_automation', 1],
  ['review after an appointment', { appointment: { id: 100 }, lead: { id: 200 } }, { template_usage: 'solicitud_resena' }, 'review_requests', 2],
  ['consent', { appointment: { id: 100 }, lead: { id: 200 } }, { domain: 'consent' }, 'consent', 1],
  ['generic automation', {}, {}, 'automation', 1],
]) {
  test(`preserves routing for ${label}`, async () => {
    const { send, policies } = fixture();
    assert.equal((await send(context, config)).clinic_config.originId, origin);
    assert.equal(policies[0].purpose, purpose);
  });
}

test('an explicit authorized sender retains precedence over the clinic routing policy', async () => {
  const { send, policies } = fixture();
  const result = await send({ appointment: { id: 100 }, lead: { id: 200 } }, { sender_mode: 'specific_origin', sender_origin_id: 3 });
  assert.equal(result.sender_origin_id, 3);
  assert.equal(policies.length, 0);
});
