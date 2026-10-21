'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const bcrypt = require('bcryptjs');
function load(file, overrides, env = {}) {
  const local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, Date, Map, Set, Object,
    process: { env }, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  return module.exports;
}
function fixture({ group = false, configured = true, deniedClinic = null, resets = 0, duplicate = false, env = {} } = {}) {
  const changes = [], row = value => Object.assign(value, { async update(values, options) {
    assert(options.transaction); changes.push(values); Object.assign(this, values); return this;
  }, async reload(options) { assert.equal(options.lock, 'UPDATE'); return this; } });
  const firm = row({ id: 11, public_id: 'fictitious-firm', scope_key: group ? 'group:7' : 'clinic:72', scope_type: group ? 'group' : 'clinic',
    group_id: group ? 7 : null, primary_clinic_id: group ? null : 72, name: 'Gestoría ficticia', active: true });
  const clinics = [{ id_clinica: 72, nombre_clinica: 'Clínica ficticia', grupoClinicaId: group ? 7 : null },
    ...(group ? [{ id_clinica: 73, nombre_clinica: 'Segunda ficticia', grupoClinicaId: 7 }] : [])];
  const users = configured ? [row({ id_usuario: 90, email_usuario: 'gestor@example.test', estado_cuenta: 'activo', password_usuario: 'old-hash' })] : [];
  if (duplicate) users.push(row({ id_usuario: 91, email_usuario: 'different@example.test', emails_alternativos: ['other@example.test'] }));
  const links = configured ? [row({ firm_id: 11, user_id: 90, status: 'active' })] : [];
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, revoked = {}, audit = [];
  const db = { sequelize: { transaction: async work => work(tx) },
    AccountingFirm: { findOne: async () => firm, findByPk: async () => firm },
    Clinica: { findByPk: async id => clinics.find(c => c.id_clinica === id), findAll: async options => clinics.filter(c =>
      options.where.grupoClinicaId ? c.grupoClinicaId === options.where.grupoClinicaId : c.id_clinica === options.where.id_clinica) },
    GrupoClinica: {}, AccountingFirmClinicAssignment: { upsert: async () => {}, destroy: async () => {} },
    AccountingFirmUser: { findOne: async options => links.find(link => Object.entries(options.where).every(([key, value]) => link[key] === value)) || null,
      create: async values => { const link = row(values); links.push(link); return link; } },
    Usuario: { findByPk: async id => users.find(u => u.id_usuario === id), findAll: async options => { assert.equal(options.lock, 'UPDATE'); return users; },
      create: async values => { const user = row({ id_usuario: 90, ...values }); users.push(user); return user; } },
    UsuarioClinica: { findOrCreate: async () => [row({ rol_clinica: 'personaldeclinica', subrol_clinica: 'Gestoría' })], destroy: async () => {} },
    SyncLog: { count: async () => resets, create: async (values, options) => { assert.equal(options.transaction, tx); audit.push(values); } },
  };
  for (const key of ['AuthSession', 'AuthEmailChallenge', 'AuthTrustedDevice', 'PasswordResetToken']) db[key] = { update: async (values, options) => {
    assert.equal(options.where.user_id, 90); assert.equal(options.transaction, tx); revoked[key] = values;
  } };
  const acl = [];
  const service = load(require.resolve('../../services/accountingFirms.service'), { '../../models': db,
    '../lib/access-policy': { canUserAccessFeature: async input => { acl.push(input); return input.actorId === 5 && input.clinicId !== deniedClinic; } } }, env);
  return { service, firm, clinics, users, links, changes, revoked, audit, acl };
}

