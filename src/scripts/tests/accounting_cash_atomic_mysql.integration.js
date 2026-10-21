'use strict';
// Native accounting service/model SQL on an owned --skip-networking mysqld.
// The harness forbids runtime SQL/provider sockets. ACL identities are synthetic.
const assert = require('node:assert/strict'), { DataTypes: D } = require('sequelize');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { accountingService, accountingController, invoke } = require('./helpers/accounting-cash-test-loader');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const fields = { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING, configuracion: D.JSON,
    url_avatar: D.STRING, datos_fiscales_clinica: D.JSON, direccion: D.STRING, codigo_postal: D.STRING,
    ciudad: D.STRING, provincia: D.STRING, pais: D.STRING };
  db.Clinica = sql.define('Clinica', fields, { tableName: 'Clinicas', timestamps: false });
  for (const file of ['accountingcashclosure', 'accountingcashsession', 'accountingcashmovement', 'accountingexpensedocument', 'economicpayment', 'patientfiscaldocument']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  await sql.sync();
  // The existing migrations provide these exact second-barrier constraints.
  await sql.getQueryInterface().addIndex('AccountingCashSessions', ['clinic_id', 'business_date'], { name: 'accounting_cash_sessions_clinic_date_uq', unique: true });
  await sql.getQueryInterface().addIndex('AccountingCashClosures', ['clinic_id', 'business_date'], { name: 'accounting_cash_closures_date_uq', unique: true });
  await db.Clinica.bulkCreate([{ id_clinica: 72, nombre_clinica: 'Clínica ficticia', configuracion: { timezone: 'Europe/Madrid' } },
    { id_clinica: 73, nombre_clinica: 'Otra clínica ficticia', configuracion: { timezone: 'Europe/Madrid' } }]);
  const service = accountingService(db);
  const session = (date, clinicId = 72) => db.AccountingCashSession.create({ public_id: randomUUID(), clinic_id: clinicId,
    business_date: date, opening_cash: 50, status: 'open', opened_at: new Date('2026-10-01T10:00:00Z'), opened_by: 7 });
  const payment = (id, amount, method, paidAt, patch = {}) => db.EconomicPayment.create({ public_id: id, clinic_id: 72, patient_id: 11,
    amount, method, status: 'confirmed', application: { allocations: [{ target_type: 'budget', amount }] }, paid_at: new Date(paidAt), ...patch });
  const expense = (id, total, patch = {}) => db.AccountingExpenseDocument.create({ public_id: id, clinic_id: 72,
    supplier_name: 'Proveedor ficticio', document_number: id, issue_date: '2026-10-25', category: 'Material', payment_method: 'cash',
    status: 'paid', total, paid_at: new Date('2026-10-25T12:00:00Z'), ...patch });
  const movement = (id, movementType, amount, patch = {}) => db.AccountingCashMovement.create({ public_id: id, clinic_id: 72,
    movement_type: movementType, amount, method: 'cash', description: 'Movimiento ficticio', occurred_at: new Date('2026-10-25T12:00:00Z'), ...patch });
  await session('2026-10-25'); await session('2026-10-25', 73);
  // DST in Madrid: this local day spans [24 Oct 22:00Z, 25 Oct 23:00Z).
  await payment('cash-in-day', 100, 'cash', '2026-10-24T22:00:00Z');
  await payment('card-in-day', 200, 'card', '2026-10-25T12:00:00Z');
  await payment('transfer-in-day', 50, 'transfer', '2026-10-25T12:00:00Z');
  await payment('bizum-in-day', 40, 'bizum', '2026-10-25T12:00:00Z');
  await payment('voided-payment', 900, 'cash', '2026-10-25T12:00:00Z', { status: 'voided' });
  await payment('after-local-midnight', 75, 'cash', '2026-10-25T23:00:00Z');
  await payment('before-local-midnight', 80, 'cash', '2026-10-24T21:59:59Z');
  await payment('foreign-clinic-payment', 999, 'cash', '2026-10-25T12:00:00Z', { clinic_id: 73 });
  await expense('expense-cash', 10); await expense('expense-pending', 20, { status: 'pending' });
  await expense('expense-transfer', 100, { payment_method: 'transfer' });
  await expense('expense-next-day', 50, { paid_at: new Date('2026-10-25T23:00:00Z') });
  await movement('manual-income', 'income', 5); await movement('manual-expense', 'expense', 3);
  await movement('manual-adjustment', 'adjustment', -2); await movement('noncash-manual', 'income', 999, { method: 'card' });
  const sourceState = async () => JSON.stringify(await Promise.all(['EconomicPayment', 'AccountingExpenseDocument', 'AccountingCashMovement']
    .map(name => db[name].findAll({ order: [['id', 'ASC']], raw: true }))));
  const sourcesBefore = await sourceState(), foreignBefore = (await db.AccountingCashSession.findOne({ where: { clinic_id: 73 } })).toJSON();
  const transactions = [], observe = (name, options) => {
    assert(options.transaction, name + ' must use the closure transaction'); transactions.push(options.transaction.id);
  };
  for (const name of ['EconomicPayment', 'AccountingExpenseDocument', 'AccountingCashMovement']) db[name].addHook('beforeFind', 'owned-transaction', options => observe(name, options));
  db.AccountingCashClosure.addHook('beforeCreate', 'owned-transaction', (_row, options) => observe('closure create', options));
  db.AccountingCashSession.addHook('beforeUpdate', 'owned-failure', (_row, options) => {
    observe('session update', options); throw Object.assign(Error('OWNED_SESSION_UPDATE_FAILED'), { code: 'OWNED_SESSION_UPDATE_FAILED' });
  });
  const close = (date, payload = {}, clinicId = 72) => service.closeCash({ clinicId, actorId: 7, payload: { business_date: date, actual_cash: 50, ...payload } });
  try { await assert.rejects(close('2026-10-25', { denomination_breakdown: { 100: 1, 20: 2 }, actual_cash: 999 }), { code: 'OWNED_SESSION_UPDATE_FAILED' }); }
  finally {
    db.AccountingCashSession.removeHook('beforeUpdate', 'owned-failure');
    db.AccountingCashClosure.removeHook('beforeCreate', 'owned-transaction');
    for (const name of ['EconomicPayment', 'AccountingExpenseDocument', 'AccountingCashMovement']) db[name].removeHook('beforeFind', 'owned-transaction');
  }
  assert.equal(new Set(transactions).size, 1); assert.equal(transactions.length, 5);
  assert.equal(await db.AccountingCashClosure.count(), 0);
  const afterFailure = await db.AccountingCashSession.findOne({ where: { clinic_id: 72, business_date: '2026-10-25' } });
  assert.equal(afterFailure.status, 'open'); assert.equal(afterFailure.closure_id, null);
  assert.equal(await sourceState(), sourcesBefore);
  report.checks.push('Injected failure in actual Sequelize session beforeUpdate AFTER native closure INSERT: all five source/create/update operations share one transaction; closure rolls back, session remains open with no link, source ledgers unchanged.');

  const retried = await close('2026-10-25', { denomination_breakdown: { 100: 1, 20: 2 }, actual_cash: 999 });
  assert.equal(retried.expected_cash, 140); assert.equal(retried.actual_cash, 140); assert.equal(retried.difference, 0);
  assert.equal(retried.cash_receipts, 105); assert.equal(retried.cash_outflows, 13);
  assert.deepEqual(JSON.parse(JSON.stringify(retried.denomination_breakdown)), { 20: 2, 100: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(retried.tender_reconciliation)), { cash: 100, card: 200, transfer: 50, bizum: 40 });
  const persisted = await db.AccountingCashClosure.findOne({ where: { public_id: retried.id } });
  assert.equal(persisted.snapshot.patient_receipts, 100); assert.equal(persisted.snapshot.adjustments, -2);
  assert.deepEqual([...persisted.snapshot.source_ids.payments].sort(), ['bizum-in-day', 'card-in-day', 'cash-in-day', 'transfer-in-day']);
  assert.deepEqual(persisted.snapshot.source_ids.expenses, ['expense-cash']);
  const closedSession = await db.AccountingCashSession.findByPk(afterFailure.id);
  assert.equal(closedSession.status, 'closed'); assert.equal(Number(closedSession.closure_id), Number(persisted.id));
  await assert.rejects(close('2026-10-25'), { code: 'cash_already_closed', statusCode: 409 });
  assert.equal(await db.AccountingCashClosure.count(), 1);
  assert.deepEqual((await db.AccountingCashSession.findOne({ where: { clinic_id: 73 } })).toJSON(), foreignBefore);
  report.checks.push('Retry succeeds after rollback; existing response/denominations/tender classification remain exact. Real DST 25-hour Madrid day includes local midnight and excludes both adjacent days, voided payments and foreign clinic; repeated close is 409 with one immutable snapshot.');

  await session('2026-10-29');
  let releaseFirst, firstLocked, secondStarted;
  const release = new Promise(resolve => { releaseFirst = resolve; }), locked = new Promise(resolve => { firstLocked = resolve; }), started = new Promise(resolve => { secondStarted = resolve; });
  let attempts = 0, held = false;
  db.AccountingCashSession.addHook('beforeFind', 'owned-race', options => {
    if (options.where?.business_date === '2026-10-29' && options.lock) { attempts++; if (attempts === 2) secondStarted(); }
  });
  db.AccountingCashSession.addHook('afterFind', 'owned-race', async (_row, options) => {
    if (options.where?.business_date === '2026-10-29' && options.lock && !held) { held = true; firstLocked(); await release; }
  });
  try {
    const first = close('2026-10-29'); await locked;
    const second = close('2026-10-29'); await started; releaseFirst();
    const race = await Promise.allSettled([first, second]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = race.find(result => result.status === 'rejected'); assert.equal(rejected.reason.code, 'cash_already_closed');
    assert.equal(await db.AccountingCashClosure.count({ where: { clinic_id: 72, business_date: '2026-10-29' } }), 1);
    const winner = await db.AccountingCashSession.findOne({ where: { clinic_id: 72, business_date: '2026-10-29' } });
    assert.equal(winner.status, 'closed'); assert(winner.closure_id);
  } finally { releaseFirst(); db.AccountingCashSession.removeHook('beforeFind', 'owned-race'); db.AccountingCashSession.removeHook('afterFind', 'owned-race'); }
  report.checks.push('Forced overlap of two production closeCash commands while first holds native SELECT FOR UPDATE: exactly one winner, second 409, one closure and one coherent closed session.');

  await assert.rejects(close('2026-10-27'), { code: 'cash_not_open' });
  await session('2026-10-27');
  await assert.rejects(close('2026-10-27', { denomination_breakdown: { 3: 1 } }), { code: 'cash_denomination_invalid' });
  await assert.rejects(close('2026-10-27', { actual_cash: -1 }), { code: 'cash_amount_invalid' });
  await assert.rejects(close('2026-10-27', { actual_cash: 51 }), { code: 'cash_difference_note_required' });
  assert.equal(await db.AccountingCashClosure.count({ where: { business_date: '2026-10-27' } }), 0);
  const withDifference = await close('2026-10-27', { actual_cash: 51, notes: 'Diferencia ficticia revisada' });
  assert.equal(withDifference.difference, 1); assert.equal(withDifference.notes, 'Diferencia ficticia revisada');

  await session('2026-10-28'); let serviceCalls = 0;
  const controller = accountingController({ ...service, closeCash: input => { serviceCalls++; return service.closeCash(input); } },
    { canAccess: async ({ actorId, clinicId, featureKey }) => actorId === 7 && clinicId === 72 && featureKey === 'accounting.cash.manage', isPortal: async ({ actorId }) => actorId === 9 });
  const req = (actor = 7, clinic = 72) => ({ userData: { userId: actor }, query: {}, body: { clinic_id: clinic, business_date: '2026-10-28', actual_cash: 50 } });
  for (const [request, code] of [[req(8), 'access_policy_forbidden'], [req(7, 73), 'access_policy_forbidden'], [req(9), 'accounting_portal_read_only'], [req(null), 'unauthenticated']]) {
    await assert.rejects(invoke(controller.closeCash, request), { code }); assert.equal(serviceCalls, 0);
  }
  assert.equal(await db.AccountingCashClosure.count({ where: { business_date: '2026-10-28' } }), 0);
  assert.equal((await invoke(controller.closeCash, req())).statusCode, 201); assert.equal(serviceCalls, 1);
  assert.equal(await sourceState(), sourcesBefore);
  report.checks.push('Existing missing/open/closed, denomination/negative-cash/discrepancy-note validations are preserved; actual controller denies foreign clinic, denied actor, portal and missing identity before the SQL service; authorized native close returns 201. No clinical, payment, voucher or fiscal ledger mutations.');
}).catch(error => { console.error(error); process.exitCode = 1; });
