'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const C = require('../../services/whatsappAuthorizationState.contract');
const { createService } = require('../../services/whatsappAuthorizationState.service');
const input = () => ({ requestId: randomUUID(), userId: 501, sessionRef: randomUUID(), sessionExpiresAt: 1900000000, scope: { type: 'clinic', id: 71 } });
test('Strict request schema rejects ambiguous IDs, unbounded code, leaked fields and unknown operations', () => {
  for (const changes of [{ userId: '501' }, { scope: { type: 'clinic', id: '71extra' } }, { scope: { type: 'group', id: 0 } },
    { sessionExpiresAt: 8640000000001 }, { sessionExpiresAt: 1.5 }, { token: 'FICTITIOUS' }, { requestId: 'bad' }]) {
    assert.throws(() => C.request({ ...input(), ...changes }, 'issue'), { code: 'whatsapp_authorization_invalid' });
  }
  assert.throws(() => C.request(input(), 'unknown'));
  const claim = input(); delete claim.scope; claim.state = 's'.repeat(43); claim.code = 'FICTITIOUS_CODE';
  assert.deepEqual(C.request(claim, 'claim'), claim);
  for (const code of ['', 'x'.repeat(4097), 'bad\ncode', 'non ascii é']) assert.throws(() => C.request({ ...claim, code }, 'claim'));
  const source = input(); const copy = C.request(source, 'issue'); source.scope.id = 99; assert.equal(copy.scope.id, 71);
});
test('Disabled or wrong runtime/MFA/audit config fails before model access', async () => {
  await assert.rejects(createService({ config: () => C.settings({}), models: () => assert.fail('models accessed') }).issue(input()), { code: 'whatsapp_onboarding_disabled' });
  const env = { WHATSAPP_ONBOARDING_ENABLED: 'true', RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', QUEUE_PREFIX: 'gateway',
    JOBS_WORKER_ENABLED: 'false', CRON_ENABLED: 'false', AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce',
    PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1',
    PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED: 'true', PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY: 'whatsapp-onboarding-v1' };
  const root = fs.mkdtempSync('/tmp/cc-whatsapp-state-key-'); fs.chmodSync(root, 0o700);
  try {
    const file = path.join(root, 'key'); fs.writeFileSync(file, Buffer.alloc(32, 6), { mode: 0o600 }); env.WHATSAPP_ONBOARDING_STATE_KEY_FILE = file;
    const cfg = C.settings(env); assert.equal(cfg.key.length, 32); cfg.key.fill(0);
    for (const changes of [{ RUNTIME_ROLE: 'api' }, { JOB_RUNTIME_NAMESPACE: 'dev' }, { QUEUE_PREFIX: 'staging' },
      { JOBS_WORKER_ENABLED: 'true' }, { CRON_ENABLED: 'true' }, { AUTH_SESSION_MODE: 'legacy' },
      { AUTH_EMAIL_MFA_MODE: 'off' }, { PLATFORM_AUDIT_AUTH_ENABLED: 'false' },
      { PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED: 'false' }, { PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY: 'wrong' }]) {
      assert.throws(() => C.settings({ ...env, ...changes }));
    }
    fs.chmodSync(file, 0o644); assert.throws(() => C.settings(env)); fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, path.join(root, 'symlink')); assert.throws(() => C.settings({ ...env, WHATSAPP_ONBOARDING_STATE_KEY_FILE: path.join(root, 'symlink') }));
    fs.writeFileSync(file, Buffer.alloc(31)); assert.throws(() => C.settings(env));
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('Internal DB errors are sanitized and ephemeral state key is erased', async () => {
  const key = Buffer.alloc(32, 4);
  const service = createService({ config: () => ({ key }), models: { sequelize: { transaction: async () => { throw Error('FICTITIOUS_SQL_SECRET'); } } } });
  await assert.rejects(service.issue(input()), e => e.code === 'whatsapp_authorization_unavailable' && !e.message.includes('FICTITIOUS'));
  assert(key.every(byte => byte === 0));
});
test('Email step-up preserves the authenticated session and stops before scope or authorization writes', async () => {
  const key = Buffer.alloc(32, 8); let checked = false;
  const service = createService({ config: () => ({ key }),
    models: { sequelize: { transaction: async (options, work) => work({}) }, Clinica: { findAll: () => assert.fail('scope read after step-up rejection') } },
    sessions: { verifyReference: async (actor, options) => {
      assert.equal(options.requireEmail, true); checked = true;
      throw Object.assign(Error('FICTITIOUS_INTERNAL_SECRET'), { code: 'auth_email_verification_required', status: 403 });
    } } });
  await assert.rejects(service.issue(input()), { code: 'auth_email_verification_required', status: 403, message: 'auth_email_verification_required' });
  assert(checked); assert(key.every(byte => byte === 0));
});

test('Channel intent is optional primary by default, strict when supplied and cryptographically bound for new states', () => {
  for (const channelRole of ['primary','secondary']) assert.equal(C.request({...input(),channelRole},'issue').channelRole,channelRole);
  for (const channelRole of [null,'PRIMARY','other',false,{},['secondary']]) assert.throws(()=>C.request({...input(),channelRole},'issue'));
  const row = {request_id:randomUUID(),user_id:501,session_ref:randomUUID(),session_expires_at:new Date('2030-01-01T01:00:00Z'),
    scope_type:'clinic',scope_id:71,original_clinic_ids:[71],scope_digest:C.digest('fixture'),
    created_at:new Date('2030-01-01T00:00:00Z'),expires_at:new Date('2030-01-01T00:10:00Z')};
  const v1 = C.digest(JSON.stringify(['whatsapp-onboarding-v1',row.request_id,row.user_id,row.session_ref,row.session_expires_at.toISOString(),
    row.scope_type,row.scope_id,row.original_clinic_ids,row.scope_digest,row.created_at.toISOString(),row.expires_at.toISOString()]));
  assert.equal(C.contextDigest(row),v1); assert.equal(C.contextDigest({...row,channel_role:null}),v1);
  const primary=C.contextDigest({...row,channel_role:'primary'}),secondary=C.contextDigest({...row,channel_role:'secondary'});
  assert.notEqual(primary,v1);assert.notEqual(primary,secondary);assert.notEqual(secondary,v1);
  assert.throws(()=>C.contextDigest({...row,channel_role:'invalid'}));
});
