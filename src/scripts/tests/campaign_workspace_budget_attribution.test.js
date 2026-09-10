'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { budgetCampaignAttribution, loadBudgetCampaignAttribution } = require('../../services/campaignEconomicAttribution.service');
const { reportPeriod, aggregateReport } = require('../../services/campaignWorkspaceReport.service');

const period = reportPeriod(7, new Date('2026-09-10T10:00:00Z'));
const campaigns = [{ id: 'g1', provider: 'google_ads', account_id: '123', campaign_id: '456', clinicId: 1, assigned: true, currency: 'EUR' }];
const budget = { id: '9007199254740993', clinic_id: 1, patient_id: 10, status: 'accepted', accepted_amount: '123.45', responded_at: '2026-09-04T12:00:00Z' };
const appointment = { id_cita: 1, clinica_id: 1, paciente_id: 10, lead_intake_id: 20, estado: 'pendiente', created_at: '2026-08-01T10:00:00Z' };
const lead = { id: 20, clinica_id: 1, source: 'google_ads', channel: 'paid', google_ads_customer_id: '123', google_ads_campaign_id: '456', created_at: '2026-07-01T10:00:00Z' };
const calculate = (more = {}) => budgetCampaignAttribution({ campaigns, period, budgets: [budget], appointments: [appointment], leads: [lead], ...more });

