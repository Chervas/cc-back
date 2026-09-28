'use strict';

const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const now = new Date(); const day = 86400000;
  for (const file of ['economicbudget', 'economicbudgetversion', 'economicbudgetevent',
    'economicbudgetsignaturerequest', 'cliniceconomictemplate', 'patientvoucher']) {
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
  models.Clinica = sql.define('Clinica', {
    id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, nombre_clinica: DataTypes.STRING,
    grupoClinicaId: DataTypes.INTEGER, configuracion: DataTypes.JSON,
  }, { tableName: 'Clinicas', timestamps: false });
  models.Paciente = sql.define('Paciente', {
    id_paciente: { type: DataTypes.INTEGER, primaryKey: true }, clinica_id: DataTypes.INTEGER,
    public_id: DataTypes.STRING, nombre: DataTypes.STRING,
  }, { tableName: 'Pacientes', timestamps: false });
  models.PacienteClinica = sql.define('PacienteClinica', {
    paciente_id: DataTypes.INTEGER, clinica_id: DataTypes.INTEGER,
  }, { tableName: 'PacientesClinicas', timestamps: false });
  models.Tratamiento = sql.define('Tratamiento', {
    id_tratamiento: { type: DataTypes.INTEGER, primaryKey: true }, nombre: DataTypes.STRING,
    precio_base: DataTypes.DECIMAL(12, 2), origen: DataTypes.STRING, clinica_id: DataTypes.INTEGER,
    grupo_clinica_id: DataTypes.INTEGER, activo: DataTypes.BOOLEAN, clinical_config: DataTypes.JSON,
    eliminado_por_clinica: DataTypes.JSON,
  }, { tableName: 'Tratamientos', timestamps: false });
  for (const name of ['CitaPaciente', 'LeadIntake', 'LeadAttributionAudit', 'Clinica', 'Paciente',
    'PacienteClinica', 'Tratamiento']) await models[name].sync();
  await models.Clinica.create({ id_clinica: 901, nombre_clinica: 'QA FICTICIA', configuracion: {} });
  await models.Paciente.bulkCreate([10, 11].map(id_paciente => ({ id_paciente, clinica_id: 901, nombre: 'QA FICTICIO' })));
  const priceProfile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  await models.Tratamiento.bulkCreate([123.45, 500].map((precio_base, index) => ({
    id_tratamiento: index + 1, nombre: `Fixture treatment ${index + 1}`, precio_base, origen: 'clinica',
    clinica_id: 901, activo: true, clinical_config: { price_profile: priceProfile },
  })));

  // Real catalog, creation and acceptance services use only this owned SQL fixture.
  const whatsapp = require.resolve('../../services/whatsapp.service');
  require.cache[whatsapp] = { id: whatsapp, filename: whatsapp, loaded: true,
    exports: new Proxy({}, { get: () => { throw Error('MESSAGING_FORBIDDEN_IN_BUDGET_TRACE'); } }) };
  process.env.BUDGET_SIGNATURE_TOKEN_SECRET = 'isolated-budget-trace-test-only-not-a-live-credential';
  const { listCatalog, createBudget, transitionBudget, createBudgetSignatureRequest,
    signPublicBudgetSignatureRequest } = require('../../services/patientEconomics.service');
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

  const catalog = await listCatalog({ patientIdentifier: 10, clinicId: 901 });
  const lines = catalog.items.map((item, index) => ({ key: index === 0 ? 'one' : 'two',
    treatment_id: item.treatment_id, name: item.name, product_type: item.product_type,
    quantity: 1, unit_price: item.base_price }));
  assert.deepEqual(lines.map(line => line.unit_price), [123.45, 500]);
  let sequence = 0;
  const create = async (extra = {}) => {
    const n = ++sequence;
    const created = await createBudget({ patientIdentifier: extra.patient_id || 10, clinicId: 901, actorId: 1,
      payload: { lines, payment_proposal: { mode: 'single' }, source_reference: `trace-${n}`,
        status: extra.status || 'presented', ...extra.payload } });
    const budget = await models.EconomicBudget.findOne({ where: { public_id: created.id } });
    assert.equal(created.accepted_amount, 0);
    assert.equal(created.current.lines[0].price_snapshot.profile.tax_percent, 21);
    // Only fixture creation dates move to exercise old acquisition and prior-period acceptance.
    await budget.update({ created_at: new Date(+now - 65 * day) });
    return budget;
  };
  const read = async () => {
    const attribution = await loadBudgetCampaignAttribution({ models, campaigns: [campaign], period });
    return aggregateReport({ campaigns: [campaign], budgetAttribution: attribution, period, now: new Date(+now + day) });
  };
  const full = await create();
  await models.Tratamiento.update({ precio_base: 999 }, { where: {} });
  const accepted = await transitionBudget({ publicId: full.public_id, actorId: 1, action: 'accept' });
  assert.equal(accepted.accepted_amount, 623.45); assert.equal(accepted.status, 'accepted');
  assert.equal((await models.EconomicBudgetEvent.findOne({ where: { budget_id: full.id, event_type: 'accepted' } })).metadata.accepted_amount, 623.45);
  let result = await read();
  assert.equal(result.current.accepted, 623.45); assert.equal(result.rows[0].current.accepted, 623.45);
  assert.equal(result.budgetAttribution.attributed, 1); assert.equal(result.previous.accepted, 0);
  report.checks.push('real-acceptance-service-to-sql-to-campaign-kpi');
  report.checks.push('real-catalog-prices-to-budget-creation-and-frozen-tax-snapshot');
  report.checks.push('later-catalog-prices-do-not-reprice-accepted-budget');
  report.checks.push('old-lead-and-duplicate-appointments-count-budget-once');
  await assert.rejects(transitionBudget({ publicId: full.public_id, actorId: 1, action: 'accept' }), { code: 'budget_transition_not_allowed' });
  assert.equal(await models.EconomicBudgetEvent.count({ where: { budget_id: full.id, event_type: 'accepted' } }), 1);
  report.checks.push('repeated-acceptance-cannot-duplicate-audit-or-campaign-revenue');

  const beforeInvalid = await models.EconomicBudget.count();
  await assert.rejects(createBudget({ patientIdentifier: 10, clinicId: 901, actorId: 1,
    payload: { lines: [{ ...lines[0], treatment_id: 999 }] } }), { code: 'budget_treatment_unavailable' });
  assert.equal(await models.EconomicBudget.count(), beforeInvalid);
  report.checks.push('unavailable-treatment-rolls-back-budget-creation');

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
  assert.equal(JSON.stringify(result).includes('Fixture treatment'), false);
  assert.equal(JSON.stringify(result).includes(full.public_id), false);
  report.checks.push('campaign-report-exposes-aggregates-not-patient-or-treatment-data');

  const amountMismatches = [];
  const verifyAmount = (name, actual, expected) => {
    if (Number(actual) !== expected) amountMismatches.push({ name, actual: Number(actual), expected });
  };
  const signatureAccept = async (budget, options = {}) => {
    const request = await createBudgetSignatureRequest({ publicId: budget.public_id, actorId: 1,
      payload: { target: 'tablet', base_url: 'http://127.0.0.1', ...options } });
    const url = new URL(request.public_url);
    const token = decodeURIComponent(url.pathname.split('/').pop());
    assert.ok(token, 'Only the locally signed fictitious tablet link is used');
    await signPublicBudgetSignatureRequest(token, {
      accepted_statement: true, signature_data_url: 'data:image/png;base64,ZmFrZS1zaWduYXR1cmU=',
      selected_payment_mode: 'single', ...options,
    });
    const signed = await models.EconomicBudgetSignatureRequest.findOne({ where: { public_id: request.id } });
    const persisted = await models.EconomicBudget.findByPk(budget.id);
    assert.equal(signed.accepted_amount, persisted.accepted_amount);
    assert.equal(signed.status, 'signed');
    return models.EconomicBudget.findByPk(budget.id);
  };
  // Regression oracle: creation, manual acceptance and signature must agree on offered discounts.
  for (const signed of [false, true]) {
    for (const partial of [false, true]) {
      for (const paymentDiscount of [0, 5, 100]) {
        const budget = await create({ payload: { global_discount_percent: 10,
          payment_proposal: { mode: 'single', option_discounts: { single: paymentDiscount } } } });
        const selected = { ...(partial ? { request_type: 'accept_partial', accepted_line_keys: ['one'] } : {}), selected_payment_mode: 'single' };
        const actual = signed ? await signatureAccept(budget, selected)
          : await transitionBudget({ publicId: budget.public_id, actorId: 1,
            action: partial ? 'accept_partial' : 'accept', payload: selected });
        // 623.45 - 62.35 = 561.10; global allocation assigns 111.10 to the first line.
        const expected = paymentDiscount === 100 ? 0
          : partial ? (paymentDiscount ? 105.55 : 111.10) : (paymentDiscount ? 533.05 : 561.10);
        const name = `${signed ? 'signature' : 'manual'}-${partial ? 'partial' : 'full'}-payment-discount-${paymentDiscount}`;
        verifyAmount(name, actual.accepted_amount, expected);
        const event = await models.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id,
          event_type: partial ? 'partially_accepted' : 'accepted' } });
        verifyAmount(`${name}-audit`, event.metadata.accepted_amount, expected);
        const reportResult = await read();
        verifyAmount(`${name}-campaign-kpi`, reportResult.current.accepted, expected);
        verifyAmount(`${name}-campaign-row`, reportResult.rows[0].current.accepted, expected);
        if (!signed) verifyAmount(`${name}-financial-pending`, actual.financial_summary.pending, expected);
        await budget.update({ status: 'superseded' });
      }
    }
  }
  report.amountMismatches = amountMismatches;
  assert.deepEqual(amountMismatches, [], 'Accepted budget amount must match the offered global and payment discounts');
  report.checks.push('manual-and-signed-full-and-partial-discounted-amounts-agree');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
