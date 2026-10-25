'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const reader = require('../../services/accountingDocumentReader.service');
const { pdf, invoiceLines, payrollLines, spanishPayrollLines } = require('./fixtures/accounting-document.fixture');
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

const spanishExpected = { employee_name: 'Persona ficticia Dos Columnas', employee_tax_id: '12345678Z',
  period_month: '2025-09-01', gross_salary: 2400, employee_social_security: 152.4,
  irpf_withholding: 288, net_salary: 1959.6, other_amounts: null, currency: null };
test('two-column Spanish payroll reads the worker and deductions instead of company identifiers and contributions', () => {
  const data = reader.parseDocumentText(spanishPayrollLines.join('\n'), 'payroll');
  for (const [key, value] of Object.entries(spanishExpected)) assert.equal(data[key], value, key);
  assert(data.warnings.some(warning => warning.includes('moneda')));
  assert(data.warnings.some(warning => warning.includes('vacío no equivale a cero')));
});
test('a local Poppler round trip retains two-column payroll fields without inferring currency or other amounts', async () => {
  const result = await reader.readLocalDocument({ buffer: pdf(spanishPayrollLines, { monospace: true }), contentType: 'application/pdf', documentKind: 'payroll' });
  assert.equal(result.model, 'pdftotext');
  for (const [key, value] of Object.entries(spanishExpected)) assert.equal(result.data[key], value, key);
});
test('a two-column scanned payroll tolerates OCR reading columns sequentially and wrapping totals', async () => {
  const { execFileSync } = require('node:child_process');
  const png = execFileSync('/usr/bin/pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '2400', '-png', '-'], { input: pdf(spanishPayrollLines, { monospace: true }), maxBuffer: 12 * 1024 * 1024 });
  const result = await reader.readLocalDocument({ buffer: png, contentType: 'image/png', documentKind: 'payroll' });
  assert.equal(result.model, 'tesseract');
  for (const [key, value] of Object.entries(spanishExpected)) assert.equal(result.data[key], value, key);
});
test('a total formula without a printed amount never becomes a salary of one or two', () => {
  const data = reader.parseDocumentText('Empleado: Persona ficticia QA\nA. TOTAL DEVENGADO (1 + 2)\nTexto sin importe', 'payroll');
  assert.equal(data.gross_salary, null);
});
test('payroll amount absent after a tax percentage stays unknown instead of taking its base or the next numbered section', () => {
  const lines = spanishPayrollLines.map(line => line.replace('12,00 %                 288,00', '12,00 %'));
  const data = reader.parseDocumentText(lines.join('\n'), 'payroll');
  assert.equal(data.irpf_withholding, null); assert.equal(data.employee_social_security, 152.4);
});
test('unscoped or employer contributions never become employee social security', () => {
  const lines = spanishPayrollLines.filter(line => !line.includes('TOTAL APORTACIONES .............. 152,40'));
  const data = reader.parseDocumentText(lines.join('\n'), 'payroll');
  assert.equal(data.employee_social_security, null);
  assert.equal(reader.parseDocumentText('TOTAL APORTACIONES: 999,99', 'payroll').employee_social_security, null);
});
test('company NIF is not used when the employee NIF is missing, and repeated headers for one person are allowed', () => {
  const lines = spanishPayrollLines.map(line => line.replace('N.I.F.: 12345678Z', 'Identificador: desconocido'));
  assert.equal(reader.parseDocumentText(lines.join('\n'), 'payroll').employee_tax_id, null);
  const sameWorker = reader.parseDocumentText([...spanishPayrollLines, ...spanishPayrollLines].join('\n'), 'payroll');
  assert.equal(sameWorker.employee_name, spanishExpected.employee_name); assert.equal(sameWorker.gross_salary, 2400);
});
test('merged two-column payrolls clear the worker tax identifier as well as all amounts and months', () => {
  const second = spanishPayrollLines.map(line => line.replace('Persona ficticia Dos Columnas', 'Otra persona completamente ficticia').replace('12345678Z', '87654321X'));
  const data = reader.parseDocumentText([...spanishPayrollLines, ...second].join('\f'), 'payroll');
  assert.equal(data.employee_name, null); assert.equal(data.employee_tax_id, null); assert.equal(data.period_month, null);
  assert(reader.PAYROLL_AMOUNTS.every(key => data[key] === null));
  assert(data.warnings.some(warning => warning.includes('varias personas')));
});
test('distinct months for one employee require separate review rather than mixing monthly amounts', () => {
  const data = reader.parseDocumentText([...spanishPayrollLines, 'Mes: 10/2025'].join('\n'), 'payroll');
  assert.equal(data.period_month, null); assert(reader.PAYROLL_AMOUNTS.every(key => data[key] === null));
  assert(data.warnings.some(warning => warning.includes('varios meses')));
});
test('explicit payroll currency is retained and conflicting currencies remain a manual decision', () => {
  assert.equal(reader.parseDocumentText([...spanishPayrollLines, 'Moneda: GBP'].join('\n'), 'payroll').currency, 'GBP');
  const data = reader.parseDocumentText([...spanishPayrollLines, 'Moneda: EUR', 'Equivalente USD'].join('\n'), 'payroll');
  assert.equal(data.currency, null); assert(data.warnings.some(warning => warning.includes('varias monedas')));
});
test('invalid local documents fail into manual review with null amounts and retain the preview decoder export', async () => {
  const result = await reader.readLocalDocument({ buffer: Buffer.from('not a PDF or an image'), contentType: 'application/pdf', documentKind: 'payroll' });
  assert.equal(result.provider, 'manual'); assert.equal(result.model, 'manual');
  assert(reader.PAYROLL_AMOUNTS.every(key => result.data[key] === null));
  assert.equal(result.data.currency, null); assert.equal(typeof reader.runLocalDecoder, 'function');
  assert(result.data.warnings.some(warning => warning.includes('No se pudo leer')));
});