test('real accepted amount follows an older canonical lead-patient appointment link, without catalog prices', () => {
  const result = calculate(); assert.equal(result.currency, 'EUR'); assert.equal(result.coverage.attributed, 1);
  assert.deepEqual(result.allocations, [{ campaignId: 'g1', acceptedAt: budget.responded_at, amountCents: 12345 }]);
});
test('duplicate budgets, repeat appointments and multiple leads for the same campaign count the budget once', () => {
  const result = calculate({ budgets: [budget, budget], appointments: [appointment, appointment, { ...appointment, id_cita: 2, lead_intake_id: 21 }], leads: [lead, { ...lead, id: 21 }] });
  assert.equal(result.allocations.length, 1); assert.equal(result.coverage.attributed, 1);
});
test('two campaign origins or a missing origin are ambiguous, never last-touch or proportional revenue', () => {
  for (const otherLead of [{ ...lead, id: 21, google_ads_campaign_id: '789' }, { ...lead, id: 21, google_ads_campaign_id: null }, null]) {
    const result = calculate({ campaigns: [...campaigns, { ...campaigns[0], id: 'g2', campaign_id: '789' }],
      appointments: [appointment, { ...appointment, id_cita: 2, lead_intake_id: 21 }], leads: otherLead ? [lead, otherLead] : [lead] });
    assert.equal(result.allocations.length, 0); assert.equal(result.coverage.ambiguous, 1);
  }
});
test('cancelled, provisional, cross-clinic or later appointments cannot attribute a budget', () => {
  for (const patch of [{ estado: 'cancelada' }, { estado: 'reprogramada' }, { es_provisional: true },
    { clinica_id: 2 }, { created_at: '2026-09-05T12:00:00Z' }]) {
    assert.equal(calculate({ appointments: [{ ...appointment, ...patch }] }).allocations.length, 0);
  }
  assert.equal(calculate({ leads: [{ ...lead, clinica_id: 2 }] }).allocations.length, 0);
  assert.equal(calculate({ leads: [{ ...lead, created_at: '2026-09-02T12:00:00Z' }] }).allocations.length, 0);
});
test('a unique campaign name is not enough to attribute money', () => {
  const result = calculate({ leads: [{ ...lead, google_ads_customer_id: null, google_ads_campaign_id: null, utm_campaign: '456' }] });
  assert.equal(result.allocations.length, 0); assert.equal(result.coverage.ambiguous, 1);
});
test('partial acceptance uses accepted_amount, not the whole budget; drafts and invalid amounts are excluded', () => {
  assert.equal(calculate({ budgets: [{ ...budget, status: 'partially_accepted', accepted_amount: '25.01' }] }).allocations[0].amountCents, 2501);
  for (const status of ['draft', 'presented', 'rejected', 'cancelled']) assert.equal(calculate({ budgets: [{ ...budget, status }] }).allocations.length, 0);
  for (const accepted_amount of [null, '', -1, 'NaN']) assert.equal(calculate({ budgets: [{ ...budget, accepted_amount }] }).coverage.invalid, 1);
});
test('acceptance dates use the report window and Madrid calendar, with equal previous comparison', () => {
  const result = calculate({ budgets: [budget, { ...budget, id: '2', accepted_amount: '100', responded_at: '2026-09-01T12:00:00Z' },
    { ...budget, id: '3', responded_at: '2026-09-09T22:00:00Z' }] });
  const report = aggregateReport({ campaigns, period, budgetAttribution: result });
  assert.equal(report.current.accepted, 123.45); assert.equal(report.previous.accepted, 100);
  assert.equal(report.rows[0].current.accepted, 123.45); assert.equal(report.budgetAttribution.attributed, 2);
});
test('missing measurement remains null and a provider not supported by the evidence cannot become a false aggregate zero', () => {
  assert.equal(aggregateReport({ campaigns, period }).current.accepted, null);
  const meta = { ...campaigns[0], id: 'm1', provider: 'meta_ads' };
  const report = aggregateReport({ campaigns: [...campaigns, meta], period, budgetAttribution: { ...calculate(), supportedProviders: ['google_ads'] } });
  assert.equal(report.current.accepted, null); assert.equal(report.rows[1].current.accepted, null);
  assert.equal(report.rows[0].current.accepted, 123.45);
});
test('Meta accepted budgets require the server-verified account and campaign identity, never just the campaign name', () => {
  const meta = { ...campaigns[0], id: 'm1', provider: 'meta_ads' };
  const metaLead = { ...lead, source: 'meta_ads', advertising_identity: { version: 1, verified_by: 'meta_graph',
    provider: 'meta_ads', clinic_id: 1, account_id: '123', campaign_id: '456', ad_id: '789', page_id: '800', form_id: '900' } };
  const result = calculate({ campaigns: [meta], leads: [metaLead] });
  assert.equal(result.allocations[0].campaignId, 'm1'); assert.equal(result.allocations[0].amountCents, 12345);
  assert.equal(calculate({ campaigns: [meta], leads: [{ ...metaLead, advertising_identity: null, utm_campaign: '456' }] }).coverage.ambiguous, 1);
});
test('budget amounts are EUR even when advertising spend uses another or mixed currency', () => {
  const report = aggregateReport({ campaigns: [{ ...campaigns[0], currency: 'USD' }], period, budgetAttribution: calculate() });
  assert.equal(report.budgetAttribution.currency, 'EUR'); assert.equal(report.currency, 'USD');
  assert.equal(report.current.accepted, 123.45);
});
test('loader uses exact clinic-patient pairs, loads old linked leads, and never selects personal or treatment fields', async () => {
  const queries = [];
  const model = (name, rows) => ({ findAll: async options => { queries.push({ name, ...options }); return rows; } });
  const models = { EconomicBudget: model('budget', [budget]), CitaPaciente: model('appointment', [appointment]), LeadIntake: model('lead', [lead]) };
  const result = await loadBudgetCampaignAttribution({ models, campaigns, period });
  assert.equal(result.allocations.length, 1);
  assert.deepEqual(queries[1].where[Op.or], [{ clinica_id: 1, paciente_id: 10 }]);
  assert.equal(queries[1].where.created_at[Op.gte], undefined);
  assert.deepEqual(queries[2].where.clinica_id[Op.in], [1]);
  for (const query of queries) assert.ok(!query.attributes.some(field => ['nombre', 'email', 'telefono', 'lines', 'patient_snapshot'].includes(field)));
});
