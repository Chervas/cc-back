'use strict';

const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const now = new Date(); const day = 86400000;
  for (const file of ['economicbudget', 'economicbudgetversion', 'economicbudgetevent']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model; await model.sync();
  }
  models.CitaPaciente = sql.define('CitaPaciente', {
    id_cita: { type: DataTypes.INTEGER, primaryKey: true }, clinica_id: DataTypes.INTEGER, paciente_id: DataTypes.INTEGER,
    lead_intake_id: DataTypes.INTEGER, created_at: DataTypes.DATE, estado: DataTypes.STRING(30), es_provisional: DataTypes.BOOLEAN,
  }, { tableName: 'CitasPacientes', timestamps: false });
  models.LeadIntake = sql.define('LeadIntake', {
    id: { type: DataTypes.INTEGER, primaryKey: true }, clinica_id: DataTypes.INTEGER, source: DataTypes.STRING(30), channel: DataTypes.STRING(30),
    utm_source: DataTypes.STRING(100), utm_campaign: DataTypes.STRING(100), source_detail: DataTypes.STRING(100),
    google_ads_customer_id: DataTypes.STRING(32), google_ads_campaign_id: DataTypes.STRING(64),
    external_source: DataTypes.STRING(50), external_id: DataTypes.STRING(64), created_at: DataTypes.DATE,
  }, { tableName: 'LeadIntakes', timestamps: false });
  models.LeadAttributionAudit = sql.define('LeadAttributionAudit', {
    lead_intake_id: DataTypes.INTEGER, attribution_steps: DataTypes.JSON, raw_payload: DataTypes.JSON,
  }, { tableName: 'LeadAttributionAudits', timestamps: false });
  models.PatientVoucher = sql.define('PatientVoucher', {
    budget_id: DataTypes.BIGINT.UNSIGNED, activation_rule: DataTypes.STRING(30), status: DataTypes.STRING(30),
  }, { tableName: 'PatientVouchers', timestamps: false });
  for (const name of ['CitaPaciente', 'LeadIntake', 'LeadAttributionAudit', 'PatientVoucher']) await models[name].sync();

  // Acceptance is real service code; external messaging and catalog lookups cannot run in this fixture.
  const whatsapp = require.resolve('../../services/whatsapp.service');
  require.cache[whatsapp] = { id: whatsapp, filename: whatsapp, loaded: true,
    exports: new Proxy({}, { get: () => { throw Error('MESSAGING_FORBIDDEN_IN_BUDGET_TRACE'); } }) };
  models.Tratamiento = new Proxy({}, { get: () => { throw Error('CATALOG_LOOKUP_FORBIDDEN_IN_BUDGET_TRACE'); } });
  const { transitionBudget } = require('../../services/patientEconomics.service');
  const { loadBudgetCampaignAttribution } = require('../../services/campaignEconomicAttribution.service');
  const { reportPeriod, aggregateReport } = require('../../services/campaignWorkspaceReport.service');
  const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
  const period = reportPeriod(30, new Date(+now + day));
  const campaign = { provider: 'google_ads', account_id: '1234567890', campaign_id: '456', clinicId: 901, assigned: true, currency: 'EUR' };
  campaign.id = externalCampaignIdentityKey(campaign);
  await models.LeadIntake.create({ id: 20, clinica_id: 901, source: 'google_ads', channel: 'paid',
    google_ads_customer_id: campaign.account_id, google_ads_campaign_id: campaign.campaign_id, created_at: new Date(+now - 80 * day) });
  await models.CitaPaciente.bulkCreate([1, 2].map(id_cita => ({ id_cita, clinica_id: 901, paciente_id: 10,
    lead_intake_id: 20, created_at: new Date(+now - 70 * day), estado: 'confirmada', es_provisional: false })));

  let sequence = 0;
  const create = async (extra = {}) => {
    const n = ++sequence;
    const budget = await models.EconomicBudget.create({ public_id: `fixture-budget-${n}`, number: `TEST-${n}`, clinic_id: 901, patient_id: 10,
      status: 'presented', created_at: new Date(+now - 65 * day), ...extra });
    await models.EconomicBudgetVersion.create({ budget_id: budget.id, version_number: 1,
      lines: [{ key: 'one', product_type: 'treatment', name: 'Fixture one', total: 123.45 },
        { key: 'two', product_type: 'treatment', name: 'Fixture two', total: 500 }],
      totals: { total: 623.45 }, payment_proposal: { mode: 'single', included_modes: ['single'] },
      design_config: {}, clinic_snapshot: {}, patient_snapshot: {}, created_at: new Date(+now - 65 * day) });
    return budget;
  };
  const read = async () => {
    const attribution = await loadBudgetCampaignAttribution({ models, campaigns: [campaign], period });
    return aggregateReport({ campaigns: [campaign], budgetAttribution: attribution, period, now: new Date(+now + day) });
  };
  const full = await create();
  const accepted = await transitionBudget({ publicId: full.public_id, actorId: 1, action: 'accept' });
  assert.equal(accepted.accepted_amount, 623.45); assert.equal(accepted.status, 'accepted');
  assert.equal((await models.EconomicBudgetEvent.findOne({ where: { budget_id: full.id } })).metadata.accepted_amount, 623.45);
  let result = await read();
  assert.equal(result.current.accepted, 623.45); assert.equal(result.rows[0].current.accepted, 623.45);
  assert.equal(result.budgetAttribution.attributed, 1); assert.equal(result.previous.accepted, 0);
  report.checks.push('real-acceptance-service-to-sql-to-campaign-kpi');
  report.checks.push('old-lead-and-duplicate-appointments-count-budget-once');

  const partial = await create();
  const partialResult = await transitionBudget({ publicId: partial.public_id, actorId: 1, action: 'accept_partial', payload: { accepted_line_keys: ['one'] } });
  assert.equal(partialResult.accepted_amount, 123.45);
  const previousAt = new Date(+new Date(period.from) + day);
  // Only fixture dates move: this is not a live backdating capability.
  await partial.update({ responded_at: previousAt });
  await models.EconomicBudgetEvent.update({ created_at: previousAt }, { where: { budget_id: partial.id } });
  result = await read();
  assert.equal(result.current.accepted, 623.45); assert.equal(result.previous.accepted, 123.45);
  assert.equal(result.budgetAttribution.attributed, 2);
  report.checks.push('partial-acceptance-and-equal-previous-period');

  const rejected = await create(); await transitionBudget({ publicId: rejected.public_id, actorId: 1, action: 'reject' });
  const draft = await create({ status: 'draft' });
  assert.equal((await read()).current.accepted, 623.45);
  assert.equal((await models.EconomicBudget.findByPk(draft.id)).accepted_amount, '0.00');
  report.checks.push('draft-and-rejected-budgets-not-estimated-as-revenue');

  const broken = await create(); const writeEvent = models.EconomicBudgetEvent.create.bind(models.EconomicBudgetEvent);
  models.EconomicBudgetEvent.create = async () => { throw Error('acceptance_audit_failed'); };
  try { await assert.rejects(transitionBudget({ publicId: broken.public_id, actorId: 1, action: 'accept' }), /acceptance_audit_failed/); }
  finally { models.EconomicBudgetEvent.create = writeEvent; }
  assert.equal((await models.EconomicBudget.findByPk(broken.id)).status, 'presented');
  assert.equal((await models.EconomicBudget.findByPk(broken.id)).accepted_amount, '0.00');
  assert.equal((await read()).current.accepted, 623.45);
  report.checks.push('failed-acceptance-audit-rolls-back-amount-and-status');

  await models.LeadIntake.create({ id: 21, clinica_id: 901, source: 'web', channel: 'paid',
    google_ads_customer_id: campaign.account_id, google_ads_campaign_id: campaign.campaign_id, created_at: new Date(+now - 80 * day) });
  await models.CitaPaciente.create({ id_cita: 3, clinica_id: 901, paciente_id: 11, lead_intake_id: 21,
    created_at: new Date(+now - 70 * day), estado: 'confirmada', es_provisional: false });
  const unverified = await create({ patient_id: 11 });
  await transitionBudget({ publicId: unverified.public_id, actorId: 1, action: 'accept' });
  result = await read(); assert.equal(result.current.accepted, 623.45); assert.equal(result.budgetAttribution.ambiguous, 1);
  report.checks.push('legacy-web-report-ids-do-not-authorize-economic-attribution');

  await full.update({ status: 'superseded' });
  result = await read(); assert.equal(result.current.accepted, 0); assert.equal(result.previous.accepted, 123.45);
  report.checks.push('superseded-acceptance-not-counted-as-current-budget');
  assert.ok(Object.keys(result.budgetAttribution).every(key => !/patient|treatment|line|name|email|phone/i.test(key)));
  assert.equal(JSON.stringify(result).includes('Fixture one'), false);
  assert.equal(JSON.stringify(result).includes(full.public_id), false);
  report.checks.push('campaign-report-exposes-aggregates-not-patient-or-treatment-data');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
