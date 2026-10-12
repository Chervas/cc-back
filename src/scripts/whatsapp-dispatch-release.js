'use strict';
// Audited OS operator: prepare the existing runtime, then explicitly install.
// Does not access provider payloads, credentials, IAM or any other service.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const cp = require('node:child_process');
const SERVICE = 'clinicaclick-whatsapp-authorized.service';
const BASE = '/opt/clinicaclick-whatsapp-authorized/release-phone-unavailable-5e6d6d0e-20261001';
const TARGET = '/opt/clinicaclick-whatsapp-authorized/release-dispatch-capacity-20261012-v5';
const CONFIG = '/etc/clinicaclick-whatsapp-authorized/config.json';
const DROPIN = '/etc/systemd/system/' + SERVICE + '.d/zzzzzzzzzzzz-dispatch-capacity-20261012.conf';
const NODE = '/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node';
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const show = k => cp.execFileSync('systemctl', ['show', SERVICE, '--value', '-p', k], { encoding: 'utf8' }).trim();
function applyEdits(text, edits) {
  for (const edit of edits) {
    if (typeof edit.before !== 'string' || !edit.before || typeof edit.after !== 'string'
      || text.split(edit.before).length !== 2) throw Error('source_anchor_changed');
    text = text.replace(edit.before, edit.after);
  }
  return text;
}
async function verifyCandidate() {
  const assert = require('node:assert/strict');
  const { BrokerStore } = require(TARGET + '/src/store');
  const { Broker } = require(TARGET + '/src/broker');
  const { signRequest } = require(TARGET + '/src/auth');
  const C = require(TARGET + '/src/whatsapp-authorized-contract');
  const R = require(TARGET + '/src/whatsapp-send-receipt');
  const { createCapacity } = require(TARGET + '/src/whatsapp-dispatch-capacity');
  const directory = fs.mkdtempSync('/var/tmp/cc-dispatch-candidate-test-'); fs.chmodSync(directory, 0o700);
  const store = new BrokerStore(directory + '/state.sqlite'); const keys = crypto.generateKeyPairSync('ed25519');
  const binding = { connectionRef: 'connection:synthetic', provider: C.PROVIDER, initialState: 'active', expiresAt: null };
  const policy = { audience: 'broker:synthetic', version: 'qa-v1', maxBacklog: 5000,
    principals: [{ id: 'staging:whatsapp', keyId: 'qa-key', enabled: true, maxPerMinute: 600,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }], connections: [binding],
    grants: [1, 2].map(id => ({ principalId: 'staging:whatsapp', tenantRef: 'clinic:' + id,
      connectionRef: binding.connectionRef, assetRef: 'wa-phone:401', operations: [C.SEND, R.READ] })) };
  let sends = 0, secretReads = 0;
  const registry = { authorize() {}, assert() {} };
  const operations = { [C.SEND]: { provider: C.PROVIDER, validate: C.validateSend, project: C.projectResult,
    async execute() { sends++; return { messages: [{ id: 'wamid.FICTITIOUS_QA', message_status: 'accepted' }] }; } },
  [R.READ]: R.operation({ registry, store }) };
  const secrets = { invalidate() {}, async withSecret(_binding, fn) { secretReads++; return fn(Buffer.from('FICTITIOUS_ONLY')); } };
  const capacity = createCapacity({ store });
  const broker = new Broker({ store, policy, secrets, operations, admission: capacity });
  const request = { requestId: crypto.randomUUID(), tenantRef: 'clinic:1', connectionRef: binding.connectionRef,
    assetRef: 'wa-phone:401', operation: C.SEND, payload: { authorizationId: crypto.randomUUID(), phoneId: '401',
      message: { messaging_product: 'whatsapp', to: '34000000123', type: 'text', text: { body: 'FICTITIOUS_ONLY' } } } };
  const execute = value => { const s = signRequest(value, { audience: policy.audience, keyId: 'qa-key', privateKey: keys.privateKey });
    return broker.execute(s.raw, s.headers); };
  try {
    const release = capacity.acquire({ request }); const second = capacity.acquire({ request });
    await assert.rejects(execute(request), { code: 'whatsapp_capacity_concurrency' });
    assert.equal(sends, 0); assert.equal(store.db.prepare('SELECT count(*) n FROM commands').get().n, 0);
    release(); second(); await execute(request); await execute(request); assert.equal(sends, 1);
    const readsBefore = secretReads;
    const receipt = { ...request, requestId: crypto.randomUUID(), operation: R.READ,
      payload: { authorizationId: request.payload.authorizationId, phoneId: '401', intentId: request.requestId, send: request.payload } };
    assert.equal((await execute(receipt)).data.state, 'accepted'); assert.equal(secretReads, readsBefore);
    await assert.rejects(execute({ ...receipt, requestId: crypto.randomUUID(), tenantRef: 'clinic:2' }), { code: 'scope_denied' });
    assert.equal((await execute({ ...receipt, requestId: crypto.randomUUID(), payload: { ...receipt.payload, intentId: crypto.randomUUID() } })).data.state, 'absent');
    store.db.prepare("UPDATE commands SET state='unknown',result=NULL WHERE id=?").run(request.requestId);
    assert.equal((await execute({ ...receipt, requestId: crypto.randomUUID() })).data.state, 'unknown');
    assert.equal(sends, 1);
    const restart = new Broker({ store, policy, secrets, operations, admission: createCapacity({ store }) });
    const signed = signRequest(request, { audience: policy.audience, keyId: 'qa-key', privateKey: keys.privateKey });
    await assert.rejects(restart.execute(signed.raw, signed.headers), { code: 'outcome_unknown' });
    assert.equal(sends, 1);
    const beforeFlood = sends;
    for (let i = 0; i < 200; i++) {
      const commercial = { ...request, requestId: crypto.randomUUID(), payload: { ...request.payload, dispatchLane: 'commercial' } };
      try { await execute(commercial); } catch (error) { assert.equal(error.code, 'rate_limited'); }
    }
    await execute({ ...request, requestId: crypto.randomUUID(), tenantRef: 'clinic:2', payload: { ...request.payload, dispatchLane: 'commercial' } });
    await execute({ ...request, requestId: crypto.randomUUID() });
    assert.equal(sends - beforeFlood, 32);
    return { passed: true, checks: ['capacity_before_meta', 'stable_idempotency', 'secretless_receipt',
      'foreign_scope_denied', 'absent_receipt', 'unknown_receipt', 'restart_no_repeat', 'commercial_nonce_isolation'], realMetaCalls: 0 };
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
function main(plan, mode) {
  if (process.getuid() !== 0 || !['prepare', 'verify', 'install'].includes(mode) || plan?.version !== 1
    || !plan.baseHashes || !plan.newFiles || !plan.files || !plan.edits) throw Error('invalid_release_plan');
  if (!show('ExecStart').includes(BASE + '/src/whatsapp-authorized-main.js')) throw Error('runtime_baseline_changed');
  const raw = fs.readFileSync(CONFIG);
  if (digest(raw) !== '96a0d715a19f91ce10e7e3577c11ff5f7f1ab0e9d984302cb7a5686c6a11fcaf') throw Error('configuration_baseline_changed');
  const expected = ['broker.js', 'store.js', 'errors.js', 'whatsapp-authorized-main.js', 'whatsapp-authorized-contract.js',
    'whatsapp-authorized-operations.js', 'whatsapp-authorized-registry.js', 'whatsapp-activation-reader.js'];
  if (Object.keys(plan.baseHashes).sort().join() !== expected.sort().join()) throw Error('invalid_source_manifest');
  for (const file of expected) if (digest(fs.readFileSync(BASE + '/src/' + file)) !== plan.baseHashes[file]) throw Error('source_baseline_changed');
  if (Object.keys(plan.newFiles).sort().join() !== 'whatsapp-dispatch-capacity.js,whatsapp-send-receipt.js'
    || Object.keys(plan.edits).sort().join() !== 'broker.js,errors.js'
    || Object.keys(plan.files).sort().join() !== expected.filter(f => !plan.edits[f]).sort().join()) throw Error('invalid_patch_manifest');
  const config = JSON.parse(raw); const next = structuredClone(config);
  next.policy.version += ':dispatch-20261012';
  for (const principal of next.policy.principals) if (principal.id === 'staging:whatsapp') principal.maxPerMinute = 600;
  const receipt = 'meta.whatsapp.authorized.send-status.v1';
  for (const grant of next.policy.grants) if (grant.operations.includes('meta.whatsapp.authorized.send.v1')
    && !grant.operations.includes(receipt)) grant.operations.push(receipt);
  if (mode === 'prepare') {
    if (fs.existsSync(DROPIN)) throw Error('candidate_already_installed');
    if (fs.existsSync(TARGET)) {
      if (fs.existsSync(TARGET + '/dispatch-manifest.json')
        || !fs.lstatSync(TARGET).isDirectory() || fs.realpathSync(TARGET) !== TARGET) throw Error('candidate_already_exists');
      for (const file of expected) if (digest(fs.readFileSync(TARGET + '/src/' + file)) !== plan.baseHashes[file]) throw Error('candidate_changed');
      for (const file of Object.keys(plan.newFiles)) if (fs.existsSync(TARGET + '/src/' + file)) throw Error('candidate_changed');
      // Only the pinned, uninstalled copy from an aborted preparation, with all
      // original hashes intact and no new executable files, may be retried.
      fs.rmSync(TARGET, { recursive: true, force: true });
    }
    fs.cpSync(BASE, TARGET, { recursive: true, dereference: false, verbatimSymlinks: true });
    for (const [file, edits] of Object.entries(plan.edits)) {
      const candidate = applyEdits(fs.readFileSync(TARGET + '/src/' + file, 'utf8'), edits);
      fs.writeFileSync(TARGET + '/src/' + file, candidate, { mode: 0o644 });
    }
    for (const [file, entry] of Object.entries({ ...plan.files, ...plan.newFiles })) {
      const data = Buffer.from(entry.data, 'base64'); if (digest(data) !== entry.sha) throw Error('artifact_digest_invalid');
      fs.writeFileSync(TARGET + '/src/' + file, data, { mode: 0o644, ...(plan.newFiles[file] ? { flag: 'wx' } : {}) });
    }
    for (const file of [...expected, ...Object.keys(plan.newFiles)]) cp.execFileSync(NODE, ['--check', TARGET + '/src/' + file], { stdio: 'pipe' });
    require(TARGET + '/src/whatsapp-authorized-main').validateConfig(next);
    const manifest = Object.fromEntries([...expected, ...Object.keys(plan.newFiles)].map(file => [file, digest(fs.readFileSync(TARGET + '/src/' + file))]));
    fs.writeFileSync(TARGET + '/dispatch-manifest.json', JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, installed: false, candidate: TARGET, manifest })); return;
  }
  const manifest = JSON.parse(fs.readFileSync(TARGET + '/dispatch-manifest.json'));
  if (Object.keys(manifest).sort().join() !== [...expected, ...Object.keys(plan.newFiles)].sort().join()) throw Error('invalid_candidate_manifest');
  for (const [file, sha] of Object.entries(manifest)) if (digest(fs.readFileSync(TARGET + '/src/' + file)) !== sha) throw Error('candidate_changed');
  require(TARGET + '/src/whatsapp-authorized-main').validateConfig(next);
  if (mode === 'verify') return verifyCandidate().then(result => {
    const proof = { ...result, manifestSha: digest(JSON.stringify(manifest)) };
    fs.writeFileSync(TARGET + '/dispatch-verification.json', JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(proof));
  });
  const verified = JSON.parse(fs.readFileSync(TARGET + '/dispatch-verification.json'));
  if (!verified.passed || verified.realMetaCalls !== 0 || verified.manifestSha !== digest(JSON.stringify(manifest))) throw Error('candidate_not_verified');
  const sql = new (require('node:sqlite').DatabaseSync)(config.stateFile, { readOnly: true });
  try { if (sql.prepare("SELECT count(*) n FROM commands WHERE state='started' AND created_at>?").get(Date.now() - 60000).n) throw Error('broker_work_in_flight'); }
  finally { sql.close(); }
  const backup = TARGET + '/config-before.json'; fs.writeFileSync(backup, raw, { mode: 0o600, flag: 'wx' });
  const stat = fs.statSync(CONFIG); const nextFile = CONFIG + '.dispatch-next';
  fs.writeFileSync(nextFile, JSON.stringify(next), { mode: stat.mode & 0o777, flag: 'wx' }); fs.chownSync(nextFile, stat.uid, stat.gid);
  try {
    fs.renameSync(nextFile, CONFIG);
    fs.writeFileSync(DROPIN, '[Service]\nExecStart=\nExecStart=' + NODE + ' ' + TARGET + '/src/whatsapp-authorized-main.js ' + CONFIG + '\n', { mode: 0o644, flag: 'wx' });
    cp.execFileSync('systemctl', ['daemon-reload']); cp.execFileSync('systemctl', ['restart', SERVICE]); cp.execFileSync('sleep', ['2']);
    if (show('ActiveState') !== 'active' || show('SubState') !== 'running' || !show('ExecStart').includes(TARGET)) throw Error('runtime_not_running');
    console.log(JSON.stringify({ installed: true, service: SERVICE, release: TARGET, maxInFlight: 8,
      managementSlots: 2, maxPerMinute: 600, stagingNonceLimit: 600, credentialsChanged: false,
      configurationSha: digest(fs.readFileSync(CONFIG)), manifest }));
  } catch (error) {
    fs.writeFileSync(CONFIG, raw, { mode: stat.mode & 0o777 }); fs.chownSync(CONFIG, stat.uid, stat.gid);
    if (fs.existsSync(DROPIN)) fs.unlinkSync(DROPIN);
    cp.execFileSync('systemctl', ['daemon-reload']); cp.execFileSync('systemctl', ['restart', SERVICE]);
    console.log(JSON.stringify({ installed: false, rollback: show('ActiveState') === 'active', error: error.code || error.name })); throw error;
  }
}
if (require.main === module) {
  Promise.resolve().then(() => main(JSON.parse(fs.readFileSync(process.argv[2])), process.argv[3])).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.code || error.message, installed: false }) + '\n'); process.exitCode = 1;
  });
}
module.exports = { main, applyEdits };
