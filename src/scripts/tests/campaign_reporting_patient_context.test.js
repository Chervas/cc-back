'use strict';

// All reads use fixtures; socket guards forbid any database/provider connection.
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { Op } = require('sequelize');
const workspace = require('../../services/campaignWorkspace.service');
const { reportPeriod, visibleCampaigns } = require('../../services/campaignWorkspaceReport.service');
const { loadReportingPatientContexts, patientContextBreakdown, isCommercialLead, aggregateCommercialWorkspace } = workspace;

const now = new Date('2026-09-10T10:00:00Z');
const period = reportPeriod(7, now);
const snapshot = (relationship, request_kind = 'commercial') => ({ version: 1, relationship, request_kind,
  clinic_id: 1, same_clinic: true, clinic_name: null, reason: 'test_snapshot',
  patient_id: relationship === 'existing_patient' ? 99 : null, captured_at: '2026-09-01T10:00:00Z' });
const lead = (id, extra = {}) => ({ id, clinica_id: 1, source: 'google_ads', channel: 'paid',
  google_ads_customer_id: '1234567890', google_ads_campaign_id: '100',
  created_at: '2026-09-08T10:00:00Z', date: '2026-09-08', status_lead: 'citado', ...extra });
const appointment = (id, leadId, extra = {}) => ({ id_cita: id, clinica_id: 1, lead_intake_id: leadId,
  paciente_id: 99, created_at: '2026-09-09T10:00:00Z', date: '2026-09-09', estado: 'confirmada', es_provisional: false, ...extra });
const decision = (request_kind, extra = {}) => ({ version: 1, decision: 'clinic', request_kind,
  actor_user_id: 7, director_user_id: 8, decided_at: '2026-09-09T10:00:00Z', clinic_id: 1, ...extra });
const auditsModel = (rows, calls = []) => ({ findAll: async options => {
  calls.push(options);
  assert.ok(!options.attributes.includes('raw_payload'));
  return rows.filter(row => options.where.lead_intake_id[Op.in].map(String).includes(String(row.lead_intake_id)))
    .map(row => ({ context_type: row.patient_context ? 'lead_patient_context_v1' : 'lead_patient_attention_v1', ...row }));
} });
const fixtureLeads = () => [
  lead(1, { patient_context: snapshot('new_contact') }),
  lead(2, { patient_context: snapshot('existing_patient') }),
  lead(3, { patient_context: snapshot('possible_patient') }),
  lead(4, { patient_context: snapshot('unknown') }),
  lead(5, { paciente_id: 99 }),
  lead(6, { patient_context: snapshot('existing_patient', 'patient_care') }),
  lead(7, { patient_context: snapshot('existing_patient'), patient_attention: decision('patient_care') }),
  lead(8, { patient_context: snapshot('existing_patient', 'patient_care'), patient_attention: decision('commercial') }),
];
const expected = { new_contacts: 1, existing_patients: 2, possible_patients: 1, unknown: 2, patient_care: 2 };
const campaigns = () => visibleCampaigns({ scope: { clinicIds: [1] },
  mappings: [{ provider: 'google_ads', accountId: '1234567890', clinicId: 1 }], assignments: [],
  inventory: [{ provider: 'google_ads', customer_id: '1234567890', campaign_id: '100', campaign_name: 'Campaign', status: 'ENABLED' }],
}).map(c => ({ ...c, currency: 'EUR' }));

function loadIsolated(filename, mocks) {
  const target = require.resolve(filename);
  const mod = new Module(target, module);
  mod.filename = target;
  mod.paths = Module._nodeModulePaths(require('node:path').dirname(target));
  const original = mod.require.bind(mod);
  mod.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
  mod._compile(fs.readFileSync(target, 'utf8'), target);
  return mod.exports;
}

function controller(db) {
  return loadIsolated('../../controllers/marketingReports.controller', {
    '../../models': { Sequelize: { QueryTypes: { SELECT: 'SELECT' } }, ...db },
    '../services/webEvents.service': {}, '../services/effectiveMarketingAssets.service': {},
    '../lib/clinicScope': {}, '../lib/marketingScopeAccess': {}, '../lib/role-helpers': {},
    '../services/businessProfileLocal.service': {}, '../services/marketingReportOverviewCache.service': {},
  }).__testing;
}

