'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const http = require('node:http');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { BrokerStore } = require('../src/store');
const { createInboxCipher, createWhatsappInbox, MAX_BYTES } = require('../src/whatsapp-inbox');
const { createWhatsappInboxHandler } = require('../src/whatsapp-inbox-http');
const network = require('./offline-guard.cjs');
const APP = Buffer.from('FICTITIOUS_APP_SECRET_FOR_INBOX_QA');
const body = (changes = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: '301', changes: [{ field: 'messages',
  value: { metadata: { phone_number_id: '401' }, messages: [{ id: 'synthetic-wamid', from: '34000000001', text: { body: 'FICTITIOUS_CANCEL_REQUEST' } }] }, ...changes }] }] });
const packet = (value = body()) => { const raw = Buffer.from(JSON.stringify(value)); return { raw, appSecret: APP, signature: 'sha256=' + createHmac('sha256', APP).update(raw).digest('hex') }; };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wa-inbox-')); fs.chmodSync(dir, 0o700);
  const filename = path.join(dir, 'inbox.sqlite'); const key = randomBytes(32);
  let store; let cipher; let inbox; let clock = Date.now();
  const open = () => {
    store = new BrokerStore(filename); cipher = createInboxCipher({ key, keyId: 'synthetic-key-v1' });
    inbox = createWhatsappInbox({ store, cipher, appId: '101', bindings: [{ wabaId: '301', phoneIds: ['401'] }],
      auditContext: { tenantRef: 'clinic:71', connectionRef: 'connection:wa-inbox-qa', resourceRef: 'wa-inbox:101',
        policyVersion: 'wa-inbox-qa-v1', operation: 'whatsapp.webhook.capture' }, now: () => clock, ...options });
  };
  open(); t.after(() => { cipher.close(); store.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, get store() { return store; }, get inbox() { return inbox; }, advance(ms) { clock += ms; },
    restart() { cipher.close(); store.close(); open(); } };
}
test('signed batch is encrypted and audited before ACK, survives restart and deduplicates without a business action', t => {
  const f = fixture(t); const input = packet(); const first = f.inbox.accept(input);
  assert.equal(first.persisted, true); assert.equal(first.businessProcessed, false);
  assert.equal(f.store.db.prepare('SELECT state FROM whatsapp_inbox').get().state, 'held');
  assert.equal(f.store.backlog().pending, 1);
  for (const suffix of ['', '-wal']) {
    const file = f.filename + suffix;
    if (fs.existsSync(file)) assert(!fs.readFileSync(file).includes(Buffer.from('FICTITIOUS_CANCEL_REQUEST')));
  }
  const log = JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert(!log.includes('34000000001')); assert(!log.includes('FICTITIOUS_CANCEL_REQUEST'));
  f.restart(); const second = f.inbox.accept(input);
  assert.equal(second.receipt, first.receipt); assert.equal(second.replayed, true);
  assert.equal(f.store.backlog().pending, 1);
});
test('missing signature, altered raw bytes, foreign phone and mixed foreign WABA never create partial receipts', t => {
  const f = fixture(t); const a = packet();
  assert.throws(() => f.inbox.accept({ ...a, signature: 'sha256=' + '0'.repeat(64) }), { code: 'invalid_signature' });
  assert.throws(() => f.inbox.accept({ ...a, raw: Buffer.concat([a.raw, Buffer.from(' ')]) }), { code: 'invalid_signature' });
  const foreign = body(); foreign.entry[0].changes[0].value.metadata.phone_number_id = '999';
  assert.throws(() => f.inbox.accept(packet(foreign)), { code: 'scope_denied' });
  const mixed = body(); mixed.entry.push({ ...mixed.entry[0], id: '999' });
  assert.throws(() => f.inbox.accept(packet(mixed)), { code: 'scope_denied' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 0);
  assert.equal(f.store.backlog().pending, 0);
});
test('full storage and audit failure remain retryable and roll back the ciphertext insertion', t => {
  const f = fixture(t, { maxRows: 1 }); f.inbox.accept(packet());
  assert.throws(() => f.inbox.accept(packet(body({ field: 'history' }))), { code: 'audit_unavailable' });
  const g = fixture(t); g.store.appendAudit = () => { throw Error('FICTITIOUS_STORAGE_ERROR'); };
  assert.throws(() => g.inbox.accept(packet()), e => e.code === 'audit_unavailable' && !e.stack.includes('FICTITIOUS_STORAGE_ERROR'));
  assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 0);
});
test('bulk history retains every contact with no automatic business actions', t => {
  const f = fixture(t); const input = packet(body({ field: 'history', value: { metadata: { phone_number_id: '401' },
    history: [{ threads: Array.from({ length: 2000 }, (_, i) => ({ id: String(34000000001 + i), messages: [{ id: 'synthetic-' + i, text: { body: 'synthetic history' } }] })) }] } }));
  const r = f.inbox.accept(input); const lease = f.inbox.lease(r.receipt);
  assert.equal(lease.automaticActionsAllowed, false); assert(lease.raw.equals(input.raw));
  assert.equal(JSON.parse(lease.raw).entry[0].changes[0].value.history[0].threads.length, 2000);
  lease.raw.fill(0);
});
test('lease ownership, expiry and import receipt protect retries and duplicate consumers', t => {
  const f = fixture(t); const r = f.inbox.accept(packet()); const first = f.inbox.lease(r.receipt);
  assert.throws(() => f.inbox.lease(r.receipt), { code: 'scope_denied' });
  f.advance(60001); f.restart(); const second = f.inbox.lease(r.receipt);
  assert.notEqual(second.lease, first.lease);
  const completion = { receipt: r.receipt, lease: second.lease, importReceipt: randomUUID() };
  assert.throws(() => f.inbox.confirm({ ...completion, lease: first.lease }), { code: 'scope_denied' });
  assert.equal(f.inbox.confirm(completion).businessProcessed, true);
  assert.equal(f.inbox.confirm(completion).businessProcessed, true);
  assert.throws(() => f.inbox.confirm({ ...completion, importReceipt: randomUUID() }), { code: 'idempotency_conflict' });
  assert.throws(() => f.inbox.lease(r.receipt), { code: 'scope_denied' });
  assert.equal(f.inbox.accept(packet()).businessProcessed, true);
  first.raw.fill(0); second.raw.fill(0);
});
test('ciphertext or authenticated scope tampering prevents an ACK and import', t => {
  const f = fixture(t); const r = f.inbox.accept(packet());
  f.store.db.prepare('UPDATE whatsapp_inbox SET scopes=? WHERE receipt=?').run('["301:999"]', r.receipt);
  assert.throws(() => f.inbox.accept(packet()), { code: 'secret_unavailable' });
  assert.throws(() => f.inbox.lease(r.receipt), { code: 'secret_unavailable' });
});
test('HTTP returns 200 only after durable storage; duplicate signatures and unavailable audit cannot be acknowledged', async t => {
  const f = fixture(t); let allowed = true;
  const handler = createWhatsappInboxHandler({ inbox: f.inbox, withApplicationSecret: async work => {
    if (!allowed) throw Error('FICTITIOUS_SECRET_UNAVAILABLE'); return work(APP);
  } });
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  network.allowPort(server.address().port); t.after(() => new Promise(resolve => { network.removePort(server.address().port); server.close(resolve); }));
  const send = signature => new Promise((resolve, reject) => {
    const input = packet(); const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature || input.signature } }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, retry: res.headers['retry-after'] }));
    }); req.on('error', reject); req.end(input.raw);
  });
  assert.equal((await send()).status, 200); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 1);
  assert.equal((await send([packet().signature, packet().signature])).status, 401);
  allowed = false; const failed = await send(); assert.equal(failed.status, 503); assert.equal(failed.retry, '60'); assert(!failed.body.includes('FICTITIOUS'));
});

