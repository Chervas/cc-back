'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
function fixture({ failInsert = false } = {}) {
  const rows = [], assets = [], expenses = [], providerCalls = [], locks = [];
  const row = value => Object.assign(value, { async update(values) { Object.assign(this, values); return this; } });
  let serial = Promise.resolve();
  const db = { sequelize: { transaction: async work => work({ LOCK: { UPDATE: 'UPDATE' } }) },
    ClinicalPrivateAsset: { findAll: async options => assets.filter(asset => Object.entries(options.where).every(([k, v]) => asset[k] === v)),
      findByPk: async id => assets.find(a => a.id === id), findOne: async options => assets.find(a => a.id === options.where.id && a.clinic_id === options.where.clinic_id) },
    AccountingIngestionJob: { findOne: async options => rows.find(job => job.clinic_id === options.where.clinic_id
      && (options.where.public_id ? job.public_id === options.where.public_id : job.document_kind === options.where.document_kind)),
      create: async values => { if (failInsert) { failInsert = false; throw Error('fictitious interrupted insert'); }
        const result = row({ id: rows.length + 1, ...values }); rows.push(result); return result; } },
    AccountingExpenseDocument: { findAll: async () => [], findOne: async () => expenses[0] || null },
    AccountingPayrollDocument: {}, Usuario: {}, UsuarioClinica: {},
  };
  const storage = { storeClinicalPrivateAsset: async input => { const asset = row({ id: assets.length + 1, public_id: 'private-synthetic',
    clinic_id: input.clinicId, purpose: input.purpose, owner_type: input.ownerType, sha256: require('node:crypto').createHash('sha256').update(input.buffer).digest('hex'),
    status: 'active', original_filename: input.originalFilename, content_type: input.contentType, size_bytes: input.buffer.length }); assets.push(asset); return asset; },
    readClinicalPrivateAsset: async () => ({ buffer: Buffer.from('%PDF-1.4\nfictitious') }) };
  let financialWrites = 0;
  const accounting = { createExpense: async input => { financialWrites++; const value = row({ id: 9, public_id: 'fictitious-expense', ...input.payload }); expenses.push(value); return { id: value.public_id }; } };
  const file = require.resolve('../../services/accountingIngestion.service'), local = createRequire(file), module = { exports: {} };
  const extracted = { supplier_name: 'Synthetic supplier', supplier_tax_id: null, supplier_address: null, document_number: 'SYNTHETIC-001',
    issue_date: null, due_date: null, category: null, payment_method: null, taxable_base: null, tax_amount: null, withholding_amount: null,
    total: null, currency: 'EUR', confidence: 0.2, warnings: ['Datos ficticios incompletos'] };
  const overrides = { '../../models': db, './clinicalPrivateStorage.service': storage, './accounting.service': accounting,
    './aiBroker.service': { enabled: () => false }, './securityMonitoring.service': { assertAiAllowed: async () => {} },
    './aiUsageTelemetry.service': { recordProviderResponse: async () => {}, recordProviderFailure: async () => {} },
    axios: { post: async (...args) => { providerCalls.push(args); return { data: { output_text: JSON.stringify(extracted), model: 'synthetic-unit-model' } }; } },
    '../lib/accountingIngestionLease': { withIngestionLease: async (_, scope, work) => { locks.push(scope); const prior = serial; let release;
      serial = new Promise(resolve => { release = resolve; }); await prior; try { return await work(); } finally { release(); } } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, Date, Map, Set, Object,
    process: { env: { OPENAI_API_KEY: 'synthetic-test-key-never-sent' } }, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  const input = { clinicId: 72, actorId: 5, attachment: { filename: 'synthetic.pdf', content_type: 'application/pdf', base64: Buffer.from('%PDF-1.4\nfictitious').toString('base64') } };
  return { service: module.exports, input, rows, assets, expenses, providerCalls, extracted, locks, financialWrites: () => financialWrites };
}
test('admission validates binary signature before storing or submitting and keeps accepted formats private', async () => {
  for (const content_type of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) {
    const f = fixture();
    await assert.rejects(f.service.enqueue({ ...f.input, attachment: { ...f.input.attachment, content_type, base64: Buffer.from('fictitious invalid binary').toString('base64') } }), { code: 'accounting_ingestion_content_invalid' });
    assert.equal(f.assets.length, 0); assert.equal(f.providerCalls.length, 0);
  }
  const f = fixture(), job = await f.service.enqueue(f.input);
  assert.equal(job.status, 'queued'); assert.equal(f.assets[0].purpose, 'accounting_expense_document');
  assert.equal(f.providerCalls.length, 0); assert.equal(f.financialWrites(), 0);
});
test('same-content concurrent admissions reuse one private asset and job; retries recover interrupted insert and clinic/kind remain isolated', async () => {
  const f = fixture(), jobs = await Promise.all([f.service.enqueue(f.input), f.service.enqueue({ ...f.input, attachment: { ...f.input.attachment, filename: 'renamed.pdf' } })]);
  assert.equal(f.assets.length, 1); assert.equal(f.rows.length, 1); assert.equal(jobs[0].id, jobs[1].id); assert.equal(jobs[1].duplicate, true);
  await f.service.enqueue({ ...f.input, clinicId: 73 }); await f.service.enqueue({ ...f.input, documentKind: 'payroll' }); assert.equal(f.rows.length, 3);
  const retry = fixture({ failInsert: true }); await assert.rejects(retry.service.enqueue(retry.input), /interrupted insert/);
  await retry.service.enqueue(retry.input); assert.equal(retry.assets.length, 1); assert.equal(retry.rows.length, 1);
});
test('reading a document only proposes data, preserves unreadable nulls, uses strict no-store request and never writes finances', async () => {
  const f = fixture(), job = await f.service.enqueue(f.input), result = await f.service.process({ publicId: job.id, clinicId: 72 });
  assert.equal(result.status, 'review'); assert.equal(result.extracted_data.tax_amount, null); assert.equal(result.extracted_data.issue_date, null);
  assert.equal(f.providerCalls.length, 1); assert.equal(f.providerCalls[0][1].store, false); assert.equal(f.providerCalls[0][1].text.format.strict, true);
  assert.equal(f.financialWrites(), 0);
  await f.service.process({ publicId: job.id, clinicId: 72 }); assert.equal(f.providerCalls.length, 1);
  await assert.rejects(f.service.process({ publicId: job.id, clinicId: 73 }), { code: 'accounting_ingestion_not_found' });
});
test('acceptance requires explicit payment, all amounts and a real paid date; mismatches and other currency cannot be silently registered', async () => {
  const payload = { supplier_name: 'Synthetic supplier', document_number: 'SYNTHETIC-001', issue_date: '2026-10-21', category: 'Otros',
    status: 'pending', payment_method: 'transfer', taxable_base: 10, tax_amount: 2.1, withholding_amount: 0, total: 12.1 };
  for (const [change, code] of [
    [value => { delete value.status; }, 'accounting_ingestion_review_required'],
    [value => { value.payment_method = ''; }, 'accounting_ingestion_review_required'],
    [value => { value.tax_amount = null; }, 'accounting_ingestion_amounts_required'],
    [value => { value.tax_amount = false; }, 'accounting_ingestion_amounts_required'],
    [value => { value.total = 99; }, 'accounting_ingestion_totals_mismatch'],
    [value => { value.status = 'paid'; }, 'accounting_ingestion_paid_date_required'],
  ]) {
    const f = fixture(), job = await f.service.enqueue(f.input); f.rows[0].status = 'review'; const modified = { ...payload }; change(modified);
    await assert.rejects(f.service.accept({ publicId: job.id, clinicId: 72, actorId: 5, payload: modified }), { code }); assert.equal(f.financialWrites(), 0);
  }
  const foreign = fixture(), foreignJob = await foreign.service.enqueue(foreign.input); foreign.rows[0].status = 'review'; foreign.rows[0].extracted_data = { currency: 'USD' };
  await assert.rejects(foreign.service.accept({ publicId: foreignJob.id, clinicId: 72, actorId: 5, payload }), { code: 'accounting_ingestion_currency_unsupported' });
  const f = fixture(), job = await f.service.enqueue(f.input); f.rows[0].status = 'review';
  await f.service.accept({ publicId: job.id, clinicId: 72, actorId: 5, payload }); assert.equal(f.financialWrites(), 1);
  const again = await f.service.accept({ publicId: job.id, clinicId: 72, actorId: 5, payload }); assert.equal(again.already_accepted, true); assert.equal(f.financialWrites(), 1);
});