test('frozen segments and attention classification are disjoint; linked legacy patients stay unknown', () => {
  const rows = fixtureLeads();
  const before = structuredClone(rows);
  assert.deepEqual(patientContextBreakdown([...rows, rows[0], rows[5]]), expected);
  assert.equal(rows.filter(isCommercialLead).length, 6);
  assert.deepEqual(patientContextBreakdown([lead(20, { patient_id: 99, paciente_id: 99, converted_at: now })]),
    { new_contacts: 0, existing_patients: 0, possible_patients: 0, unknown: 1, patient_care: 0 });
  assert.deepEqual(rows, before);
});

test('JSON snapshots and malformed/absent data never infer a new contact', () => {
  const rows = [lead(1, { patient_context: JSON.stringify(snapshot('existing_patient')) }),
    lead(2, { patient_context: '{broken' }), lead(3, { patient_context: [] }),
    lead(4, { patient_context: { relationship: 'constructor' } }), lead(5, { patient_context: null })];
  assert.deepEqual(patientContextBreakdown(rows), { new_contacts: 0, existing_patients: 1, possible_patients: 0, unknown: 4, patient_care: 0 });
});

test('audit reads are bounded to selected leads, preserve attribution, and resolve append-only decisions by audit id', async () => {
  const rows = [
    { id: 1, lead_intake_id: 1, patient_context: JSON.stringify(snapshot('existing_patient')) },
    { id: 2, lead_intake_id: 1, patient_attention: decision('patient_care', { decided_at: '2026-09-10T00:00:00Z' }) },
    { id: 3, lead_intake_id: 1, patient_attention: decision('commercial', { decided_at: '2026-09-09T00:00:00Z' }) },
    { id: 4, lead_intake_id: 2, patient_attention: decision('patient_care') },
    { id: 5, lead_intake_id: 3, patient_context: snapshot('unknown') },
    { id: 6, lead_intake_id: 3, patient_context: snapshot('existing_patient') },
    { id: 7, lead_intake_id: 4, patient_context: snapshot('existing_patient') },
    { id: 8, lead_intake_id: 4, patient_attention: decision('patient_care', { clinic_id: 2 }) },
    { id: 9, lead_intake_id: 999, patient_context: snapshot('new_contact') },
  ];
  const calls = [], input = [lead(1), lead(2), lead(3), lead(4)];
  const before = structuredClone(input);
  const models = { LeadAttributionAudit: auditsModel(rows, calls) };
  const enriched = await loadReportingPatientContexts({ models, leads: input, transaction: 'read-transaction' });
  assert.equal(isCommercialLead(enriched[0]), true);
  assert.equal(isCommercialLead(enriched[1]), false);
  assert.equal(isCommercialLead(enriched[3]), true);
  assert.deepEqual(patientContextBreakdown(enriched), { new_contacts: 0, existing_patients: 2, possible_patients: 0, unknown: 1, patient_care: 1 });
  assert.deepEqual(await loadReportingPatientContexts({ models, leads: enriched }), enriched);
  assert.deepEqual(input, before);
  assert.equal(enriched[0].google_ads_campaign_id, '100');
  assert.deepEqual(calls[0].where.lead_intake_id[Op.in], ['1', '2', '3', '4']);
  assert.equal(calls[0].transaction, 'read-transaction');
});

test('reading an empty scope does not query audits; failures are not silently reported as new or commercial', async () => {
  const models = { LeadAttributionAudit: { findAll: async () => { throw Error('audit_unavailable'); } } };
  assert.deepEqual(await loadReportingPatientContexts({ models, leads: [] }), []);
  await assert.rejects(loadReportingPatientContexts({ models, leads: [lead(1)] }), /audit_unavailable/);
});

