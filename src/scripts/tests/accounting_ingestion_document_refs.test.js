'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const Op = { or: Symbol('or'), in: Symbol('in'), lt: Symbol('lt') };

function service() {
  const file = require.resolve('../../services/accountingIngestion.service'), local = createRequire(file), module = { exports: {} };
  const state = { jobs: [], expenses: [], payrolls: [], reads: [], writes: 0, decoderCalls: 0, sourceReads: 0 };
  const documentModel = (kind, collection) => ({ findAll: async options => {
    if(!options.where[Op.or])return [];
    state.reads.push({kind, options});
    return collection.filter(row => options.where[Op.or].some(where => String(where.id) === String(row.id) && where.clinic_id === row.clinic_id));
  } });
  const database = {
    sequelize: { transaction: callback => callback({ LOCK: { UPDATE: 'UPDATE' } }) },
    AccountingIngestionJob: {
      findAll: async ({where,limit,order}) => state.jobs.filter(job => job.clinic_id === where.clinic_id && job.document_kind === where.document_kind && (!where.id || BigInt(job.id)<BigInt(where.id[Op.lt]))).sort((a,b)=>order[0][0]==='id'?Number(BigInt(b.id)-BigInt(a.id)):0).slice(0,limit),
      findOne: async ({where}) => state.jobs.find(job => job.public_id === where.public_id && job.clinic_id === where.clinic_id),
    },
    AccountingExpenseDocument: documentModel('expense', state.expenses),
    AccountingPayrollDocument: documentModel('payroll', state.payrolls),
    ClinicalPrivateAsset: { findAll: async () => [], findByPk: async () => ({content_type: 'application/pdf', original_filename: 'synthetic.pdf'}), findOne: async () => ({id:4,clinic_id:72,status:'active',content_type:'application/pdf',original_filename:'synthetic.pdf'}) },
  };
  const mocks = { '../../models': database, sequelize: { Op }, './accounting.service': {}, './aiBroker.service': {}, './clinicalPrivateStorage.service': {readClinicalPrivateAsset:async()=>{state.sourceReads++;return {buffer:Buffer.from('synthetic')}}}, '../lib/accountingIngestionLease': {}, './accountingDocumentReader.service': {readLocalDocument:async()=>{state.decoderCalls++;return {provider:'local',model:'synthetic-decoder',data:{total:121,currency:'EUR'}}}} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, process: {env:{}}, require: name => Object.hasOwn(mocks, name) ? mocks[name] : local(name) }, {filename:file});
  return {state, api:module.exports};
}

test('queue reload returns scoped public expense identities separately from internal foreign keys in one batch', async () => {
  const {state, api} = service();
  state.jobs.push({public_id:'accepted',clinic_id:72,document_kind:'expense',status:'accepted',expense_document_id:11},
    {public_id:'missing-reference',clinic_id:72,document_kind:'expense',status:'accepted',expense_document_id:33},
    {public_id:'still-reviewing',clinic_id:72,document_kind:'expense',status:'review'},
    {public_id:'foreign-job',clinic_id:73,document_kind:'expense',status:'accepted',expense_document_id:33});
  state.expenses.push({id:11,clinic_id:72,public_id:'public-expense'}, {id:33,clinic_id:73,public_id:'must-not-leak'});
  const jobs = await api.list({clinicId:72});
  assert.equal(jobs.length,3); assert.equal(jobs[0].expense_id,'public-expense'); assert.equal(jobs[0].expense_document_id,'11');
  assert.equal(jobs[0].payroll_id,null); assert.equal(jobs[0].registered_document_missing,false);
  assert.equal(jobs[1].expense_id,null); assert.equal(jobs[1].registered_document_missing,true);
  assert.equal(jobs[2].expense_id,null); assert.equal(jobs[2].registered_document_missing,false);
  assert.equal(state.reads.length,1); assert.equal(state.reads[0].options.where[Op.or].length,2);
  assert(state.reads[0].options.where[Op.or].every(where => where.clinic_id === 72));
});

