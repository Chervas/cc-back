'use strict';
// Own socket-only MySQL and private directory. No runtime DB, credentials,
// providers, messages, payments or documents belonging to a clinic are used.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createRequire} = require('node:module'), {DataTypes: D} = require('sequelize');
const {withIsolatedCampaignMysql} = require('./fixtures/isolated_campaign_mysql.fixture');
const {pdf, invoiceLines, payrollLines} = require('./fixtures/accounting-document.fixture');
function load(file, overrides, env = {}) {
  const local = createRequire(file), module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'), {module,exports:module.exports,Buffer,Date,Map,Set,Object,console,__dirname:path.dirname(file),process:{env},
    require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)}, {filename:file});
  return module.exports;
}
withIsolatedCampaignMysql(async ({sql,models:db,report}) => {
  db.Clinica = sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},nombre_clinica:D.STRING},{tableName:'Clinicas',timestamps:false});
  db.Usuario = sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,apellidos:D.STRING},{tableName:'Usuarios',timestamps:false});
  for(const file of ['usuarioclinica','accountingingestionjob','clinicalprivateasset','accountingexpensedocument','accountingpayrolldocument','accountingpayrollperiod']) {
    const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
  }
  await sql.sync();
  await db.Clinica.bulkCreate([{id_clinica:72,nombre_clinica:'Ficticia A'},{id_clinica:73,nombre_clinica:'Ficticia B'}]);
  await db.Usuario.create({id_usuario:5,nombre:'Persona ficticia',apellidos:'QA'});
  await db.UsuarioClinica.create({id_usuario:5,id_clinica:72,estado_invitacion:'aceptada'});
  const privateRoot=path.join(report.root,'owned-private');fs.mkdirSync(privateRoot,{mode:0o700});
  const storage=load(require.resolve('../../services/clinicalPrivateStorage.service'),{'../../models':db},{CLINICAL_PRIVATE_STORAGE_ROOT:privateRoot});
  const accounting=load(require.resolve('../../services/accounting.service'),{'../../models':db,'./clinicalPrivateStorage.service':storage,'./patientEconomics.service':{}});
  const overrides={'../../models':db,'./clinicalPrivateStorage.service':storage,'./accounting.service':accounting,'./aiBroker.service':{enabled:()=>false},
    axios:{post:()=>assert.fail('The local importer must not contact a provider')}};
  let ingestion=load(require.resolve('../../services/accountingIngestion.service'),overrides);
  const upload=(kind,lines,clinicId=72)=>ingestion.enqueue({clinicId,actorId:5,documentKind:kind,attachment:{filename:'fictitious-'+kind+'.pdf',content_type:'application/pdf',base64:pdf(lines).toString('base64')}});
  const invoice=await upload('expense',invoiceLines), payroll=await upload('payroll',payrollLines);
  const invoiceReview=await ingestion.process({publicId:invoice.id,clinicId:72,mode:'local'}), payrollReview=await ingestion.process({publicId:payroll.id,clinicId:72,mode:'local'});
  assert.equal(invoiceReview.status,'review');assert.equal(invoiceReview.extracted_data.total,121);
  assert.equal(payrollReview.status,'review');assert.equal(payrollReview.extracted_data.net_salary,1670);
  assert.equal(payrollReview.extracted_data.employee_match.suggested_employee_id,5);
  assert.equal(await db.AccountingExpenseDocument.count(),0);assert.equal(await db.AccountingPayrollDocument.count(),0);
  report.checks.push('Real PDF text parsing creates structured invoice/payroll review proposals with original bytes privately persisted; no financial record exists before human confirmation.');
  const expensePayload={currency:'EUR',supplier_name:'Proveedor ficticio QA',supplier_tax_id:'B12345674',document_number:'QA-2026-001',issue_date:'2026-10-25',category:'Otros',payment_method:'transfer',status:'pending',taxable_base:100,tax_amount:21,withholding_amount:0,total:121};
  const payrollPayload={currency:'EUR',employee_id:5,employee_name:'Persona ficticia QA',period_month:'2026-10-01',gross_salary:2000,employee_social_security:130,irpf_withholding:200,net_salary:1670,other_amounts:0};
  await assert.rejects(ingestion.accept({publicId:invoice.id,clinicId:73,actorId:5,payload:expensePayload}),{code:'accounting_ingestion_not_found'});
  await assert.rejects(ingestion.accept({publicId:payroll.id,clinicId:72,actorId:5,payload:{...payrollPayload,employee_id:99}}),{code:'payroll_document_employee_invalid'});
  assert.equal(await db.AccountingPayrollDocument.count(),0);
  const accepted=await ingestion.accept({publicId:invoice.id,clinicId:72,actorId:5,payload:expensePayload});
  const payAccepted=await ingestion.accept({publicId:payroll.id,clinicId:72,actorId:5,payload:payrollPayload});
  assert.equal(accepted.expense.total,121);assert.equal(payAccepted.payroll_document.net_salary,1670);assert.equal(payAccepted.payroll_document.match_status,'matched');
  // Reload the production service and rows, including a lost acknowledgement.
  ingestion=load(require.resolve('../../services/accountingIngestion.service'),overrides);
  assert.equal((await ingestion.list({clinicId:72,documentKind:'expense'}))[0].status,'accepted');
  assert.equal((await ingestion.list({clinicId:72,documentKind:'payroll'}))[0].status,'accepted');
  assert.equal((await ingestion.accept({publicId:invoice.id,clinicId:72,actorId:5,payload:expensePayload})).already_accepted,true);
  assert.equal((await ingestion.accept({publicId:payroll.id,clinicId:72,actorId:5,payload:payrollPayload})).already_accepted,true);
  assert.equal(await db.AccountingExpenseDocument.count(),1);assert.equal(await db.AccountingPayrollDocument.count(),1);assert.equal(await db.AccountingPayrollPeriod.count(),0);
  assert.deepEqual((await accounting.readExpenseAttachment({publicId:accepted.expense.id,clinicId:72})).buffer,pdf(invoiceLines));
  assert.deepEqual((await accounting.readPayrollDocumentAttachment({publicId:payAccepted.payroll_document.id,clinicId:72})).buffer,pdf(payrollLines));
  report.checks.push('Expense and employee-linked payroll confirm and survive production-service reload; exact replay is idempotent, foreign clinic/employee are rejected, source PDF bytes are unchanged, and monthly costs are not duplicated.');
  // A missing extraction is a review with nulls, not a fabricated payroll.
  const manual=await upload('payroll',['NOMINA FICTICIA SIN DATOS']);
  const manualReview=await ingestion.process({publicId:manual.id,clinicId:72,mode:'manual'});
  assert.equal(manualReview.extracted_data.gross_salary,null);assert.equal(manualReview.extracted_data.period_month,null);
  await assert.rejects(ingestion.accept({publicId:manual.id,clinicId:72,actorId:5,payload:{...payrollPayload,gross_salary:null}}),{code:'accounting_payroll_amounts_required'});
  const unmatched=await ingestion.accept({publicId:manual.id,clinicId:72,actorId:5,payload:{...payrollPayload,employee_id:null,employee_name:'Otra persona ficticia QA'}});
  assert.equal(unmatched.payroll_document.match_status,'unmatched');assert.equal(await db.AccountingPayrollPeriod.count(),0);
  const duplicate=await upload('expense',invoiceLines);assert.equal(duplicate.id,invoice.id);assert.equal(duplicate.duplicate,true);
  report.checks.push('Manual recovery preserves unread nulls, requires explicit amounts and currency, can retain an unmatched payroll, and reuploading identical content reuses its original job.');
}).catch(error=>{console.error(error);process.exitCode=1;});
