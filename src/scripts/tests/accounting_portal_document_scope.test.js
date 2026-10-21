'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { accountingService } = require('./helpers/accounting-cash-test-loader');
const domainError = (statusCode, code, message) => Object.assign(Error(message), { code, statusCode });
function controller() {
  const file = require.resolve('../../controllers/patientEconomics.controller'), local = createRequire(file), module = { exports: {} };
  const state = { allowedClinic: 72, status: 'issued', pdfCalls: 0 };
  const overrides = { '../../models': { PatientFiscalDocument: { findOne: async () => ({ clinic_id: 72, status: state.status }) } },
    '../services/patientEconomics.service': { domainError, getWorkspace: () => assert.fail('Portal must not read patient workspace'), updateFiscalDocument: () => assert.fail('Portal must not mutate fiscal documents') },
    '../services/economicDocumentPdf.service': { fiscalPdf: async () => { state.pdfCalls++; return { filename: 'synthetic.pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic') }; } },
    '../services/patientVoucherAppointments.service': {}, '../services/patientProgramBooking.service': {},
    '../lib/access-policy': { getAccessibleClinicIdsForFeature: async () => [72] },
    '../services/accountingFirms.service': { isPortalUser: async () => true, assertPortalClinic: async input => {
      assert.equal(input.actorId, 9); if (input.clinicId !== state.allowedClinic) throw domainError(403, 'accounting_portal_clinic_forbidden', 'Outside current scope');
    } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, Date, Object,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  const req = { userData: { userId: 9 }, params: { documentId: 'synthetic-document', patientId: 11 }, query: { clinic_id: 72 }, body: {} };
  const invoke = async method => {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, send(value) { this.body = value; }, json(value) { this.body = value; } };
    await new Promise((resolve, reject) => Promise.resolve(module.exports[method](req, res, reject)).then(resolve, reject)); return res;
  };
  return { state, invoke };
}
test('issued fiscal PDF rechecks current portal scope rather than trusting stale clinic membership', async () => {
  const { state, invoke } = controller(), result = await invoke('downloadFiscalDocumentPdf');
  assert.equal(state.pdfCalls, 1); assert.equal(result.headers['Cache-Control'], 'private, no-store');
  state.allowedClinic = 73;
  await assert.rejects(invoke('downloadFiscalDocumentPdf'), { code: 'accounting_portal_clinic_forbidden' }); assert.equal(state.pdfCalls, 1);
});
test('portal never reads draft fiscal PDFs or patient economics or changes fiscal documents even if general ACL says yes', async () => {
  const { state, invoke } = controller(); state.status = 'draft';
  await assert.rejects(invoke('downloadFiscalDocumentPdf'), { code: 'fiscal_document_not_found' });
  await assert.rejects(invoke('getWorkspace'), { code: 'accounting_portal_read_only' });
  await assert.rejects(invoke('updateFiscalDocument'), { code: 'accounting_portal_read_only' }); assert.equal(state.pdfCalls, 0);
});
test('general accounting document reads add issued status only for the portal and preserve ordinary document visibility', async () => {
  const lookups = [], service = accountingService({ PatientFiscalDocument: { findOne: async options => { lookups.push(options.where); return null; } } });
  await assert.rejects(service.getFiscalDocument({ publicId: 'synthetic-document', clinicId: 72, portalMode: true }), { code: 'fiscal_document_not_found' });
  assert.deepEqual(JSON.parse(JSON.stringify(lookups[0])), { public_id: 'synthetic-document', clinic_id: 72, status: 'issued' });
  await assert.rejects(service.getFiscalDocument({ publicId: 'synthetic-document', clinicId: 72 }), { code: 'fiscal_document_not_found' });
  assert.equal(lookups[1].status, undefined);
});
