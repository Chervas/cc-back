'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../../../models');
const { queues } = require('../../services/queue.service');
const accessPolicy = require('../../lib/access-policy');
const intakeController = require('../../controllers/intake.controller');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/intake.controller.js'),
  'utf8',
);
const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
const attachmentSource = fs.readFileSync(
  path.resolve(__dirname, '../../services/patientClinicalAttachments.service.js'),
  'utf8',
);
const {
  buildLeadSearchConditions,
  isLeadClosedForPendingSignals,
  redactLeadForPrivacy,
} = intakeController.__leadPrivacyContract;

assert.equal(accessPolicy.defaultForFeature('leads.sensitive.view', 'agencia'), false);
assert.equal(accessPolicy.defaultForFeature('leads.manage', 'agencia'), false);
assert.equal(accessPolicy.defaultForFeature('quickchat.read_leads', 'agencia'), false);
assert.equal(accessPolicy.defaultForFeature('leads.manage', 'reception'), true);

const modelSentinels = Object.fromEntries(
  Object.keys(db.LeadIntake.rawAttributes).map((field) => [field, `secret:${field}`]),
);
const redacted = redactLeadForPrivacy({
  ...modelSentinels,
  id: 42,
  clinica_id: 56,
  grupo_clinica_id: 5,
  campana_id: 7,
  channel: 'paid',
  nombre: 'Nombre real',
  apellidos: 'Apellidos reales',
  email: 'persona@example.com',
  telefono: '+34600000000',
  notas: 'Motivo de consulta',
  notas_internas: 'Nota interna',
  motivo_descarte: 'Describe un tratamiento sensible',
  callback_reminder_reason: 'Llamar por su diagnóstico',
  ga_client_id: 'ga-client-secret',
  external_id: 'external-lead-secret',
  gclid: 'click-id',
  page_url: 'https://example.com/tratamiento-sensible',
  formSubmissionEvents: [{ payload_json: { lead_data: { email: 'persona@example.com' } } }],
  patient_match: { exists: true, patient_id: 77 },
  linked_appointment: { id: 88, paciente_nombre: 'Nombre real' },
  source: 'google_ads',
  source_detail: 'motivo-medico-en-url',
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'Campaña captación',
  utm_content: 'creative-secret',
  utm_term: 'medical-query-secret',
  google_ads_customer_id: '1234567890',
  google_ads_campaign_id: '987654321',
  status_lead: 'nuevo',
  clinic_match_source: 'campaign_assignment',
  clinic_match_value: 'private-routing-value',
  clinica: { id_clinica: 56, nombre_clinica: 'Clínica 56', private: 'secret' },
  grupoClinica: { id_grupo: 5, nombre_grupo: 'Grupo 5', private: 'secret' },
  campana: { id: 7, nombre: 'Campaña segura', campaign_id: '987654321', private: 'secret' },
  marketing_campaign: {
    provider: 'google_ads',
    customer_id: '1234567890',
    external_id: '987654321',
    name: 'Campaña segura',
    resolution: 'external_inventory',
    private: 'secret',
  },
  source_trace: {
    source: 'google_ads',
    source_detail: 'medical-source-detail',
    channel: 'paid',
    page_url: 'https://example.com/medical-page',
    landing_url: 'https://example.com/medical-landing',
    referrer: 'https://example.com/private-referrer',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'Campaña captación',
      content: 'creative-secret',
      term: 'medical-query-secret',
    },
    click_ids: { gclid: 'click-id' },
    dedupe: { count: 2, last_reason: 'private reason' },
  },
});

