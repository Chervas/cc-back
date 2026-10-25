'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const reader = require('../../services/accountingDocumentReader.service');
const { pdf, invoiceLines, payrollLines } = require('./fixtures/accounting-document.fixture');
test('local invoice extraction preserves structured amounts, dates and missing payment decisions', async () => {
  const result = await reader.readLocalDocument({buffer: pdf(invoiceLines), contentType: 'application/pdf', documentKind: 'expense'});
  assert.equal(result.provider, 'local'); assert.equal(result.model, 'pdftotext');
  assert.equal(result.data.supplier_name, 'Proveedor ficticio QA'); assert.equal(result.data.document_number, 'QA-2026-001');
  assert.equal(result.data.issue_date, '2026-10-25'); assert.equal(result.data.taxable_base, 100); assert.equal(result.data.tax_amount, 21);
  assert.equal(result.data.withholding_amount, 0); assert.equal(result.data.total, 121); assert.equal(result.data.currency, 'EUR');
  assert.equal(result.data.payment_method, null); assert.equal(result.data.category, null);
});
test('local payroll extraction yields a month and five distinct native amount fields', async () => {
  const result = await reader.readLocalDocument({buffer: pdf(payrollLines), contentType: 'application/pdf', documentKind: 'payroll'});
  assert.equal(result.provider, 'local'); assert.equal(result.data.employee_name, 'Persona ficticia QA');
  assert.equal(result.data.period_month, '2026-10-01');
  for (const [key,value] of Object.entries({gross_salary:2000,employee_social_security:130,irpf_withholding:200,net_salary:1670,other_amounts:0})) assert.equal(result.data[key],value);
});
test('unread fields remain null; a tax percentage is not mistaken for the IVA amount', () => {
  const data = reader.parseDocumentText('Proveedor: Ficticio\nIVA: 21%\nTotal: 12,10 EUR');
  assert.equal(data.tax_amount,null); assert.equal(data.withholding_amount,null); assert.equal(data.issue_date,null);
  assert.equal(data.taxable_base,null); assert.equal(data.total,12.1);
  const payroll = reader.parseDocumentText('Documento sin cifras','payroll');
  assert.equal(payroll.period_month,null); assert(reader.PAYROLL_AMOUNTS.every(key=>payroll[key]===null));
});
test('invalid dates, foreign currency and monetary bounds do not silently normalize to valid euros', () => {
  assert.equal(reader.date('31/02/2026'),null); assert.equal(reader.amount('Infinity'),null); assert.equal(reader.amount('100000001'),null);
  assert.equal(reader.amount('1.234,56'),1234.56); assert.equal(reader.amount('1,234.56'),1234.56);
  assert.equal(reader.parseDocumentText('Total: 100 USD').currency,'USD');
  assert.equal(reader.parseDocumentText('Total: 100').currency,null);
});

test('scanned payroll images use the local OCR decoder and produce native structured fields without providers',async()=>{
  const {execFileSync}=require('node:child_process');
  const png=execFileSync('/usr/bin/pdftoppm',['-f','1','-l','1','-singlefile','-scale-to','1800','-png','-'],{input:pdf(payrollLines),maxBuffer:12*1024*1024});
  const result=await reader.readLocalDocument({buffer:png,contentType:'image/png',documentKind:'payroll'});
  assert.equal(result.provider,'local');assert.equal(result.model,'tesseract');assert.equal(result.data.period_month,'2026-10-01');assert.equal(result.data.gross_salary,2000);assert.equal(result.data.net_salary,1670);
});
test('a merged payroll with distinct employees does not silently become one person and one set of amounts',()=>{
 const data=reader.parseDocumentText([...payrollLines,'Empleado: Otra persona ficticia QA'].join('\n'),'payroll');
 assert.equal(data.employee_name,null);assert.equal(data.period_month,null);assert(reader.PAYROLL_AMOUNTS.every(key=>data[key]===null));assert(data.warnings.some(warning=>warning.includes('varias personas')));
 assert.equal(reader.parseDocumentText('Total: 100 CHF').currency,'CHF');
});
