'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
function load(file, overrides) {
  const local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, Object, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  return module.exports;
}
const json = value => JSON.parse(JSON.stringify(value));
withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
  const S = require('sequelize'), D = S.DataTypes; db.Sequelize = S;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING, datos_fiscales_clinica: D.JSON, configuracion: D.JSON, url_avatar: D.STRING, direccion: D.STRING, codigo_postal: D.STRING, ciudad: D.STRING, provincia: D.STRING, pais: D.STRING }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING, datos_fiscales: D.JSON }, { tableName: 'Pacientes', timestamps: false });
  db.PacienteClinica = sql.define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, { tableName: 'PacientesClinicas', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER, voucher_id: D.BIGINT.UNSIGNED, tratamiento_id: D.INTEGER,
    estado: D.STRING, inicio: D.DATE, fin: D.DATE, es_provisional: D.BOOLEAN, care_schedule_start: D.DATE, arrived_at: D.DATE, care_started_at: D.DATE, care_completed_at: D.DATE, care_legacy_attendance: D.BOOLEAN }, { tableName: 'CitasPacientes', timestamps: false });
  for (const file of ['patientvoucher','patientvouchermovement','economicbudget','economicbudgetversion','economicbudgetevent','economicpayment','patientwalletentry','patientfiscaldocument','cliniceconomictemplate','accountingcashmovement','accountingexpensedocument','accountingcashsession','accountingcashclosure']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  await sql.sync();
  const migration = require('../../../migrations/20261025110000-economic-concept-adjustments-fiscal-coverage');
  await migration.up(sql.getQueryInterface(), S); await migration.up(sql.getQueryInterface(), S);
  for (const file of ['economicfundingpart','economicconceptadjustment','economicfiscalcoverage','economicfiscalcommand','economicfiscalcounter']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  await db.Clinica.bulkCreate([{ id_clinica: 100, nombre_clinica: 'Clínica sintética', datos_fiscales_clinica: { cif: 'QA000000A', direccion: 'Calle ficticia', codigo_postal: '00000', ciudad: 'QA' } }, { id_clinica: 200, nombre_clinica: 'Otra clínica' }]);
  await db.Paciente.bulkCreate(Array.from({ length: 18 }, (_, i) => ({ id_paciente: i + 1, clinica_id: i === 17 ? 200 : 100, nombre: 'QA', apellidos: 'Paciente ' + i })));
  const monolith = load(require.resolve('../../services/patientEconomics.service'), { '../../models': db, './whatsapp.service': {}, './treatmentPrograms.service': {}, './clinicBranding.service': { resolveClinicAvatar: async () => ({ url: null }) } });
  const funding = require('../../services/economicFunding.service').createService({ db });
  const concepts = require('../../services/economicConcepts.service').createService({ db, canAccess: async ({ actorId, clinicId }) => actorId < 3 && clinicId === 100, rectify: monolith.rectifyEconomicCancellation });
  const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  async function budget(patientId, { quantity = 3, total = 363, extra = [], voucher = false, program = false } = {}) {
    const b = await db.EconomicBudget.create({ public_id: crypto.randomUUID(), patient_id: patientId, clinic_id: patientId === 18 ? 200 : 100, status: 'accepted', current_version: 1, number: 'QA-' + patientId, accepted_amount: total + extra.reduce((n, x) => n + x.total, 0) });
    const line = { key: 'main', name: 'Concepto QA', treatment_id: 1, product_type: voucher ? 'voucher' : 'treatment', quantity, entitlement_units: quantity, unit_price: total / quantity, total, accepted: true,
      price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: 1 }, profile }, ...(program ? { program_snapshot: { kind: 'program', appointments: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] } } : {}) };
    await db.EconomicBudgetVersion.create({ budget_id: b.id, version_number: 1, lines: [line, ...extra], totals: { total: Number(b.accepted_amount) }, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
    await db.EconomicBudgetEvent.create({ budget_id: b.id, version_number: 1, event_type: 'accepted', to_status: 'accepted', metadata: { accepted_line_keys: ['main', ...extra.map(row => row.key)], accepted_amount: Number(b.accepted_amount) }, created_at: new Date() });
    if (voucher) await db.PatientVoucher.create({ public_id: crypto.randomUUID(), clinic_id: b.clinic_id, patient_id: patientId, budget_id: b.id, budget_line_key: 'main', treatment_id: 1, name: 'Bono QA', total_units: quantity, available_units: quantity, sold_amount: total, status: 'active', activation_rule: 'on_acceptance' });
    return b;
  }
  async function pay(b, amount, options = {}) {
    return db.EconomicPayment.create({ public_id: crypto.randomUUID(), clinic_id: b.clinic_id, patient_id: b.patient_id, budget_id: b.id, budget_version: 1, amount, method: 'cash', status: 'confirmed', paid_at: new Date(), application: { allocations: [{ target_type: options.generic ? 'budget' : options.wallet ? 'wallet' : 'budget_line', ...(options.generic || options.wallet ? {} : { line_key: 'main' }), amount }] } });
  }
  const fiscalInput = (b, source, kind, key = crypto.randomUUID(), amount) => ({ patientIdentifier: b.patient_id, clinicId: b.clinic_id, actorId: 1, payload: { source_type: source.type, source_id: source.id, document_type: kind, status: 'issued', idempotency_key: key, ...(amount ? { source_amount: amount } : {}), issuer: { legal_name: 'Clínica QA', tax_id: 'QA', address: 'Calle QA', postal_code: '00000', city: 'QA', country: 'España' }, recipient: { legal_name: 'Paciente QA', tax_id: 'QA2', address: 'Calle QA2', postal_code: '00000', city: 'QA', country: 'España' } } });
  const fiscal = input => monolith.createPatientFiscalDocument(input);
  const counts = async () => Object.fromEntries(await Promise.all(['EconomicPayment','PatientWalletEntry','EconomicConceptAdjustment','EconomicFiscalCoverage','EconomicFiscalCommand','PatientFiscalDocument','EconomicBudgetEvent','PatientVoucherMovement'].map(async key => [key, await db[key].count()])));
  // Different routes see the same canonical funding; receipt and invoice are independent.
  const b = await budget(1), p = await pay(b, 363), receiptInput = fiscalInput(b, { type: 'payment', id: p.public_id }, 'receipt');
  const receiptBoth = await Promise.all([fiscal(receiptInput), fiscal(receiptInput)]);
  assert.equal(receiptBoth.filter(row => row.replayed).length, 1); assert.match(receiptBoth[0].number, /^REC-\d{4}-0001$/);
  const invoiceInput = fiscalInput(b, { type: 'budget', id: b.public_id }, 'invoice'), invoice = await fiscal(invoiceInput);
  assert.match(invoice.number, /^FAC-\d{4}-0001$/); assert.equal(invoice.totals.total, 363); assert.equal(invoice.totals.taxable_base, 300); assert.equal(invoice.totals.taxes, 63);
  await assert.rejects(fiscal(fiscalInput(b, { type: 'payment', id: p.public_id }, 'invoice')), { code: 'fiscal_source_amount_exceeded' });
  await assert.rejects(fiscal(fiscalInput(b, { type: 'budget', id: b.public_id }, 'receipt')), { code: 'fiscal_source_amount_exceeded' });
  const data = await funding.load({ clinicId: 100, patientId: 1 }), summary = funding.fiscalSummary(data.parts, data);
  assert.equal(summary.invoice.documented, 363); assert.equal(summary.receipt.documented, 363); assert.equal(summary.invoice.remaining, 0); assert.equal(summary.receipt.remaining, 0);
  assert.equal((await db.PatientFiscalDocument.findOne({ where: { public_id: receiptBoth[0].id } })).number, receiptBoth[0].number);
  report.checks.push('Receipt owns REC sequence and exact concurrent replay. Invoice after receipt covers the same real cash independently; budget/payment aliases cannot duplicate either kind. Reprint preserves number.');
  // Different patients share one clinic sequence despite their earlier RR snapshots.
  const bs = await Promise.all([budget(2), budget(3)]); const ps = await Promise.all(bs.map(row => pay(row, 121)));
  const docs = await Promise.all(bs.map((row, i) => fiscal(fiscalInput(row, { type: 'payment', id: ps[i].public_id }, 'receipt'))));
  assert.equal(new Set(docs.map(row => row.number)).size, 2); assert.deepEqual(docs.map(row => Number(row.number.slice(-4))).sort(), [2, 3]);
  // Unpaid and manual patient routes never create fiscal documents, even with forged lines.
  const unpaid = await budget(4), beforeUnpaid = await counts();
  await assert.rejects(fiscal(fiscalInput(unpaid, { type: 'budget', id: unpaid.public_id }, 'invoice')), { code: 'fiscal_source_amount_exceeded' });
  await assert.rejects(fiscal({ ...fiscalInput(unpaid, { type: 'manual', id: 'manual' }, 'invoice'), payload: { ...fiscalInput(unpaid, { type: 'manual', id: 'manual' }, 'invoice').payload, lines: [{ total: 1000 }] } }), { code: 'fiscal_paid_source_required' });
  await assert.rejects(monolith.createFiscalDocument({ publicId: unpaid.public_id, actorId: 1, payload: fiscalInput(unpaid, { type: 'budget', id: unpaid.public_id }, 'invoice').payload }), { code: 'fiscal_source_amount_exceeded' });
  assert.deepEqual(await counts(), beforeUnpaid);
  report.checks.push('Clinic sequence remains unique across concurrent patients under MySQL REPEATABLE READ; unpaid/manual and legacy budget route cannot fabricate a patient invoice.');
  // Draft CAS is durable; reserved coverage is pending, not documented.
  const bd = await budget(5), pd = await pay(bd, 121), draftInput = fiscalInput(bd, { type: 'payment', id: pd.public_id }, 'invoice'); draftInput.payload.status = 'draft';
  const draft = await fiscal(draftInput), dfacts = await funding.load({ clinicId: 100, patientId: 5 }), ds = funding.fiscalSummary(dfacts.parts, dfacts);
  assert.equal(ds.invoice.reserved, 121); assert.equal(ds.invoice.undocumented, 121); assert.equal(ds.invoice.documented, 0); assert.equal(ds.invoice.remaining, 0);
  const update = { publicId: draft.id, actorId: 1, payload: { expected_version: 1, idempotency_key: crypto.randomUUID(), status: 'issued', issuer: draftInput.payload.issuer, recipient: draftInput.payload.recipient } };
  const updatedBoth = await Promise.all([monolith.updateFiscalDocument(update), monolith.updateFiscalDocument(update)]);
  assert.equal(updatedBoth.filter(row => row.replayed).length, 1); assert.equal(updatedBoth[0].version, 2); assert.equal(updatedBoth[0].number, draft.number);
  await assert.rejects(monolith.updateFiscalDocument({ ...update, payload: { ...update.payload, idempotency_key: crypto.randomUUID() } }), error => error.code === 'fiscal_document_version_conflict' && error.details.applied === false);
  await assert.rejects(fiscal({ ...fiscalInput(bd, { type: 'payment', id: p.public_id }, 'receipt'), clinicId: 200 }), { code: 'patient_not_in_clinic' });
  report.checks.push('Fiscal draft reservations, document CAS and exact replay preserve same number; stale command is definitively unapplied; foreign clinic/patient sources fail.');
  // Unpaid cancellation + full history retained, and exact concurrent cancellation applies once.
  const bc = await budget(6, { voucher: true }), cbase = { expected_version: 1, units: 1, settlement: 'none', reason: 'No realizará la sesión' };
  const cq = await concepts.cancellationPreview({ publicId: bc.public_id, lineKey: 'main', actorId: 1, payload: cbase }); assert.equal(cq.can_confirm, true); assert.equal(cq.cancelled_amount, 121);
  const action = { publicId: bc.public_id, lineKey: 'main', actorId: 1, payload: { ...cbase, expected_concept_revision: cq.concept_revision, preview_hash: cq.preview_hash, confirmed: true, idempotency_key: crypto.randomUUID() } };
  const cboth = await Promise.all([concepts.cancel(action), concepts.cancel(action)]); assert.equal(cboth.filter(row => row.replayed).length, 1);
  assert.equal(Number((await db.PatientVoucher.findOne({ where: { budget_id: bc.id } })).available_units), 2); assert.equal(Number((await bc.reload()).accepted_amount), 363);
  await assert.rejects(concepts.cancel({ ...action, payload: { ...action.payload, idempotency_key: crypto.randomUUID() } }), error => error.code === 'concept_revision_conflict' && error.details.applied === false);
  await assert.rejects(concepts.cancel({ ...action, actorId: 2 }), { code: 'economic_request_conflict' });
  await assert.rejects(concepts.cancel({ ...action, actorId: 3 }), { code: 'access_policy_forbidden' });
  report.checks.push('Unpaid concept cancellation changes only immutable adjustment and available sessions, keeping accepted quote unchanged; concurrent exact command writes once, stale CAS/actor tamper reject.');
  // A real cash refund rectifies the already-issued invoice, without voiding it or the receipt.
  const refundBase = { expected_version: 1, units: 1, settlement: 'refund', refund_method: 'cash', reason: 'Devolución manual confirmada' };
  const rq = await concepts.cancellationPreview({ publicId: b.public_id, lineKey: 'main', actorId: 1, payload: refundBase }); assert.equal(rq.refund_amount, 121); assert.equal(rq.requires_credit_note, true); assert.equal(rq.can_confirm, true);
  const refundInput = { publicId: b.public_id, lineKey: 'main', actorId: 1, payload: { ...refundBase, expected_concept_revision: rq.concept_revision, preview_hash: rq.preview_hash, confirmed: true, idempotency_key: crypto.randomUUID() } };
  const returned = await concepts.cancel(refundInput); assert.equal(returned.credit_notes.length, 1); assert.equal(returned.credit_notes[0].totals.total, -121); assert.equal(returned.credit_notes[0].totals.taxable_base, -100);
  assert.equal((await db.PatientFiscalDocument.findOne({ where: { public_id: invoice.id } })).status, 'issued'); assert.equal((await db.EconomicPayment.findByPk(p.id)).status, 'confirmed');
  const rdata = await funding.load({ clinicId: 100, patientId: 1 }), rs = funding.fiscalSummary(rdata.parts, rdata);
  assert.equal(rs.invoice.amount, 242); assert.equal(rs.invoice.documented, 242); assert.equal(rs.invoice.remaining, 0);
  await assert.rejects(monolith.voidPayment({ publicId: p.public_id, actorId: 1, payload: { reason: 'No borrar historial' } }), { code: 'payment_fiscal_rectification_required' });
  assert.equal((await concepts.cancel(refundInput)).replayed, true);
  report.checks.push('Paid cancellation records one manual refund, one linked signed-coverage rectificativa and one immutable adjustment atomically; original cash, receipt and invoice remain issued/readable and replay causes no second return.');
  // Explicit wallet credit and audit rollback.
  const bw = await budget(7, { voucher: true }); await pay(bw, 363); const wb = { expected_version: 1, units: 1, settlement: 'wallet_credit', reason: 'Conservar como saldo' };
  const wq = await concepts.cancellationPreview({ publicId: bw.public_id, lineKey: 'main', actorId: 1, payload: wb }), wi = { publicId: bw.public_id, lineKey: 'main', actorId: 1, payload: { ...wb, expected_concept_revision: 0, preview_hash: wq.preview_hash, confirmed: true, idempotency_key: crypto.randomUUID() } };
  const beforeRollback = await counts(); db.EconomicBudgetEvent.addHook('beforeCreate', 'fail-cancel-audit', row => { if (row.event_type === 'concept_cancelled') throw Error('OWNED_AUDIT_FAILURE'); });
  try { await assert.rejects(concepts.cancel(wi), /OWNED_AUDIT_FAILURE/); } finally { db.EconomicBudgetEvent.removeHook('beforeCreate', 'fail-cancel-audit'); }
  assert.deepEqual(await counts(), beforeRollback); assert.equal(Number((await db.PatientVoucher.findOne({ where: { budget_id: bw.id } })).available_units), 3);
  const credited = await concepts.cancel(wi); assert.equal(credited.wallet_credit_amount, 121); assert.equal(Number(await db.PatientWalletEntry.sum('amount', { where: { clinic_id: 100, patient_id: 7, status: 'confirmed' } })), 121);
  report.checks.push('Wallet-credit settlement is explicit and a journal failure rolls back credit, voucher balance, movement and adjustment; exact retry succeeds once.');
  // Generic historic cash is never apportioned by order or proportion, but explicit generic collection can complete payment.
  const legacy = await budget(8, { extra: [{ key: 'other', name: 'Otro concepto', treatment_id: 1, quantity: 1, total: 121, accepted: true, price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: 1 }, profile } }] }); await pay(legacy, 100, { generic: true });
  const legacyState = await concepts.bookingSource({ publicId: legacy.public_id, lineKey: 'main', actorId: 1 }); assert.equal(legacyState.progress.financial.paid, null); assert.equal(legacyState.progress.financial.attribution, 'unassigned'); assert.equal(legacyState.progress.can_cancel, false);
  await assert.rejects(concepts.paymentPreview({ publicId: legacy.public_id, actorId: 1, payload: { expected_version: 1, lines: [{ line_key: 'main' }] } }), { code: 'payment_attribution_review_required' });
  const generic = await concepts.paymentPreview({ publicId: legacy.public_id, actorId: 1, payload: { expected_version: 1, generic: true, amount: 384 } }); assert.equal(generic.total, 384); assert.equal(generic.attribution, 'unassigned'); assert.equal(generic.allocations[0].target_type, 'budget');
  const cashInput = { publicId: legacy.public_id, actorId: 1, payload: { expected_version: 1, idempotency_key: crypto.randomUUID(), generic: true, amount: generic.total, method: 'cash', allocations: generic.allocations } };
  const cashBoth = await Promise.all([monolith.createPayment(cashInput), monolith.createPayment(cashInput)]); assert.equal(cashBoth.filter(row => row.replayed).length, 1);
  assert.equal((await concepts.bookingSource({ publicId: legacy.public_id, lineKey: 'main', actorId: 1 })).progress.financial.paid, null);
  await assert.rejects(concepts.paymentPreview({ publicId: bc.public_id, actorId: 1, payload: { expected_version: 1, generic: true, amount: 1 } }), { code: 'payment_generic_not_required' });
  report.checks.push('Generic legacy multi-concept and partial cash remain explicitly unassigned with nullable concept facts; no cancellation/refund inference. Opt-in generic collection uses authoritative total pending and exact replay, without redistributing earlier money.');
  // Performed care and actual reservations consume distinct progress; clinical rows never altered.
  const bp = await budget(9, { voucher: true }); const vp = await db.PatientVoucher.findOne({ where: { budget_id: bp.id } });
  const start = new Date('2025-01-01T10:00:00Z'); const care = await db.CitaPaciente.create({ paciente_id: 9, clinica_id: 100, voucher_id: vp.id, tratamiento_id: 1, estado: 'completada', inicio: start, fin: new Date(start.getTime() + 3600000), care_schedule_start: start, arrived_at: start, care_started_at: start, care_completed_at: start });
  await db.PatientVoucherMovement.create({ voucher_id: vp.id, movement_type: 'consumption', units: -1, appointment_id: care.id_cita, occurred_at: start }); await vp.update({ available_units: 2 });
  await db.CitaPaciente.create({ paciente_id: 9, clinica_id: 100, voucher_id: vp.id, tratamiento_id: 1, estado: 'confirmada', inicio: new Date('2030-01-01T10:00:00Z'), fin: new Date('2030-01-01T11:00:00Z') });
  const ps9 = (await concepts.bookingSource({ publicId: bp.public_id, lineKey: 'main', actorId: 1 })).progress; assert.equal(ps9.used, 1); assert.equal(ps9.reserved, 1); assert.equal(ps9.pending, 1);
  const cannot = await concepts.cancellationPreview({ publicId: bp.public_id, lineKey: 'main', actorId: 1, payload: { ...cbase, units: 2 } }); assert.equal(cannot.can_confirm, false);
  const pg = await budget(10, { program: true }); const pgq = await concepts.cancellationPreview({ publicId: pg.public_id, lineKey: 'main', actorId: 1, payload: cbase }); assert.equal(pgq.can_confirm, false); assert.match(pgq.reason, /valoración explícita/);
  const foreign = await budget(18); await assert.rejects(concepts.cancellationPreview({ publicId: foreign.public_id, lineKey: 'main', actorId: 1, payload: cbase }), { code: 'access_policy_forbidden' });
  report.checks.push('Performed native care/consumption counted once; active reservations protected; heterogeneous program partial price requires valuation, and foreign clinic ACL rejects. No clinical appointment or accepted snapshot is erased.');
  const depositBudget = await budget(11), deposit = await pay(depositBudget, 100, { wallet: true }); await deposit.update({ budget_id: null, budget_version: null });
  await db.PatientWalletEntry.create({ public_id: crypto.randomUUID(), clinic_id: 100, patient_id: 11, payment_id: deposit.id, entry_type: 'deposit', amount: 100, occurred_at: new Date() });
  await monolith.applyWallet({ publicId: depositBudget.public_id, actorId: 1, payload: { amount: 100 } });
  await fiscal(fiscalInput(depositBudget, { type: 'budget', id: depositBudget.public_id }, 'invoice'));
  await assert.rejects(monolith.voidPayment({ publicId: deposit.public_id, actorId: 1, payload: { reason: 'Anticipo ya utilizado' } }), { code: 'payment_wallet_already_applied' });
  assert.equal((await db.EconomicPayment.findByPk(deposit.id)).status, 'confirmed');
  const bl = await budget(12), pl = await pay(bl, 121);
  await db.PatientFiscalDocument.create({ public_id: crypto.randomUUID(), clinic_id: 100, patient_id: 12, budget_id: bl.id, payment_id: pl.id, document_type: 'invoice', series: 'OLD', number: 'OLD-1', status: 'issued', issue_date: new Date(), issuer_snapshot: {}, recipient_snapshot: {}, lines: [], totals: { total: 121 }, template_snapshot: {} });
  const ld = await funding.load({ clinicId: 100, patientId: 12 }), ls = funding.fiscalSummary(ld.parts, ld);
  assert.equal(ls.invoice.review_required, true); assert.equal(ls.invoice.documented, null); assert.equal(ls.invoice.remaining, 0); assert.equal(ls.invoice.documents[0].coverage_unknown, true);
  await assert.rejects(fiscal(fiscalInput(bl, { type: 'payment', id: pl.public_id }, 'invoice')), { code: 'fiscal_legacy_coverage_review_required' });
  report.checks.push('A wallet deposit already applied and invoiced cannot be voided into a negative balance. Historical issued documents retain references and expose unknown coverage/review instead of a false uninvoiced amount.');
  const centBudget = await budget(16), centQuote = await concepts.paymentPreview({ publicId: centBudget.public_id, actorId: 1, payload: { expected_version: 1, lines: [{ line_key: 'main' }] } });
  await assert.rejects(monolith.createPayment({ publicId: centBudget.public_id, actorId: 1, payload: { amount: 363, method: 'cash', allocations: centQuote.allocations, idempotency_key: crypto.randomUUID() } }), { code: 'budget_version_required' });
  await assert.rejects(monolith.createPayment({ publicId: centBudget.public_id, actorId: 1, payload: { expected_version: 1, amount: 363.01, method: 'cash', allocations: [{ target_type: 'budget_line', line_key: 'main', amount: 363.01 }], idempotency_key: crypto.randomUUID() } }), { code: 'payment_exceeds_budget_line_pending' });
  const raceBudget = await budget(13), raceCash = await pay(raceBudget, 121);
  const competing = await Promise.allSettled([fiscal(fiscalInput(raceBudget, { type: 'payment', id: raceCash.public_id }, 'invoice')), fiscal(fiscalInput(raceBudget, { type: 'budget', id: raceBudget.public_id }, 'invoice'))]);
  assert.equal(competing.filter(row => row.status === 'fulfilled').length, 1); assert.equal(competing.find(row => row.status === 'rejected').reason.code, 'fiscal_source_amount_exceeded');
  const journalBudget = await budget(14), journalCash = await pay(journalBudget, 121), ji = fiscalInput(journalBudget, { type: 'payment', id: journalCash.public_id }, 'receipt'), beforeJournal = await counts();
  db.EconomicFiscalCommand.addHook('beforeCreate', 'fail-fiscal-journal', () => { throw Error('OWNED_FISCAL_JOURNAL_FAILURE'); });
  try { await assert.rejects(fiscal(ji), /OWNED_FISCAL_JOURNAL_FAILURE/); } finally { db.EconomicFiscalCommand.removeHook('beforeCreate', 'fail-fiscal-journal'); }
  assert.deepEqual(await counts(), beforeJournal); const recoveredJournal = await fiscal(ji); assert(recoveredJournal.number); assert.equal((await fiscal(ji)).replayed, true);
  const sharedA = await budget(15, { voucher: true }), sharedB = await budget(15, { voucher: true });
  const sharedVoucher = await db.PatientVoucher.findOne({ where: { budget_id: sharedB.id } }); await sharedVoucher.update({ available_units: 2 });
  await db.PatientVoucherMovement.create({ voucher_id: sharedVoucher.id, movement_type: 'consumption', units: -1, occurred_at: new Date() });
  const ws = await concepts.workspace({ clinicId: 100, patientId: 15, workspace: { budgets: [sharedA, sharedB].map(row => ({ id: row.public_id, status: 'accepted', current: { lines: [{ key: 'main' }] }, financial_summary: { payable: 363, paid: 0 } })), payments: [], vouchers: [], wallet: { entries: [] } } });
  assert.equal(ws.budgets[0].current.lines[0].progress.used, 0); assert.equal(ws.budgets[1].current.lines[0].progress.used, 1); assert.equal(ws.budgets[1].current.lines[0].progress.fulfillment_voucher_id, sharedVoucher.public_id);
  const accounting = load(require.resolve('../../services/accounting.service'), { '../../models': db, './clinicalPrivateStorage.service': {}, './patientEconomics.service': monolith });
  const cashState = await accounting.getCashWorkspace({ clinicId: 100, query: { business_date: new Date().toISOString().slice(0, 10) } });
  assert.equal(cashState.current.patient_refunds, 121); assert.equal(cashState.current.cash_outflows, 121); assert.equal(cashState.movements.filter(row => row.source_type === 'concept_refund').length, 1); assert.equal(await db.AccountingCashMovement.count(), 0);
  report.checks.push('Different request keys through budget/payment routes race for one fiscal balance; only one issues. Fiscal journal failure rolls back doc/coverage/counter. Same line key across two budgets never mixes vouchers. Cash projects the immutable refund once without fabricating another cash movement.');
  // Real route/controller and real funded services, with an explicit synthetic ACL/auth boundary.
  const express = require('express');
  const controller = load(require.resolve('../../controllers/patientEconomics.controller'), { '../../models': db, '../services/patientEconomics.service': monolith,
    '../services/economicDocumentPdf.service': {}, '../services/patientVoucherAppointments.service': {}, '../services/patientProgramBooking.service': {},
    '../services/accountingFirms.service': { isPortalUser: async ({ actorId }) => actorId === 9 },
    '../services/economicConcepts.service': concepts,
    '../lib/access-policy': { getAccessibleClinicIdsForFeature: async ({ actorId, featureKey, clinicIds }) => actorId === 1 || actorId === 2 && featureKey === 'patients.view' ? clinicIds.filter(id => id === 100) : [] } });
  const router = load(require.resolve('../../routes/patientEconomics.routes'), { '../controllers/patientEconomics.controller': controller,
    './auth.middleware': (req, _res, next) => { req.userData = { userId: Number(req.headers['x-owned-actor'] || 1) }; next(); } });
  const app = express(); app.use(express.json()); app.use('/api/economics', router); app.use((error, _req, res, _next) => res.status(500).json({ error: { code: 'internal_error' } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); registerOwnedLoopbackServer(server);
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/economics';
  async function http(path, body, actor = 1, method = 'POST') {
    return new Promise((resolve, reject) => {
      const request = require('node:http').request(baseUrl + path, { method, headers: { 'Content-Type': 'application/json', 'x-owned-actor': String(actor) } }, response => {
        let buffer = ''; response.setEncoding('utf8'); response.on('data', chunk => { buffer += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(buffer), cache: response.headers['cache-control'] }));
      }); request.on('error', reject); request.end(JSON.stringify(body));
    });
  }
  try {
    const beforeHttp = await counts();
    const denied = await http('/budgets/' + bc.public_id + '/concepts/main/cancellation-preview', cbase, 2); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'access_policy_forbidden');
    const spoof = await http('/fiscal-documents/' + draft.id, { clinic_id: 100, expected_version: 1, idempotency_key: crypto.randomUUID(), status: 'draft' }, 2, 'PATCH'); assert.equal(spoof.status, 403);
    const manual = await http('/patients/4/fiscal-documents', { ...fiscalInput(unpaid, { type: 'manual', id: 'manual' }, 'invoice').payload, clinic_id: 100 }); assert.equal(manual.status, 400); assert.equal(manual.body.error.code, 'fiscal_paid_source_required');
    const foreignHttp = await http('/budgets/' + foreign.public_id + '/concepts/main/cancellation-preview', { ...cbase, clinic_id: 100 }); assert.equal(foreignHttp.status, 403);
    const missingKey = await http('/budgets/' + bc.public_id + '/payments', { amount: 1, method: 'cash', allocations: [{ target_type: 'budget_line', line_key: 'main', amount: 1 }] }); assert.equal(missingKey.status, 400); assert.equal(missingKey.body.error.code, 'economic_request_key_required');
    const portal = await http('/budgets/' + bc.public_id + '/concepts/main/cancellation-preview', cbase, 9); assert.equal(portal.status, 403); assert.equal(portal.body.error.code, 'accounting_portal_read_only');
    const goodPreview = await http('/budgets/' + bc.public_id + '/concepts/main/cancellation-preview', cbase); assert.equal(goodPreview.status, 200); assert.equal(goodPreview.cache, 'private, no-store'); assert.equal(goodPreview.body.concept_revision, 1);
    assert.deepEqual(await counts(), beforeHttp);
    report.checks.push('Owned HTTP routes enforce actual entity clinic and actor permissions, accounting portal read-only, cash request identity and unpaid/manual fiscal guards. Spoofed clinic does not authorize; previews are private and perform no writes.');
  } finally { await new Promise(resolve => server.close(resolve)); }
  report.boundary = 'Real MySQL models, selected additive DDL (twice), native fiscal numbering/parties/template and monolith cash routes; injected concept ACL and branding only. No provider, runtime database, financial transfer, email or messaging.';
}).catch(error => { console.error(error); process.exitCode = 1; });