test('workspace excludes care from totals, series, CPL denominator and appointments, while exposing it in each campaign', () => {
  const leads = fixtureLeads();
  const input = { campaigns: campaigns(), leads: [...leads, leads[0]], period, now,
    appointments: [...leads.map(row => appointment(row.id, row.id)), appointment(1, 1),
      appointment(40, null), appointment(41, 1, { clinica_id: 2 }), appointment(42, 1, { estado: 'cancelada' }),
      appointment(43, 1, { es_provisional: true })],
    facts: [{ provider: 'google_ads', account_id: '1234567890', campaign_id: '100', date: '2026-09-09',
      spend: 60, segment: [], providerConversions: 15, updatedAt: now }],
  };
  const before = structuredClone(input);
  const result = aggregateCommercialWorkspace(input);
  assert.equal(result.current.leads, 6);
  assert.equal(result.current.appointments, 6);
  assert.equal(result.current.spend / result.current.leads, 10);
  assert.equal(result.current.providerConversions, 15, 'provider conversion metrics are untouched');
  assert.deepEqual(result.patient_context_breakdown, expected);
  assert.deepEqual(result.rows[0].current.patient_context_breakdown, expected);
  assert.equal(result.daily.reduce((sum, row) => sum + row.leads, 0), 6);
  assert.equal(result.daily.reduce((sum, row) => sum + row.appointments, 0), 6);
  assert.match(result.patient_context_explanation, /desconocida/);
  assert.deepEqual(aggregateCommercialWorkspace(input), result);
  assert.deepEqual(input, before);
});

test('campaign context is period and clinic isolated; old commercial leads can supply only their linked appointments', () => {
  const leads = [lead(1, { created_at: '2026-08-01T10:00:00Z', patient_context: snapshot('existing_patient') }),
    lead(2, { created_at: '2026-08-01T10:00:00Z', patient_context: snapshot('existing_patient', 'patient_care') }),
    lead(3, { created_at: '2026-09-02T10:00:00Z', patient_context: snapshot('possible_patient') }),
    lead(4, { clinica_id: 2, patient_context: snapshot('new_contact') })];
  const result = aggregateCommercialWorkspace({ campaigns: campaigns(), period, now, leads,
    appointments: [appointment(1, 1), appointment(2, 2), appointment(3, 1, { clinica_id: 2 }),
      appointment(4, null), appointment(5, 3, { created_at: '2026-09-01T10:00:00Z' })] });
  assert.equal(result.current.leads, 0);
  assert.equal(result.current.appointments, 1);
  assert.equal(result.previous.leads, 1);
  assert.equal(result.previous_patient_context_breakdown.possible_patients, 1);
  assert.equal(result.patient_context_breakdown.new_contacts, 0);
});

test('care-only campaigns stay visible with a zero commercial count and their management breakdown', () => {
  const result = aggregateCommercialWorkspace({ campaigns: campaigns(), period, now,
    leads: [lead(1, { patient_context: snapshot('existing_patient', 'patient_care') })] });
  assert.equal(result.rows.length, 1);
  assert.equal(result.current.leads, 0);
  assert.equal(result.rows[0].current.patient_context_breakdown.patient_care, 1);
  assert.equal(result.rows[0].campaign.name, 'Campaign');
});

test('overview commercial totals, channels and time series reconcile with the same segment contract', async () => {
  const api = controller({});
  const rows = fixtureLeads();
  const range = api.buildRange('2026-09-08', '2026-09-09');
  const result = await api.aggregateLeads({}, range, [...rows, rows[0]]);
  assert.equal(result.totals.leads, 6);
  assert.equal(result.totals.citas, 6, 'cited leads retain their original status/cohort semantics');
  assert.deepEqual(result.patient_context_breakdown, expected);
  assert.deepEqual(result.channels.get('google_ads').patient_context_breakdown, expected);
  const series = await api.aggregateLeadSeries({}, range, [...rows, rows[0]]);
  assert.deepEqual(series.leads, [6, 0]);
  assert.deepEqual(series.paidLeads, [6, 0]);
  assert.deepEqual(series.citas, [6, 0]);
  const channels = api.buildChannels(result.channels, { google_ads: 60 });
  assert.equal(channels[0].cpl, 10);
  assert.deepEqual(channels[0].patient_context_breakdown, expected);
});

