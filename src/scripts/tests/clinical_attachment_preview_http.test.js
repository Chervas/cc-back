'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function fixture() {
  const filename = require.resolve('../../controllers/patientClinicalAttachments.controller'), local = require('node:module').createRequire(filename);
  const calls = { read: [], preview: [] }, state = {};
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require: name => {
    if (name === '../services/patientClinicalAttachments.service') return { readPatientClinicalAttachment: async (...args) => {
      calls.read.push(args); if (state.readError) throw state.readError;
      return { buffer: Buffer.from('OWNED-PRIVATE-PDF'), contentType: 'application/pdf' };
    } };
    if (name === '../services/clinicalAttachmentPreview.service') return { createClinicalAttachmentPreview: async input => {
      calls.preview.push(input); if (state.previewError) throw state.previewError;
      return { buffer: Buffer.from('OWNED-PNG'), contentType: 'image/png', page: 2, pageCount: 3 };
    } };
    return local(name);
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const response = () => ({ code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, removeHeader(key) { delete this.headers[key]; },
    status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } });
  return { calls, state, response, controller: sandbox.module.exports };
}
test('preview reuses exact authenticated private-asset ACL and emits page metadata privately', async () => {
  const f = fixture(), res = f.response();
  await f.controller.previewPatientClinicalAttachment({ params: { id: 'owned-patient', attachmentId: 'cpa_owned' }, userData: { userId: 7 }, query: { page: '2', actorUserId: 999 } }, res);
  assert.equal(res.code, 200); assert.deepEqual(Array.from(f.calls.read[0]), ['owned-patient', 'cpa_owned', 7]);
  assert.equal(f.calls.preview[0].page, '2'); assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['X-Clinical-Page-Count'], '3'); assert.equal(res.headers['X-Clinical-Page'], '2');
  assert.equal(res.headers['Cache-Control'], 'private, no-store'); assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});
test('denied preview never invokes a renderer and invalid-page failures stay private JSON', async () => {
  const f = fixture(); f.state.readError = Object.assign(Error('SECRET_PERMISSION'), { status: 403 });
  const req = { params: { id: 'owned', attachmentId: 'cpa_owned' }, userData: { userId: 7 }, query: {} };
  const forbidden = f.response(); await f.controller.previewPatientClinicalAttachment(req, forbidden);
  assert.equal(forbidden.code, 403); assert.equal(f.calls.preview.length, 0); assert.equal(JSON.stringify(forbidden.body).includes('SECRET'), false);
  f.state.readError = null; f.state.previewError = Object.assign(Error('Selecciona una página válida.'), { statusCode: 400, code: 'clinical_attachment_preview_page_invalid' });
  const invalid = f.response(); await f.controller.previewPatientClinicalAttachment(req, invalid);
  assert.equal(invalid.code, 400); assert.equal(invalid.body.code, 'clinical_attachment_preview_page_invalid');
  const anonymous = f.response(); await f.controller.previewPatientClinicalAttachment({ ...req, userData: null }, anonymous); assert.equal(anonymous.code, 401);
});
