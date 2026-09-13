'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http'); const express = require('express');
const { patientFixture } = require('./fixtures/patient_read.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function serverFixture(t, options) {
  const f = patientFixture(options); const app = express(); app.use('/pacientes', f.router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const get = async (path, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, agent, path: '/pacientes' + path,
      headers: authenticated ? { authorization: 'FICTITIOUS_TOKEN' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject);
  });
  return { ...f, get };
}
test('seven actual GET routes preserve successful DTOs and emit closed patient audit events', async t => {
  const f = await serverFixture(t, { allowed: [71, 72], members: [71, 72] });
  for (const [path, action] of [['/?clinica_id=71&limit=20', 'patient.list'], ['/search?clinica_id=71&q=fictitious', 'patient.search'],
    ['/contact-targets?clinica_id=71&q=fictitious', 'patient.contact_targets'], ['/check-duplicates?clinica_id=71&telefono=34600000000', 'patient.duplicate_check'],
    ['/901/consents', 'patient.legacy_consents.read'], ['/901', 'patient.detail.read'], ['/901/activity', 'patient.activity.read']]) {
    const result = await f.get(path); assert.equal(result.status, 200, JSON.stringify({ path, body: result.body }));
    assert.equal(result.headers['cache-control'], 'private, no-store'); const last = f.state.rows.at(-1);
    assert.equal(last.action, action); assert.equal(last.reason, 'response_prepared'); assert.deepEqual(last.patientIds, ['901']);
  }
  assert.equal(f.state.rows.length, 14); assert.deepEqual(f.state.unexpected, []);
  assert(!/FICTITIOUS_|600000000|pac_fictitious/.test(JSON.stringify(f.state.rows)));
});
test('authentication and full consent scope deny without leaking a patient or creating a public ID', async t => {
  const f = await serverFixture(t, { allowed: [], missingPublicId: true });
  assert.equal((await f.get('/901', false)).status, 401); assert.equal(f.state.rows.length, 0);
  assert.equal((await f.get('/901')).status, 403); assert.equal(f.state.writes, 0);
  f.state.allowed = [71]; assert.equal((await f.get('/901/consents')).status, 403);
  assert(!JSON.stringify(f.state.rows).includes('FICTITIOUS_'));
});
test('contact target projection removes foreign clinic links and preserves contact response fields', async t => {
  const f = await serverFixture(t); const result = await f.get('/contact-targets?clinica_id=71&q=patient');
  assert.equal(result.status, 200); assert.equal(result.body.items[0].conversation_id, 81);
  assert.deepEqual(result.body.items[0].patient.clinicasVinculadas.map(x => x.clinica_id), [71]);
  assert(!JSON.stringify(result.body).includes('FICTITIOUS_FOREIGN_CLINIC'));
});
test('redacted duplicate detection retains existence without exposing foreign identifiers in audit', async t => {
  const f = await serverFixture(t, { sensitive: false });
  const result = await f.get('/check-duplicates?clinica_id=71&telefono=34600000000');
  assert.equal(result.status, 200); assert.equal(result.body.exists, true); assert.equal(result.body.paciente, null);
  assert.deepEqual(f.state.rows.at(-1).patientIds, []); assert.equal(f.state.rows.at(-1).resultCount, 1);
});
test('partially visible duplicates derive their clinic label and message from the authorized projection', async t => {
  const f = await serverFixture(t, { allowed: [71, 73], members: [73], patient: { clinica_id: 72,
    clinica: { id_clinica: 72, nombre_clinica: 'FICTITIOUS_FOREIGN_CLINIC' },
    clinicasVinculadas: [{ clinica_id: 73, clinica: { id_clinica: 73, nombre_clinica: 'FICTITIOUS_VISIBLE_CLINIC' } }] } });
  const result = await f.get('/check-duplicates?clinica_id=71&telefono=34600000000');
  assert.equal(result.status, 200); assert.equal(result.body.privacy_redacted, false);
  assert(!JSON.stringify(result.body).includes('FICTITIOUS_FOREIGN_CLINIC'));
  assert.match(result.body.message, /FICTITIOUS_VISIBLE_CLINIC/); assert.deepEqual(f.state.rows.at(-1).clinicIds, ['73']);
});
test('membership changes at both rechecks suppress the prepared clinical body', async () => {
  for (const at of [1, 2]) {
    const f = patientFixture(); f.state.onMembership = n => { if (n === at) f.state.members = [72]; };
    const result = await f.invoke('getAllPacientes'); assert.equal(result.status, 403);
    assert(!JSON.stringify(result.body).includes('FICTITIOUS_')); assert.equal(f.state.rows.at(-1).stage, at === 1 ? 'completed' : 'discarded');
  }
});
test('revocation while committing the read returns 401 and a discard record', async t => {
  const f = await serverFixture(t); f.state.afterCommit = () => { f.state.revoked = true; };
  assert.equal((await f.get('/901')).status, 401); assert.equal(f.state.rows.at(-1).stage, 'discarded');
});
test('empty early-return paths remain audited; disabled capture makes no extra SQL checks', async () => {
  for (const name of ['searchPacientes', 'searchPatientContactTargets', 'checkDuplicates']) {
    const f = patientFixture(); assert.equal((await f.invoke(name)).status, 200); assert.equal(f.state.rows.at(-1).patientCount, 0);
  }
  const f = patientFixture({ env: { PLATFORM_AUDIT_PATIENT_READS_ENABLED: 'false' } });
  assert.equal((await f.invoke('getAllPacientes')).status, 200); assert.equal(f.state.memberChecks, 0); assert.equal(f.state.rows.length, 0);
});
test('a controller catch cannot turn an audit metadata limit into a domain error or leak its response', async () => {
  const f = patientFixture({ allowed: Array.from({ length: 101 }, (_,i) => i + 1) });
  const result = await f.invoke('getAllPacientes', { query: {} });
  assert.equal(result.status, 503); assert.equal(result.body.error, 'patient_read_audit_unavailable');
  assert.equal(f.state.rows.at(-1).reason, 'operation_unconfirmed'); assert.deepEqual(f.state.rows.at(-1).patientIds, []);
});
test('audit outage blocks the read, while SQL/provider-style errors cannot escape through the seven handlers', async () => {
  const f = patientFixture({ auditFailure: true }); assert.equal((await f.invoke('getPacienteById')).status, 503); assert.equal(f.state.queries.length, 0);
  for (const name of ['getAllPacientes', 'getPacienteById', 'getPacienteActivity', 'searchPatientContactTargets']) {
    const g = patientFixture({ readFailure: true }); const result = await g.invoke(name, { query: { clinica_id: '71', q: 'sentinel' } });
    assert.equal(result.status, 500); assert.equal(result.body.error, 'patient_read_failed');
    assert(!JSON.stringify([result, g.state.rows, g.state.logs]).includes('FICTITIOUS_SQL_SECRET'));
  }
});
