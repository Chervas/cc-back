'use strict';

// Execute the real flow sender functions with an in-memory routing policy.
// Importing the flow engine would also bootstrap application workers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { selectWhatsappPhoneAsset, isWhatsappRoutingConfigAvailable } = require('../../lib/whatsapp-channel-role');
const templateLocale = require('../../lib/whatsapp-template-locale');
const source = fs.readFileSync(require.resolve('../../services/flowEngineV2.service'), 'utf8');

function extract(name) {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert(start >= 0, name);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?function \w+/);
  assert(end > 0, name);
  return rest.slice(0, end);
}

function fixture({ primaryAvailable = true, secondaryAvailable = true } = {}) {
  const primary = { id: 1, phoneNumberId: 'clinic-phone', wabaId: 'clinic-waba', waAccessToken: 'synthetic' };
  const secondary = { id: 2, phoneNumberId: 'group-phone', wabaId: 'group-waba', waAccessToken: secondaryAvailable ? 'synthetic' : null,
    routing_binding_id: 20, routing_binding_role: 'secondary', additionalData: { routing: {
      role: 'secondary', purposes: ['lead_first_contact', 'review_requests', 'bulk_campaigns'], unavailable_action: 'pause',
    } } };
  const policies = [];
  const sandbox = {
    ...templateLocale,
    cleanString: value => String(value || '').trim(),
    toLowerSafe: value => String(value || '').trim().toLowerCase(),
    toIntOrNull: value => Number(value) || null,
    resolveTemplateValue: value => value,
    isWhatsappRoutingConfigAvailable,
    resolveSpecificSenderConfig: async ({ senderOriginId }) => ({ originId: senderOriginId, phoneNumberId: 'specific-phone', accessToken: 'synthetic' }),
    patientDirectionService: { resolveOutboundPolicy: async options => {
      policies.push(options);
      const asset = selectWhatsappPhoneAsset({ clinicAssets: primaryAvailable ? [primary] : [], groupAssets: [secondary], purpose: options.purpose });
      return { mode: 'clinic_default', clinicConfig: asset ? {
        originId: asset.id, clinicId: options.clinicId, phoneNumberId: asset.phoneNumberId,
        wabaId: asset.wabaId, accessToken: asset.waAccessToken, routingUnavailable: asset.routing_unavailable,
      } : null };
    } },
  };
  vm.createContext(sandbox);
  for (const name of ['resolveWhatsappRoutingPurpose', 'resolveWhatsAppSenderConfig',
    'normalizeWhatsappTemplateComponents', 'extractWhatsappTemplateBodyText', 'normalizeTemplateBodyForComparison',
    'getWhatsappTemplateCatalogBodyText', 'matchesCurrentCatalogBody', 'isTemplateBlockedForSend',
    'getWhatsappTemplateWabaId', 'scoreWhatsappTemplateCandidate', 'selectBestWhatsappTemplateCandidate']) {
    vm.runInContext(extract(name), sandbox);
  }
  return { policies, selectTemplate: sandbox.selectBestWhatsappTemplateCandidate,
    send: (context = {}, config = {}) => sandbox.resolveWhatsAppSenderConfig({ config, context, clinicId: 10 }) };
}

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
  const { send, selectTemplate } = fixture();
  const { clinic_config: sender } = await send({ appointment: { id_cita: 100 }, lead: { id: 200 } }, { template_usage: 'cita_sin_confirmar_noche' });
  const template = { id: 50, clinic_id: null, waba_id: 'clinic-waba', catalog_template_id: 5,
    name: 'appointment_notice_v1', language: 'es', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: 'Tu cita es mañana a las {{1}}.' }],
    catalog: { name: 'appointment_notice', locale: 'es', body_text: 'Tu cita es mañana a las {{1}}.' } };
  const local = { ...template, clinic_id: 10, waba_id: null };
  const options = { clinicId: 10, expectedLocale: 'es', requireCurrentCatalogBody: true };
  assert.equal(selectTemplate([local, template], { ...options, targetWabaId: sender.wabaId }), template);
  assert.equal(selectTemplate([local, template], { ...options, targetWabaId: 'group-waba' }), null);
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