test('accepted payroll reload and repeated accept return its canonical public document, never a numeric URL', async () => {
  const {state, api} = service();
  state.jobs.push({public_id:'payroll-job',clinic_id:72,document_kind:'payroll',status:'accepted',payroll_document_id:22,source_asset_id:4});
  state.payrolls.push({id:22,clinic_id:72,public_id:'public-payroll-document'});
  const jobs = await api.list({clinicId:72,documentKind:'payroll'});
  assert.equal(jobs[0].payroll_id,'public-payroll-document'); assert.equal(jobs[0].payroll_document_id,'22'); assert.equal(jobs[0].expense_id,null);
  const repeat = await api.accept({publicId:'payroll-job',clinicId:72,actorId:9,payload:{}});
  assert.equal(repeat.already_accepted,true); assert.equal(repeat.job.payroll_id,'public-payroll-document');
  assert.equal(repeat.job.registered_document_missing,false); assert.equal(state.writes,0);
});


test('cursor pagination reaches older jobs, ties are stable and cross-clinic or kind replay is rejected', async () => {
  const {state,api}=service();
  for(let id=1;id<=105;id++)state.jobs.push({id:String(id),public_id:'job-'+id,clinic_id:72,document_kind:'expense',status:'queued',created_at:'2026-10-25T00:00:00Z'});
  state.jobs.push({id:'999',public_id:'foreign',clinic_id:66,document_kind:'expense',status:'queued'});
  const first=await api.list({clinicId:72,pagination:'cursor',limit:100});assert.equal(first.items.length,100);assert.equal(first.items[0].id,'job-105');assert(first.next_cursor);
  const next=await api.list({clinicId:72,pagination:'cursor',limit:100,cursor:first.next_cursor});assert.equal(next.items.length,5);assert.equal(next.items[0].id,'job-5');assert.equal(next.next_cursor,null);
  await assert.rejects(api.list({clinicId:66,pagination:'cursor',cursor:first.next_cursor}),{code:'accounting_ingestion_cursor_invalid'});
  await assert.rejects(api.list({clinicId:72,documentKind:'payroll',pagination:'cursor',cursor:first.next_cursor}),{code:'accounting_ingestion_cursor_invalid'});
  for(const limit of [0,101,2.5,'bad'])await assert.rejects(api.list({clinicId:72,pagination:'cursor',limit}),{code:'accounting_ingestion_limit_invalid'});
  assert.equal((await api.list({clinicId:72})).length,100);
});


test('an explicit local reread replaces only the unregistered proposal using its read-attempt CAS',async()=>{
 const {state,api}=service();const job={id:'1',public_id:'reread',clinic_id:72,document_kind:'expense',status:'review',attempts:2,source_asset_id:4,extracted_data:{total:null}};job.update=async patch=>Object.assign(job,patch);state.jobs.push(job);
 const ordinary=await api.process({publicId:'reread',clinicId:72,mode:'local'});assert.equal(ordinary.extracted_data.total,null);assert.equal(state.decoderCalls,0);
 await assert.rejects(api.process({publicId:'reread',clinicId:72,mode:'local',reprocess:true,expectedAttempts:1}),{code:'accounting_ingestion_read_conflict'});assert.equal(state.decoderCalls,0);
 await assert.rejects(api.process({publicId:'reread',clinicId:72,mode:'automatic',reprocess:true,expectedAttempts:2}),{code:'accounting_ingestion_reprocess_invalid'});assert.equal(state.sourceReads,0);
 const refreshed=await api.process({publicId:'reread',clinicId:72,mode:'local',reprocess:true,expectedAttempts:2});assert.equal(refreshed.status,'review');assert.equal(refreshed.attempts,3);assert.equal(refreshed.extracted_data.total,121);assert.equal(state.decoderCalls,1);assert.equal(state.writes,0);
 await assert.rejects(api.process({publicId:'reread',clinicId:72,mode:'local',reprocess:true,expectedAttempts:2}),{code:'accounting_ingestion_read_conflict'});
 job.status='accepted';job.expense_document_id=10;state.expenses.push({id:10,clinic_id:72,public_id:'registered-expense'});
 const accepted=await api.process({publicId:'reread',clinicId:72,mode:'local',reprocess:true,expectedAttempts:3});assert.equal(accepted.status,'accepted');assert.equal(accepted.expense_id,'registered-expense');assert.equal(state.decoderCalls,1);assert.equal(job.attempts,3);
 await assert.rejects(api.process({publicId:'reread',clinicId:66,mode:'local',reprocess:true,expectedAttempts:3}),{code:'accounting_ingestion_not_found'});
});