assert.equal(redacted.privacy_redacted, true);
assert.match(`${redacted.nombre} ${redacted.apellidos}`, /^Lead #[A-F0-9]{6}$/);
for (const forbiddenField of [
  'email', 'email_hash', 'telefono', 'phone_hash', 'notas', 'notas_internas',
  'motivo_descarte', 'callback_reminder_reason', 'callback_reminder_notes',
  'ga_client_id', 'external_id', 'source_detail', 'clinic_match_value',
  'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid',
  'page_url', 'landing_url', 'referrer', 'ip', 'user_agent', 'event_id',
]) {
  assert.equal(Object.hasOwn(redacted, forbiddenField), false, `${forbiddenField} must not leave the strict allowlist`);
}
assert.deepEqual(redacted.formSubmissionEvents, []);
assert.equal(redacted.patient_match, null);
assert.equal(redacted.linked_appointment, null);
assert.equal(redacted.source, 'google_ads');
assert.equal(redacted.utm_campaign, 'Campaña captación');
assert.deepEqual(redacted.source_trace, {
  source: 'google_ads',
  channel: 'paid',
  utm: {
    source: 'google',
    medium: 'cpc',
    campaign: 'Campaña captación',
  },
});
assert.deepEqual(redacted.campana, {
  id: 7,
  nombre: 'Campaña segura',
  campaign_id: '987654321',
});
assert.equal(Object.hasOwn(redacted.marketing_campaign, 'private'), false);
assert.equal(Object.hasOwn(redacted.clinica, 'private'), false);

const SAFE_REDACTED_KEYS = new Set([
  'id', 'clinica_id', 'grupo_clinica_id', 'campana_id', 'clinica', 'grupoClinica', 'campana',
  'channel', 'source', 'contact_method', 'marketing_origin', 'marketing_campaign',
  'clinic_match_source', 'utm_source', 'utm_medium', 'utm_campaign',
  'google_ads_customer_id', 'google_ads_campaign_id', 'status_lead',
  'created_at', 'updated_at', 'archived_at', 'nombre', 'apellidos',
  'privacy_redacted', 'privacy_access', 'source_trace', 'patient_match', 'es_paciente',
  'linked_appointment', 'recent_appointment', 'formSubmissionEvents',
  'historial_contactos', 'conversation_id', 'pending_whatsapp_reply_count',
  'pending_automation_attention',
]);
for (const field of Object.keys(redacted)) {
  assert.ok(SAFE_REDACTED_KEYS.has(field), `unexpected redacted field escaped allowlist: ${field}`);
}
for (const [field, sentinel] of Object.entries(modelSentinels)) {
  if (SAFE_REDACTED_KEYS.has(field)) continue;
  assert.equal(JSON.stringify(redacted).includes(sentinel), false, `${field} sentinel must not survive redaction`);
}

const publicSearch = buildLeadSearchConditions('medical-query-secret', {
  canSearchSensitive: false,
  includeCampaignRelation: true,
});
const publicSearchFields = publicSearch.flatMap((condition) => Reflect.ownKeys(condition));
for (const forbiddenSearchField of ['nombre', 'email', 'telefono', 'source_detail', 'page_url', 'landing_url']) {
  assert.equal(publicSearchFields.includes(forbiddenSearchField), false,
    `${forbiddenSearchField} must not be searchable without leads.sensitive.view`);
}
assert.ok(publicSearchFields.includes('utm_campaign'));
assert.ok(publicSearchFields.includes('$campana.nombre_campana$'));

const publicSourceSearch = buildLeadSearchConditions('google_ads', { canSearchSensitive: false });
assert.ok(publicSourceSearch.some((condition) => condition.source === 'google_ads'));
const sensitiveSearch = buildLeadSearchConditions('medical-query-secret', { canSearchSensitive: true });
assert.ok(sensitiveSearch.some((condition) => Object.hasOwn(condition, 'source_detail')));

for (const status of ['citado', 'acudio_cita', 'convertido', 'descartado']) {
  assert.equal(
    isLeadClosedForPendingSignals({ status_lead: status }),
    true,
    `${status} must suppress pending lead signals`,
  );
}
assert.equal(
  isLeadClosedForPendingSignals({ status_lead: 'info_recibida', linked_appointment: { id: 88 } }),
  true,
  'active linked appointments must suppress pending lead signals',
);
assert.equal(
  isLeadClosedForPendingSignals({
    status_lead: 'info_recibida',
    linked_appointment: null,
    recent_appointment: { estado: 'cancelada' },
  }),
  true,
  'cancelled appointment display status must suppress stale pending lead signals',
);
assert.equal(
  isLeadClosedForPendingSignals({ status_lead: 'info_recibida', pending_whatsapp_reply_count: 2 }),
  false,
  'open leads must preserve pending lead signals',
);
for (const callOutcome of ['citado', 'informacion']) {
  assert.equal(
    isLeadClosedForPendingSignals({ status_lead: 'info_recibida', call_outcome: callOutcome }),
    true,
    `${callOutcome} call outcome must suppress pending lead signals`,
  );
}
assert.equal(
  isLeadClosedForPendingSignals({ status_lead: 'contactado', call_outcome: 'no_contactado' }),
  false,
  'failed contact call outcome must keep pending lead signals open',
);

for (const protectedAction of [
  'updateLeadStatus',
  'registrarContacto',
  'getCandidateAppointments',
  'saveCallOutcome',
  'deleteLead',
]) {
  const marker = `exports.${protectedAction}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);
  const body = source.slice(start, start + 1800);
  assert.match(body, /ensureLeadFeatureAccess\(req, res, lead, 'leads\.manage'\)/);
}

assert.match(source, /ensureLeadFeatureAccess\(req, res, lead, 'leads\.sensitive\.view'\)/);
assert.doesNotMatch(
  source,
  /canSearchSensitive\s*\?[^:]*:\s*\[[\s\S]{0,160}source_detail/,
  'non-sensitive list/stats search must not fall back to source_detail',
);
assert.match(appSource, /readPatients && patientSensitive/);
assert.match(appSource, /readLeads && leadSensitive/);
assert.match(attachmentSource, /clinical_attachment:[\s\S]*featureKey: 'patients\.sensitive\.view'/);

console.log('lead privacy access contract: ok');

async function closeTestResources() {
  await Promise.all(Object.values(queues || {}).map((queue) => queue.close()));
  await db.sequelize.close();
}

closeTestResources().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
