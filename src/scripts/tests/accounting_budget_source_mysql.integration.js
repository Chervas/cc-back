'use strict';
// Real source resolver + canonical financial projection on an owned socket-only
// MySQL. Test identities and records are fictitious; no DEV/CRM/provider is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const S = require('sequelize'), D = S.DataTypes;
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const root = path.resolve(__dirname, '../../..');
const requireBack = createRequire(path.join(root, 'package.json'));
function load(file, overrides) {
  const local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, console, Date, Map, Set, Promise, Object, Buffer,
    __dirname: path.dirname(file), process: { env: {} },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name),
  }, { filename: file });
  return module.exports;
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? value instanceof Date ? value.toISOString() : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
  db.Sequelize = S;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
    datos_fiscales_clinica: D.JSON, configuracion: D.JSON, url_avatar: D.STRING, direccion: D.STRING,
    codigo_postal: D.STRING, ciudad: D.STRING, provincia: D.STRING, pais: D.STRING, grupoClinicaId: D.INTEGER,
  }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING,
    clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING, datos_fiscales: D.JSON,
  }, { tableName: 'Pacientes', timestamps: false });
  db.PacienteClinica = sql.define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER,
    clinica_id: D.INTEGER }, { tableName: 'PacientesClinicas', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER,
    clinica_id: D.INTEGER, voucher_id: D.BIGINT.UNSIGNED, estado: D.STRING, inicio: D.DATE,
  }, { tableName: 'CitasPacientes', timestamps: false });
  const modelFiles = ['economicbudget', 'economicbudgetversion', 'economicbudgetevent', 'economicbudgetsignaturerequest',
    'economicpayment', 'patientwalletentry', 'patientvoucher', 'patientvouchermovement', 'patientfiscaldocument',
    'cliniceconomictemplate', 'economicfundingpart', 'economicconceptadjustment', 'economicfiscalcoverage',
    'economicfiscalcommand', 'economicfiscalcounter', 'patientprogramsession', 'patientprogrambookingrequest',
    'treatmentprogram', 'treatmentprogramrevision', 'accesspolicyoverride', 'usuarioclinica',
    'accountingfirm', 'accountingfirmuser', 'accountingfirmclinicassignment'];
  for (const file of modelFiles) { const model = requireBack('./models/' + file)(sql, D); db[model.name] = model; }
  await sql.sync();
  await db.Clinica.bulkCreate([{ id_clinica: 100, nombre_clinica: 'Fictitious source clinic', configuracion: { timezone: 'Europe/Madrid' } },
    { id_clinica: 200, nombre_clinica: 'Other fictitious clinic' }]);
  await db.Paciente.bulkCreate([{ id_paciente: 11, public_id: 'fictitious-source-patient', clinica_id: 100, nombre: 'Fictitious', apellidos: 'Patient' },
    { id_paciente: 12, public_id: 'fictitious-second-patient', clinica_id: 100, nombre: 'Other', apellidos: 'Patient' },
    { id_paciente: 13, public_id: 'fictitious-foreign-patient', clinica_id: 200, nombre: 'Foreign', apellidos: 'Patient' }]);
  await db.UsuarioClinica.bulkCreate([{ id_usuario: 7, id_clinica: 100, rol_clinica: 'propietario' },
    { id_usuario: 8, id_clinica: 100, rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' },
    { id_usuario: 9, id_clinica: 100, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' },
    { id_usuario: 10, id_clinica: 100, rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros' },
    { id_usuario: 90, id_clinica: 100, rol_clinica: 'propietario' }]);
  await db.AccessPolicyOverride.bulkCreate([
    { scope_type: 'clinic', scope_id: 100, feature_key: 'billing.reports.view', role_code: 'doctor', effect: 'allow' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'patients.view', role_code: 'doctor', effect: 'deny' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'billing.reports.view', role_code: 'reception', effect: 'deny' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'patients.view', role_code: 'reception', effect: 'allow' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'billing.reports.view', role_code: 'assistant', effect: 'allow' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'patients.view', role_code: 'assistant', effect: 'allow' },
    { scope_type: 'clinic', scope_id: 100, feature_key: 'patients.sensitive.view', role_code: 'assistant', effect: 'deny' },
  ]);
  const firm = await db.AccountingFirm.create({ public_id: crypto.randomUUID(), scope_key: 'clinic:100', scope_type: 'clinic', primary_clinic_id: 100, name: 'Fictitious portal', active: true });
  await db.AccountingFirmUser.create({ firm_id: firm.id, user_id: 90, status: 'revoked' });
  // Only unrelated media/provider imports are suppressed. The resolver,
  // readBudgetForAccounting, getWorkspace, serializer and funding read are real.
  const economics = load(requireBack.resolve('./src/services/patientEconomics.service'), {
    '../../models': db, './whatsapp.service': {}, './treatmentPrograms.service': {},
    './clinicBranding.service': { resolveClinicAvatar: async () => ({ url: null }) },
  });
  const source = requireBack('./src/services/accountingBudgetSource.service').createService({ db, readBudget: economics.readBudgetForAccounting });
  let sequence = 0;
  async function budget({ clinic = 100, patient = 11, versions = 2 } = {}) {
    const row = await db.EconomicBudget.create({ public_id: crypto.randomUUID(), clinic_id: clinic, patient_id: patient,
      number: 'QA-SOURCE-' + ++sequence, status: 'accepted', current_version: versions, accepted_amount: versions * 121 });
    for (let version = 1; version <= versions; version++) {
      await db.EconomicBudgetVersion.create({ budget_id: row.id, version_number: version,
        lines: [{ key: 'original-line', name: version === 1 ? 'Original accepted concept' : 'Later head concept', product_type: 'treatment',
          accepted: true, quantity: 1, unit_price: version * 121, total: version * 121, base: version * 121, unit_label: 'sesión' }],
        totals: { currency: 'EUR', subtotal: version * 121, total: version * 121 }, payment_proposal: { mode: 'single', included_modes: ['single'] },
        design_config: {}, clinic_snapshot: { id: clinic, name: 'Fictitious clinic snapshot' }, patient_snapshot: { id: patient, name: 'Fictitious patient snapshot' },
        internal_notes: 'PRIVATE_INTERNAL_' + version, change_summary: 'PRIVATE_SUMMARY_' + version, created_by: 543, created_at: new Date(),
      });
      await db.EconomicBudgetEvent.create({ budget_id: row.id, version_number: version, event_type: 'accepted', from_status: 'presented', to_status: 'accepted',
        metadata: { accepted_amount: version * 121, selected_payment_mode: 'single', collection_method: 'transfer', accepted_line_keys: ['original-line'], private_review: 'PRIVATE_EVENT_' + version }, actor_id: 543, created_at: new Date() });
    }
    return row;
  }
  async function payment(b, values = {}) {
    return db.EconomicPayment.create({ public_id: crypto.randomUUID(), clinic_id: b?.clinic_id || 100, patient_id: b?.patient_id || 11,
      budget_id: b?.id || null, budget_version: b ? 1 : null, amount: 121, method: 'transfer', status: 'confirmed',
      application: { allocations: [{ target_type: b ? 'budget_line' : 'wallet', ...(b ? { line_key: 'original-line' } : {}), amount: 121 }] }, paid_at: new Date(), ...values });
  }
  async function document(b, pay = null, values = {}) {
    return db.PatientFiscalDocument.create({ public_id: crypto.randomUUID(), clinic_id: b?.clinic_id || pay?.clinic_id || 100,
      patient_id: b?.patient_id || pay?.patient_id || 11, budget_id: b?.id || null, payment_id: pay?.id || null,
      document_type: 'invoice', series: 'QA', number: 'QA-DOC-' + ++sequence, status: 'issued', issue_date: new Date(),
      issuer_snapshot: {}, recipient_snapshot: {}, lines: [], totals: { total: 121 }, template_snapshot: {},
      payment_data: b ? { source: { type: 'budget', id: b.public_id } } : pay ? { source: { type: 'payment', id: pay.public_id } } : {}, ...values });
  }
  async function coverage(doc, b, pay, version = 1, values = {}) {
    return db.EconomicFiscalCoverage.create({ id: crypto.randomUUID(), clinic_id: doc.clinic_id, patient_id: doc.patient_id, document_id: doc.id,
      document_version: 1, document_type: 'invoice', funding_key: 'payment:' + pay.public_id + ':0', source_kind: 'payment', payment_id: pay.id,
      budget_id: b.id, budget_version: version, line_key: 'original-line', amount: 121, taxable_base: 100, tax_amount: 21,
      status: 'issued', actor_id: 7, created_at: new Date(), ...values });
  }
  const modelEntries = Object.values(db).filter(model => model?.sequelize === sql && typeof model.findAll === 'function');
  async function snapshot() {
    return Object.fromEntries(await Promise.all(modelEntries.map(async model => [model.getTableName(), digest((await model.findAll({ raw: true })).map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))])));
  }
  const sqlReads = [];
  async function noWrites(work) {
    const before = await snapshot(), statements = [], old = sql.options.logging;
    sql.options.logging = statement => statements.push(statement.replace(/^(?:Executing|Executed) \([^)]*\):\s*/, ''));
    let result;
    try { result = await work(); }
    finally {
      sql.options.logging = old;
      assert.deepEqual(await snapshot(), before, 'A source read must preserve every table row and timestamp');
      assert.equal(statements.filter(statement => /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(statement.trim())).length, 0,
        'Canonical source reads must not persist derived funding or mutate financial data');
      sqlReads.push(statements.length);
    }
    return result;
  }
  const original = await budget(), paid = await payment(original), invoice = await document(original, paid);
  await coverage(invoice, original, paid);
  const result = await noWrites(() => source.read({ documentId: invoice.public_id, clinicId: 100 }));
  assert.equal(result.readonly, true); assert.equal(result.source.version, 1); assert.equal(result.source.budget_current_version, 2);
  assert.equal(result.source.version_origin, 'fiscal_coverage'); assert.equal(result.budget.current_version, 1);
  assert.equal(result.budget.current.lines[0].name, 'Original accepted concept'); assert.equal(result.budget.current.totals.total, 121);
  assert.equal(result.budget.current.internal_notes, null); assert.equal(result.budget.current.change_summary, null); assert.equal(result.budget.current.created_by, null);
  assert(result.budget.events.every(event => event.version === 1 && event.actor_id === null && !Object.hasOwn(event.metadata, 'private_review')));
  assert(!JSON.stringify(result).includes('PRIVATE_')); assert.equal(await db.EconomicFundingPart.count(), 0);
  report.checks.push('Native fiscal coverage pins version 1 while the budget head is version 2. The actual canonical financial reader preserves the original concept/price and redacts internal notes, change summaries, creator and nonfinancial event metadata; no funding row is persisted.');

  const fromPayment = await document(null, paid);
  const paymentView = await noWrites(() => source.read({ documentId: fromPayment.public_id, clinicId: 100 }));
  assert.equal(paymentView.source.version_origin, 'payment'); assert.equal(paymentView.source.budget_id, original.public_id); assert.equal(paymentView.source.version, 1);
  const fiscalOnly = await document(original, null, { payment_data: { source: { type: 'budget', id: original.public_id }, fiscal_price_source: { budget_version: 1 } } });
  assert.equal((await noWrites(() => source.read({ documentId: fiscalOnly.public_id, clinicId: 100 }))).source.version_origin, 'fiscal_price_source');
  const one = await budget({ patient: 12, versions: 1 }), single = await document(one);
  assert.equal((await noWrites(() => source.read({ documentId: single.public_id, clinicId: 100 }))).source.version_origin, 'single_stored_version');
  const deposit = await payment(null), standalone = await document(null, deposit);
  await assert.rejects(noWrites(() => source.read({ documentId: standalone.public_id, clinicId: 100 })), { code: 'accounting_budget_source_not_found' });
  const unknownVersion = await document(original);
  await assert.rejects(noWrites(() => source.read({ documentId: unknownVersion.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  report.checks.push('Payment, fiscal-price snapshot and a unique stored version resolve only through canonical relations. An unassigned deposit has no invented budget; a multiversion budget without a pinned origin returns an explicit review conflict.');

  const foreignPatient = await budget({ patient: 12 }), foreignClinic = await budget({ clinic: 200, patient: 13 });
  for (const b of [foreignPatient, foreignClinic]) {
    const wrong = await document(original, null, { budget_id: b.id });
    await assert.rejects(noWrites(() => source.read({ documentId: wrong.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  }
  const foreignPay = await payment(foreignPatient), wrongPayment = await document(original, foreignPay);
  await assert.rejects(noWrites(() => source.read({ documentId: wrongPayment.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  const otherDocument = await document(foreignClinic);
  await assert.rejects(noWrites(() => source.read({ documentId: otherDocument.public_id, clinicId: 100 })), { code: 'fiscal_document_not_found' });
  for (const invalidScope of [{ patient_id: 12 }, { clinic_id: 200 }]) {
    const badCoverage = await document(original, paid); await coverage(badCoverage, original, paid, 1, invalidScope);
    await assert.rejects(noWrites(() => source.read({ documentId: badCoverage.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  }
  const ambiguous = await document(original, paid); await coverage(ambiguous, original, paid, 1); await coverage(ambiguous, original, paid, 2);
  await assert.rejects(noWrites(() => source.read({ documentId: ambiguous.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  const changedMetadata = await document(original, paid, { payment_data: { source: { type: 'budget', id: foreignPatient.public_id } } });
  await assert.rejects(noWrites(() => source.read({ documentId: changedMetadata.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  const wrongPublicPayment = await document(null, paid, { payment_data: { source: { type: 'payment', id: deposit.public_id } } });
  await assert.rejects(noWrites(() => source.read({ documentId: wrongPublicPayment.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  const missingVersion = await document(original, null, { payment_data: { source: { type: 'budget', id: original.public_id }, fiscal_price_source: { budget_version: 99 } } });
  await assert.rejects(noWrites(() => source.read({ documentId: missingVersion.public_id, clinicId: 100 })), { code: 'accounting_budget_source_requires_review' });
  report.checks.push('Foreign document clinic, foreign budget patient/clinic, foreign payment, foreign coverage, conflicting pinned versions, altered public metadata and missing historical versions are rejected without selecting the latest version or writing anything.');

  // Native controller/router and actual AccessPolicy/portal membership lookups.
  const express = require('express'), access = requireBack('./src/lib/access-policy'), firms = requireBack('./src/services/accountingFirms.service');
  assert.equal(await access.canUserAccessFeature({ actorId: 7, clinicId: 100, featureKey: 'billing.reports.view' }), true);
  assert.equal(await access.canUserAccessFeature({ actorId: 8, clinicId: 100, featureKey: 'billing.reports.view' }), true);
  assert.equal(await access.canUserAccessFeature({ actorId: 8, clinicId: 100, featureKey: 'patients.view' }), false);
  assert.equal(await firms.isPortalUser({ actorId: 90 }), true);
  assert.equal(await access.canUserAccessFeature({ actorId: 10, clinicId: 100, featureKey: 'patients.sensitive.view' }), false);
  const controller = load(requireBack.resolve('./src/controllers/accounting.controller'), {
    '../services/accounting.service': { domainError: economics.domainError }, '../services/accountingFirms.service': firms,
    '../services/accountingIngestion.service': {}, '../services/accountingSepa.service': {}, '../services/accountingExport.service': {},
    '../services/accountingBudgetSource.service': source, '../lib/access-policy': access,
  });
  const router = load(requireBack.resolve('./src/routes/accounting.routes'), {
    '../controllers/accounting.controller': controller, './accountingDocumentPreview.routes': express.Router(),
    './auth.middleware': (req, res, next) => { const actor = Number(req.headers['x-owned-actor']); if (!Number.isSafeInteger(actor) || actor < 1) return res.sendStatus(401); req.userData = { userId: actor }; next(); },
  });
  const app = express(); app.use(router); app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: { code: error.code || 'owned_fixture_error' } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  registerOwnedLoopbackServer(server);
  const get = (id, clinic = 100, actor = 7) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/documents/' + id + '/source-budget?clinic_id=' + clinic,
      headers: actor ? { 'x-owned-actor': String(actor) } : {} }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() })); });
    request.on('error', reject); request.end();
  });
  try {
    const response = await noWrites(() => get(invoice.public_id)); assert.equal(response.status, 200); const body = JSON.parse(response.body);
    assert.equal(body.source.version, 1); assert.equal(body.budget.current.internal_notes, null); assert(!response.body.includes('PRIVATE_'));
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal((await noWrites(() => get(invoice.public_id, 100, 10))).status, 200, 'Financial source needs patient-view, not sensitive clinical permission');
    for (const actor of [8, 9, 90]) { const denied = await noWrites(() => get(invoice.public_id, 100, actor)); assert.equal(denied.status, 403); }
    assert.equal((await noWrites(() => get(invoice.public_id, 100, 0))).status, 401);
    assert.equal((await noWrites(() => get(invoice.public_id, 200))).status, 403);
    assert.equal((await noWrites(() => get(otherDocument.public_id))).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.checks.push('Native HTTP requires authentication, billing.reports.view AND patients.view in the exact clinic. A revoked portal identity stays denied despite owner membership. Real AccessPolicy override and portal rows are used, not mocked permission booleans; responses are private/no-store.');
  report.readOnlyQueries = { operations: sqlReads.length, totalStatements: sqlReads.reduce((sum, count) => sum + count, 0), dml: 0,
    allTableHashesUnchanged: true, canonicalReader: true, actualMysql: true };
}).catch(error => { console.error(error); process.exitCode = 1; });