test('Additive onboarding role upgrade preserves held inbox ciphertext and passive replay without business work', t => {
  const f=fixture(t),input=packet(),first=f.inbox.accept(input);
  f.store.db.exec('ALTER TABLE whatsapp_onboarding_flows DROP COLUMN channel_role');
  const before=f.store.db.prepare('SELECT * FROM whatsapp_inbox WHERE receipt=?').get(first.receipt);
  const auditBefore=f.store.backlog().pending;
  f.restart();
  assert(f.store.db.prepare('PRAGMA table_info(whatsapp_onboarding_flows)').all().some(v=>v.name==='channel_role'));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM whatsapp_inbox WHERE receipt=?').get(first.receipt),before);
  const replay=f.inbox.accept(input);assert.equal(replay.receipt,first.receipt);assert.equal(replay.businessProcessed,false);
  assert.equal(f.store.backlog().pending,auditBefore);
  const lease=f.inbox.lease(first.receipt);assert.equal(lease.automaticActionsAllowed,false);assert(lease.raw.equals(input.raw));lease.raw.fill(0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,0);
});
test('poison backlog cannot starve new receipts, survives restart, and never fakes an import ACK', t => {
  const f=fixture(t); const old=[];
  for(let n=0;n<240;n++) {
    const r=f.inbox.accept(packet(body({field:'synthetic_'+String(n).replace(/\d/g,c=>String.fromCharCode(97+Number(c)))})));
    const lease=f.inbox.lease(r.receipt);lease.raw.fill(0);
    f.inbox.defer({receipt:lease.receipt,lease:lease.lease,reason:'unsupported_event'});old.push(lease);
  }
  f.advance(1000);const fresh=f.inbox.accept(packet());
  assert.equal(f.inbox.pending(20)[0].receipt,fresh.receipt);
  assert.equal(f.inbox.health().groups[0].review,240);
  f.restart();assert.equal(f.inbox.pending(20)[0].receipt,fresh.receipt);
  const taken=f.inbox.lease(fresh.receipt);taken.raw.fill(0);
  f.inbox.confirm({receipt:taken.receipt,lease:taken.lease,importReceipt:randomUUID()});
  f.advance(60001);
  const retry=f.inbox.lease(old[0].receipt);retry.raw.fill(0);
  assert.throws(()=>f.inbox.defer({receipt:retry.receipt,lease:old[0].lease,reason:'unsupported_event'}),{code:'scope_denied'});
  assert.equal(f.inbox.defer({receipt:retry.receipt,lease:retry.lease,reason:'unsupported_event'}).businessProcessed,false);
  assert.throws(()=>f.inbox.lease(retry.receipt),{code:'scope_denied'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,1);
});
test('a crashed consumer rotates failed leases behind newly arrived work',t=>{
 const f=fixture(t),a=f.inbox.accept(packet());f.advance(1);
 const b=f.inbox.accept(packet(body({field:'history'})));f.advance(1);
 f.inbox.lease(a.receipt).raw.fill(0);f.advance(60001);f.restart();
 assert.equal(f.inbox.pending()[0].receipt,b.receipt);
});