test('overview loads clinic-scoped records without contact details and retains legacy unknown', async () => {
  const queries = [];
  const api = controller({ LeadIntake: { findAll: async options => { queries.push(options); return [lead(1), lead(2)]; } },
    LeadAttributionAudit: auditsModel([{ id: 1, lead_intake_id: 2, patient_context: snapshot('existing_patient') }]) });
  const range = api.buildRange('2026-09-08', '2026-09-09');
  const rows = await api.loadReportLeads({ scope: 'clinic', clinicIds: [1] }, range);
  assert.equal(queries[0].where.clinica_id, 1);
  assert.equal(queries[0].where.archived_at, null);
  assert.equal(+queries[0].where.created_at[Op.gte], +range.start);
  assert.ok(!queries[0].attributes.some(key => ['nombre', 'telefono', 'email', 'patient_id', 'paciente_id'].includes(key)));
  assert.equal(patientContextBreakdown(rows).unknown, 1);
});

test('overview appointments retain original date/status eligibility while excluding care and unrelated same-patient activity', async () => {
  const queries = [];
  const old = [lead(10, { created_at: '2026-08-01T00:00:00Z' }), lead(11, { created_at: '2026-08-01T00:00:00Z' })];
  const rows = [appointment(1, 10), appointment(2, 11), appointment(3, null),
    appointment(4, 10, { clinica_id: 2 }), appointment(5, 10, { estado: 'cancelada' }),
    appointment(6, 10, { es_provisional: true }), appointment(7, 10, { created_at: '2026-07-01T00:00:00Z' }), appointment(1, 10)];
  const api = controller({ CitaPaciente: { findAll: async options => {
    assert.equal(options.where.clinica_id, 1);
    assert.equal(options.where.lead_intake_id[Op.ne], null);
    assert.equal(options.where.estado, undefined);
    assert.equal(options.where.es_provisional, undefined);
    return rows.filter(row => +new Date(row.created_at) >= +options.where.created_at[Op.gte]
      && +new Date(row.created_at) < +options.where.created_at[Op.lt]);
  } },
    LeadIntake: { findAll: async options => { queries.push(options); return old; } },
    LeadAttributionAudit: auditsModel([{ id: 1, lead_intake_id: 10, patient_context: snapshot('existing_patient') },
      { id: 2, lead_intake_id: 11, patient_context: snapshot('existing_patient', 'patient_care') }]) });
  const range = api.buildRange('2026-09-08', '2026-09-09');
  const loaded = await api.loadCommercialAppointments({ scope: 'clinic', clinicIds: [1] }, range);
  assert.deepEqual(loaded.map(row => row.id_cita), [1, 5, 6], 'cancelled/provisional filtering was not part of the original overview');
  assert.equal(queries[0].where.clinica_id, 1);
  assert.equal(queries[0].where.created_at, undefined, 'old linked leads must be classified too');
  assert.deepEqual(await api.countAppointments({}, range, loaded), { creadas: 3, completadas: 0, noAsistio: 0 });
  assert.deepEqual(await api.aggregateAppointmentSeries({}, range, loaded), { citas: [0, 3], acudieron: [0, 0] });
});

