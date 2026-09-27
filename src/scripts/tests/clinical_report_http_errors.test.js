'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { clinicalReportHandler, requireExpectedVersion, assertCurrentVersion } = require('../../lib/clinical-report-version');
test('real HTTP route returns safe JSON for absent/stale version and other domain failures', async () => {
  const app = express(); app.use(express.json());
  app.put('/report', clinicalReportHandler(async (req, res) => {
    const expected = requireExpectedVersion(req.body); assertCurrentVersion(expected, { version_number: 2 });
    res.json({ version: 3 });
  }));
  app.get('/permission', clinicalReportHandler(async () => { throw Object.assign(new Error('Sin acceso'), { statusCode: 403, code: 'access_policy_forbidden' }); }));
  app.get('/unknown', clinicalReportHandler(async () => { throw Error('UNEXPECTED'); }));
  app.use((err, req, res, next) => res.status(500).json({ code: 'test_global_boundary' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [payload, status, code] of [[{},428,'clinical_report_version_required'],[{expected_version:1},409,'clinical_report_version_conflict']]) {
      const r = await fetch(origin+'/report', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      assert.equal(r.status,status); assert.match(r.headers.get('content-type'),/application\/json/);
      const body = await r.json(); assert.equal(body.error.code,code); assert(!JSON.stringify(body).includes('stack'));
      if(status===409)assert.deepEqual(body.error.details,{expected_version:1,current_version:2});
    }
    const valid = await fetch(origin+'/report',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_version:2})});
    assert.equal(valid.status,200);assert.deepEqual(await valid.json(),{version:3});
    const denied=await fetch(origin+'/permission');assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'access_policy_forbidden');
    const unknown=await fetch(origin+'/unknown');assert.equal(unknown.status,500);assert.equal((await unknown.json()).code,'test_global_boundary');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