test('credentials are CSPRNG, bcrypt12 and one-time; reset invalidates all existing authentication proofs without sending mail', async () => {
  const f = fixture(), first = await f.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'GESTOR@example.test' });
  assert.match(first.credentials.password, /^[A-Za-z0-9_-]{43}$/);
  assert.match(f.users[0].password_usuario, /^\$2[ab]\$12\$/);
  assert(await bcrypt.compare(first.credentials.password, f.users[0].password_usuario));
  assert.equal(f.users[0].email_usuario, 'gestor@example.test');
  assert.deepEqual(Object.keys(f.revoked).sort(), ['AuthEmailChallenge', 'AuthSession', 'AuthTrustedDevice', 'PasswordResetToken']);
  assert(!JSON.stringify(f.audit).includes(first.credentials.password));
  assert.equal((await f.service.getFirm({ clinicId: 72 })).credentials, undefined);
  const second = await f.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' });
  assert.notEqual(first.credentials.password, second.credentials.password);
  assert(!await bcrypt.compare(first.credentials.password, f.users[0].password_usuario));
});
test('new access requires an explicit mailbox and cannot claim primary or alternate identity or exceed the durable reset limit', async () => {
  for (const email of [undefined, '', 'bad', 'gestoria+clinic-72@acceso.clinicaclick.com']) {
    const f = fixture({ configured: false });
    await assert.rejects(f.service.issueCredentials({ clinicId: 72, actorId: 5, email }), { code: 'accounting_firm_email_required' });
    assert.equal(f.users.length, 0);
  }
  const collision = fixture({ duplicate: true });
  await assert.rejects(collision.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'other@example.test' }), { code: 'accounting_firm_email_in_use' });
  assert.equal(collision.changes.length, 0);
  const limited = fixture({ resets: 5 });
  await assert.rejects(limited.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' }), { code: 'accounting_firm_rate_limited' });
  assert.equal(limited.changes.length, 0);
});
test('managing one clinic never grants credentials or revocation over another clinic in its group', async () => {
  for (const action of ['issueCredentials', 'revokeAccess']) {
    const f = fixture({ group: true, deniedClinic: 73 });
    await assert.rejects(f.service[action]({ clinicId: 72, actorId: 5, email: 'gestor@example.test' }), { code: 'accounting_firm_scope_forbidden' });
    assert.equal(f.changes.length, 0); assert(f.acl.some(value => value.clinicId === 73));
  }
});
test('revocation closes account/proofs and remains a portal identity; explicit reset can restore only that identity', async () => {
  const f = fixture(); await f.service.revokeAccess({ clinicId: 72, actorId: 5 });
  assert.equal(f.users[0].estado_cuenta, 'inactivo'); assert.equal(f.links[0].status, 'revoked');
  assert.equal(await f.service.isPortalUser({ actorId: 90 }), true);
  await assert.rejects(f.service.portalScope({ actorId: 90 }), { code: 'accounting_portal_forbidden' });
  const count = f.changes.length; await f.service.revokeAccess({ clinicId: 72, actorId: 5 }); assert.equal(f.changes.length, count);
  await f.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' });
  assert.equal(f.users.length, 1); assert.equal(f.users[0].estado_cuenta, 'activo'); assert.equal(f.links[0].status, 'active');
});
test('portal scope follows current group composition and rejects malformed or foreign clinic requests', async () => {
  const f = fixture({ group: true }); assert.equal((await f.service.portalScope({ actorId: 90 })).clinics.length, 2);
  f.clinics[1].grupoClinicaId = 99;
  await assert.rejects(f.service.assertPortalClinic({ actorId: 90, clinicId: 73 }), { code: 'accounting_portal_clinic_forbidden' });
  await assert.rejects(f.service.assertPortalClinic({ actorId: 90, clinicId: '72junk' }), { code: 'accounting_portal_clinic_forbidden' });
  assert.equal((await f.service.assertPortalClinic({ actorId: 90, clinicId: 72 })).clinicId, 72);
});

test('portal credentials use the canonical public frontend in CRM and preserve the isolated DEV origin', async () => {
  const crm = fixture({ env: { RUNTIME_NAMESPACE: 'staging', EMAIL_PUBLIC_APP_URL: 'https://crm.clinicaclick.com/' } });
  const issued = await crm.service.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' });
  assert.equal(issued.portal_url, 'https://crm.clinicaclick.com/gestoria');
  assert(issued.credentials.message.includes('URL: https://crm.clinicaclick.com/gestoria\n'));
  assert.equal((await crm.service.getFirm({ clinicId: 72 })).portal_url, issued.portal_url);
  assert(!issued.credentials.message.includes('localhost'));
  for (const env of [{ RUNTIME_NAMESPACE: 'dev' }, { RUNTIME_NAMESPACE: 'dev', EMAIL_PUBLIC_APP_URL: 'http://localhost:4203/' }]) {
    const dev = fixture({ env });
    assert.equal((await dev.service.getFirm({ clinicId: 72 })).portal_url, 'http://localhost:4203/gestoria');
  }
});
test('portal URL keeps explicit overrides and frontend-base precedence without a localhost fallback for an unconfigured public runtime', async () => {
  for (const [env, expected] of [
    [{ ACCOUNTING_PORTAL_URL: 'https://accounting.example.test/gestoria/', EMAIL_PUBLIC_APP_URL: 'https://crm.example.test' }, 'https://accounting.example.test/gestoria'],
    [{ EMAIL_PUBLIC_APP_URL: ' https://crm.example.test/ ', FRONTEND_PUBLIC_URL: 'https://other.example.test' }, 'https://crm.example.test/gestoria'],
    [{ FRONTEND_PUBLIC_URL: 'https://crm.example.test/app/' }, 'https://crm.example.test/app/gestoria'],
    [{ RUNTIME_NAMESPACE: 'staging' }, 'https://crm.clinicaclick.com/gestoria'],
    [{}, 'https://crm.clinicaclick.com/gestoria'],
  ]) assert.equal((await fixture({ env }).service.getFirm({ clinicId: 72 })).portal_url, expected);
});