test('repeated appointments and visits for older leads never multiply the cited-lead cohort or move its daily counts', async () => {
  const current = [
    lead(1, { patient_context: snapshot('existing_patient') }),
    lead(2, { created_at: '2026-09-09T10:00:00Z', date: '2026-09-09', status_lead: 'acudio_cita', patient_context: snapshot('existing_patient') }),
    lead(3, { created_at: '2026-09-09T10:00:00Z', date: '2026-09-09', status_lead: 'convertido' }),
    lead(4, { status_lead: 'nuevo', patient_context: snapshot('new_contact') }),
    lead(5, { status_lead: 'convertido', patient_context: snapshot('existing_patient', 'patient_care') }),
  ];
  const old = [lead(10, { created_at: '2026-08-01T00:00:00Z' }), lead(11, { created_at: '2026-08-01T00:00:00Z' })];
  const visits = [appointment(1, 1), appointment(2, 1), appointment(3, 1), appointment(4, 2, { estado: 'completada' }),
    appointment(5, 10, { estado: 'ha_acudido', created_at: '2026-09-08T12:00:00Z', date: '2026-09-08' }),
    appointment(6, 5, { estado: 'completada' }), appointment(7, 11, { estado: 'completada' })];
  let appointmentReads = 0;
  const api = controller({ CitaPaciente: { findAll: async () => { appointmentReads++; return visits; } },
    LeadIntake: { findAll: async options => {
      assert.equal(options.where.created_at, undefined, 'only the appointment window controls old linked leads');
      assert.equal(options.where.clinica_id, 1);
      assert.deepEqual(options.where.id[Op.in], ['10', '11']);
      return old;
    } },
    LeadAttributionAudit: auditsModel([{ id: 1, lead_intake_id: 10, patient_context: snapshot('existing_patient') },
      { id: 2, lead_intake_id: 11, patient_context: snapshot('existing_patient', 'patient_care') }]),
  });
  const scope = { scope: 'clinic', clinicIds: [1] }, range = api.buildRange('2026-09-08', '2026-09-09');
  const before = structuredClone(current);
  const cohort = await api.aggregateLeads(scope, range, current);
  const series = await api.aggregateLeadSeries(scope, range, current);
  assert.equal(appointmentReads, 0, 'cohort/status metrics do not depend on number or dates of appointments');
  assert.deepEqual(cohort.totals, { leads: 4, contactados: 3, citas: 3, acudieron: 2, convertidos: 1 });
  assert.equal(cohort.channels.get('google_ads').citas, 3);
  assert.deepEqual(series.leads, [2, 2]);
  assert.deepEqual(series.citas, [1, 2]);
  assert.deepEqual(series.acudieron, [0, 2]);
  assert.deepEqual(series.convertidos, [0, 1]);
  const linked = await api.loadCommercialAppointments(scope, range, current);
  assert.deepEqual(linked.map(row => row.id_cita), [1, 2, 3, 4, 5]);
  assert.deepEqual(await api.countAppointments(scope, range, linked), { creadas: 5, completadas: 2, noAsistio: 0 });
  assert.deepEqual(await api.aggregateAppointmentSeries(scope, range, linked), { citas: [1, 4], acudieron: [1, 1] });
  assert.deepEqual(await api.aggregateLeads(scope, range, current), cohort);
  assert.deepEqual(await api.aggregateLeadSeries(scope, range, current), series);
  assert.deepEqual(current, before);
});

