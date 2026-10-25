'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { renderDocumentPreview } = require('../../services/accountingDocumentPreview.service');

function documentWithPages(pages) {
  const font = 3 + pages.length * 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  for (let i = 0; i < pages.length; i++) {
    const content = `BT /F1 24 Tf 50 750 Td (${pages[i]}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let value = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(value)); value += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

test('private local PDF previews expose the real page count and render distinct requested pages at bounded size', async () => {
  const buffer = documentWithPages(['Synthetic invoice page one', 'Synthetic payroll page two']);
  const one = await renderDocumentPreview({ buffer, contentType: 'application/pdf', width: '600' });
  const two = await renderDocumentPreview({ buffer, contentType: 'application/pdf', page: '2', width: '600' });
  assert.equal(one.pages, 2); assert.equal(one.page, 1); assert.equal(two.pages, 2); assert.equal(two.page, 2);
  assert.equal(one.contentType, 'image/png'); assert(one.buffer.readUInt32BE(16) <= 600); assert(one.buffer.readUInt32BE(20) <= 600);
  assert.notDeepEqual(one.buffer, two.buffer);
  const raster = await renderDocumentPreview({ buffer: one.buffer, contentType: 'image/png' });
  assert.equal(raster.pages, 1); assert.equal(raster.buffer, one.buffer);
  await assert.rejects(renderDocumentPreview({ buffer: one.buffer, contentType: 'image/png', page: 2 }), { code: 'accounting_preview_page_missing' });
});

test('preview rejects unsafe or missing pages and malformed PDFs without exposing decoder diagnostics', async () => {
  const buffer = documentWithPages(['Synthetic document']);
  for (const option of [{page: 0}, {page: -1}, {page: ['1']}, {page: '1;anything'}, {width: 199}, {width: 1601}, {width: 'NaN'}]) {
    await assert.rejects(renderDocumentPreview({ buffer, contentType: 'application/pdf', ...option }), { code: 'accounting_preview_option_invalid' });
  }
  await assert.rejects(renderDocumentPreview({ buffer, contentType: 'application/pdf', page: 2 }), { code: 'accounting_preview_page_missing' });
  await assert.rejects(renderDocumentPreview({ buffer: Buffer.from('%PDF-1.4\nprivate malformed metadata'), contentType: 'application/pdf' }), error => error.code === 'accounting_preview_unavailable' && !error.message.includes('private malformed'));
  await assert.rejects(renderDocumentPreview({ buffer, contentType: 'text/plain' }), { code: 'accounting_preview_type_unsupported' });
});

function previewController() {
  const file = require.resolve('../../controllers/accountingDocumentPreview.controller');
  const local = createRequire(file), module = { exports: {} };
  const state = { portal: false, portalClinic: 72, kind: 'expense', features: new Set(['accounting.ocr.manage']), reads: [], renders: 0 };
  const error = (statusCode, code, message) => Object.assign(Error(message), { statusCode, code });
  const source = async input => { state.reads.push(input); if (input.clinicId !== 72) throw error(404, 'source_not_found', 'Source absent'); return { asset: { content_type: 'application/pdf' }, buffer: Buffer.from('%PDF-synthetic') }; };
  const mocks = {
    'express-async-handler': fn => fn,
    '../services/accounting.service': { domainError: error, readExpenseAttachment: source, readPayrollDocumentAttachment: source, readPayrollAttachment: source },
    '../services/accountingFirms.service': { isPortalUser: async () => state.portal, assertPortalClinic: async ctx => { if (ctx.clinicId !== state.portalClinic) throw error(403, 'portal_scope', 'Outside portal'); } },
    '../services/accountingIngestion.service': { kind: async () => state.kind, readSource: source },
    '../lib/access-policy': { canUserAccessFeature: async ctx => state.features.has(ctx.featureKey) },
    '../services/accountingDocumentPreview.service': { renderDocumentPreview: async input => { state.renders++; assert.equal(input.buffer.toString(), '%PDF-synthetic'); return { buffer: Buffer.from('synthetic PNG'), contentType: 'image/png', page: 2, pages: 3 }; } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, Number, Promise, require: name => mocks[name] || local(name) }, { filename: file });
  async function invoke(method, query = { clinic_id: 72, page: 2 }, actorId = 9) {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, send(value) { this.body = value; } };
    await module.exports[method]({ userData: { userId: actorId }, query, params: { jobId: 'job', expenseId: 'expense', payrollId: 'month', documentId: 'document' } }, res);
    return res;
  }
  return { state, invoke };
}

test('ingestion payroll preview requires both OCR and payroll read; expense and clinic permissions remain exact', async () => {
  const { state, invoke } = previewController(); state.kind = 'payroll';
  await assert.rejects(invoke('ingestion'), { code: 'access_policy_forbidden' }); assert.equal(state.reads.length, 0);
  state.features.add('accounting.payroll.view'); const res = await invoke('ingestion');
  assert.equal(state.reads[0].clinicId, 72); assert.equal(res.headers['X-Document-Pages'], '3'); assert.equal(res.headers['X-Document-Page'], '2');
  assert.equal(res.headers['Cache-Control'], 'private, no-store'); assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  await assert.rejects(invoke('expense', {clinic_id: 73}), { code: 'source_not_found' });
  await assert.rejects(invoke('expense', {clinic_id: [72]}), { code: 'clinic_scope_required' });
  await assert.rejects(invoke('expense', {clinic_id: 72}, null), { code: 'unauthenticated' });
});

test('portal expense preview rechecks its current clinic; payroll and ingestion previews stay private to authorized staff', async () => {
  const { state, invoke } = previewController(); state.portal = true;
  await invoke('expense'); assert.equal(state.renders, 1);
  state.portalClinic = 73; await assert.rejects(invoke('expense'), { code: 'portal_scope' });
  await assert.rejects(invoke('payroll'), { code: 'accounting_portal_read_only' });
  await assert.rejects(invoke('payrollDocument'), { code: 'accounting_portal_read_only' });
  await assert.rejects(invoke('ingestion'), { code: 'accounting_portal_read_only' }); assert.equal(state.renders, 1);
});