test('web-page commercial counts exclude care with bound ids while retaining management activity rows', async () => {
  let query;
  const api = controller({ sequelize: { query: async (sql, options) => { query = { sql, ...options }; return []; } } });
  const range = api.buildRange('2026-09-08', '2026-09-09');
  await api.aggregateWebPages({ scope: 'clinic', clinicIds: [1] }, range, [], fixtureLeads());
  assert.deepEqual(query.replacements.patientCareLeadIds, [6, 7]);
  assert.match(query.sql, /SUM\(CASE WHEN id IN \(:patientCareLeadIds\) THEN 0 ELSE 1 END\) AS leads/);
  assert.match(query.sql, /SUM\(CASE WHEN source = 'call_click'/);
});

test('typed audit keys use core validation and immutable first snapshot; untyped receipts and derived legacy previews cannot become acquisitions', async () => {
  const input = [lead(1), lead(2), lead(3), lead(4)];
  const models = { LeadAttributionAudit: auditsModel([
    { id: 1, lead_intake_id: 1, context_type: null, patient_context: snapshot('new_contact') },
    { id: 2, lead_intake_id: 2, patient_context: { ...snapshot('new_contact'), version: 2 } },
    { id: 3, lead_intake_id: 3, patient_context: snapshot('existing_patient') },
    { id: 4, lead_intake_id: 3, patient_context: snapshot('new_contact') },
    { id: 5, lead_intake_id: 4, context_type: null, patient_attention: decision('patient_care') },
  ]) };
  const result = await loadReportingPatientContexts({ models, leads: input });
  assert.deepEqual(patientContextBreakdown(result), { new_contacts: 0, existing_patients: 1, possible_patients: 0, unknown: 3, patient_care: 0 });
  const derived = [lead(10, { patient_context: { ...snapshot('existing_patient'), persisted: false } }),
    lead(11, { patient_context: { ...snapshot('possible_patient'), persisted: false } }),
    lead(12, { patient_context: { ...snapshot('new_contact'), persisted: false } })];
  assert.equal(patientContextBreakdown(derived).unknown, 3);
});

test('workspace loader excludes old care leads from accepted budgets without attributing unrelated patient activity', async () => {
  const emptyEvidence = async () => new Map();
  const api = loadIsolated('../../services/campaignWorkspace.service', {
    './campaignWorkspaceReception.service': { loadFormReceiptEvidence: emptyEvidence },
    './campaignWorkspaceNativeReception.service': { loadNativeFormEvidence: emptyEvidence },
    './campaignWorkspaceGoogleReception.service': { loadGoogleNativeEvidence: emptyEvidence },
    './campaignWorkspaceSignalEvidence.service': { loadMetaSignalEvidence: emptyEvidence },
    './campaignWorkspaceGoogleSignalEvidence.service': { loadGoogleSignalEvidence: emptyEvidence },
    './campaignWorkspaceOptimizationHistory.service': { loadOptimizationIncidentEvidence: emptyEvidence },
    './campaignWorkspaceRecommendations.service': { buildAdCostRecommendations: () => [] },
  });
  const commercial = lead(1);
  const care = lead(2, { created_at: '2026-08-01T10:00:00Z' });
  const appointments = [appointment(1, 1, { paciente_id: 100 }), appointment(2, 2)];
  const emptyModel = { findAll: async () => [] };
  const queries = [];
  const models = {
    Clinica: { findAll: async () => [{ id_clinica: 1, grupoClinicaId: null, nombre_clinica: 'Fictional clinic' }] },
    ClinicGoogleAdsAccount: { findAll: async () => [{ customerId: '1234567890', assignmentScope: 'clinic', clinicaId: 1, currencyCode: 'EUR' }] },
    ClinicMetaAsset: emptyModel, GoogleAdsAdInventory: emptyModel, ExternalCampaignAssignment: emptyModel,
    CampaignWorkspaceSetting: emptyModel, GoogleAdsInsightsDaily: emptyModel, IntakeConfig: emptyModel,
    GoogleAdsAdInsightsDaily: emptyModel, GoogleAdsAdSyncDay: emptyModel,
    ExternalCampaignInventory: { findAll: async () => [{ provider: 'google_ads', customer_id: '1234567890', campaign_id: '100', status: 'ENABLED' }] },
    LeadIntake: { findAll: async options => { queries.push(options);
      return options.where.created_at ? [commercial] : [commercial, care].filter(row => options.where.id[Op.in].map(String).includes(String(row.id))); } },
    CitaPaciente: { findAll: async options => {
      assert.equal(options.where.lead_intake_id[Op.ne], null);
      return appointments;
    } },
    LeadAttributionAudit: auditsModel([{ id: 1, lead_intake_id: 1, patient_context: snapshot('existing_patient') },
      { id: 2, lead_intake_id: 2, patient_context: snapshot('existing_patient', 'patient_care') }]),
    EconomicBudget: { findAll: async () => [
      { id: 1, clinic_id: 1, patient_id: 99, status: 'accepted', accepted_amount: '900', responded_at: '2026-09-09T12:00:00Z' },
      { id: 2, clinic_id: 1, patient_id: 100, status: 'accepted', accepted_amount: '100', responded_at: '2026-09-09T12:00:00Z' },
      { id: 3, clinic_id: 1, patient_id: 101, status: 'accepted', accepted_amount: '500', responded_at: '2026-09-09T12:00:00Z' },
    ] },
  };
  const options = { models, scope: { clinicIds: [1] }, days: 7, now };
  const first = await api.loadCampaignWorkspace(options);
  assert.equal(first.report.current.leads, 1);
  assert.equal(first.report.current.appointments, 1);
  assert.equal(first.report.current.accepted, 100);
  assert.equal(first.report.patient_context_breakdown.existing_patients, 1);
  assert.equal(first.report.budgetAttribution.attributed, 1);
  assert.equal(first.report.budgetAttribution.unlinked, 1);
  assert.equal(first.report.budgetAttribution.ambiguous, 1);
  assert.deepEqual(await api.loadCampaignWorkspace(options), first);
  assert.ok(queries.every(query => query.where.clinica_id[Op.in].length === 1 && query.where.clinica_id[Op.in][0] === 1));
  assert.equal(commercial.patient_context, undefined);
  assert.equal(care.patient_context, undefined);
});

test('overview cache schema changes even with a pinned base; fresh legacy payloads cannot hide the new breakdown', async () => {
  const previousBase = process.env.MARKETING_REPORT_OVERVIEW_CACHE_VERSION;
  const previousSc = process.env.SC_ANALYTICS_READ_ENABLED;
  try {
    process.env.MARKETING_REPORT_OVERVIEW_CACHE_VERSION = 'marketing-overview-v1';
    process.env.SC_ANALYTICS_READ_ENABLED = 'false';
    const api = loadIsolated('../../services/marketingReportOverviewCache.service', {
      '../../models': {}, './jobRequests.service': {},
    });
    const range = controller({}).buildRange('2026-09-08', '2026-09-09');
    const options = { scope: { scope: 'clinic', clinicIds: [1] }, range };
    const legacy = api.buildOverviewCacheIdentity({ ...options, reportVersion: 'marketing-overview-v1' });
    const current = api.buildOverviewCacheIdentity(options);
    assert.equal(current.report_version, 'marketing-overview-v1-patient-context-v1');
    assert.notEqual(current.cache_key, legacy.cache_key);
    const oldRow = { ...legacy, payload: { marker: 'legacy-with-care-in-commercial-count' }, generated_at: now,
      fresh_until: new Date(+now + 86400000), expires_at: new Date(+now + 172800000) };
    const rows = new Map([[legacy.cache_key, structuredClone(oldRow)]]);
    const model = {
      findOne: async ({ where }) => structuredClone(rows.get(where.cache_key) || null),
      findOrCreate: async ({ where, defaults }) => {
        const existed = rows.has(where.cache_key);
        if (!existed) rows.set(where.cache_key, structuredClone(defaults));
        return [structuredClone(rows.get(where.cache_key)), !existed];
      },
      update: async (values, { where }) => {
        const row = rows.get(where.cache_key);
        if (!row || where.refresh_lock_token && row.refresh_lock_token !== where.refresh_lock_token) return [0];
        rows.set(where.cache_key, { ...row, ...structuredClone(values) });
        return [1];
      },
    };
    let generated = 0;
    const cache = api.createOverviewCacheCoordinator({ model, now: () => now });
    const read = () => cache.readOrGenerate({ identity: current, generate: async () => {
      generated++;
      return { patient_context_breakdown: expected, patient_context_explanation: workspace.PATIENT_CONTEXT_EXPLANATION };
    } });
    assert.deepEqual((await read()).patient_context_breakdown, expected);
    assert.deepEqual((await read()).patient_context_breakdown, expected);
    assert.equal(generated, 1);
    assert.deepEqual(rows.get(legacy.cache_key), oldRow, 'schema rollout never manually empties old cache rows');
    process.env.SC_ANALYTICS_READ_ENABLED = 'true';
    const property = api.buildOverviewCacheIdentity(options);
    assert.equal(property.report_version, current.report_version + '-sc-property-v1');
    assert.notEqual(property.cache_key, current.cache_key);
  } finally {
    if (previousBase === undefined) delete process.env.MARKETING_REPORT_OVERVIEW_CACHE_VERSION;
    else process.env.MARKETING_REPORT_OVERVIEW_CACHE_VERSION = previousBase;
    if (previousSc === undefined) delete process.env.SC_ANALYTICS_READ_ENABLED;
    else process.env.SC_ANALYTICS_READ_ENABLED = previousSc;
  }
});
