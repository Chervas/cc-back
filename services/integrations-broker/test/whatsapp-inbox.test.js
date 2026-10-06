'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const http = require('node:http');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { BrokerStore } = require('../src/store');
const { createInboxCipher, createWhatsappInbox, MAX_BYTES } = require('../src/whatsapp-inbox');
const { createWhatsappInboxHandler } = require('../src/whatsapp-inbox-http');
const { verifyArchiveEnvelope } = require('../src/whatsapp-inbox-archive');
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
  return { dir, filename, get store() { return store; }, get inbox() { return inbox; }, get cipher() { return cipher; }, advance(ms) { clock += ms; },
    restart() { cipher.close(); store.close(); open(); } };
}
test('durable authenticated isolation covers more than 100 contacts across restart without importing them', t => {
  const f = fixture(t, { scopeBindings: [{ wabaId: '301', phoneId: '401', clinicIds: [71] }] });
  for (let n = 0; n < 220; n++) {
    const value = body(); value.entry[0].changes[0].value.messages[0].from = String(34000000001 + n);
    value.entry[0].changes[0].value.messaging_product = 'whatsapp';
    const r = f.inbox.accept(packet(value)); const lease = f.inbox.lease(r.receipt); lease.raw.fill(0);
    f.inbox.defer({ receipt: r.receipt, lease: lease.lease, reason: 'review_required' });
  }
  f.restart();
  const group = f.inbox.health().groups[0];
  assert.equal(group.blockingReview, 220); assert.equal(group.reviewIsolation.scopedReviews, 220);
  assert.equal(group.reviewIsolation.contacts.length, 220);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n, 0);
  assert(!fs.readFileSync(f.filename).includes(Buffer.from('34000000001')));
  const receipt = f.store.db.prepare('SELECT receipt FROM whatsapp_inbox LIMIT 1').get().receipt;
  f.store.db.prepare('UPDATE whatsapp_inbox SET review_metadata=? WHERE receipt=?').run(Buffer.alloc(40), receipt);
  assert.equal(f.inbox.health().groups[0].reviewIsolation.scopedReviews, 219);
});
test('legacy isolation backfills in bounded steps and retry scheduling never acknowledges a review', t => {
  const f = fixture(t, { scopeBindings: [{ wabaId: '301', phoneId: '401', clinicIds: [71] }] });
  let last;
  for (let n = 0; n < 220; n++) {
    const value = body(); value.entry[0].changes[0].value.messages[0].from = String(34000000001 + n);
    value.entry[0].changes[0].value.messaging_product = 'whatsapp';
    const r = f.inbox.accept(packet(value)); const lease = f.inbox.lease(r.receipt); lease.raw.fill(0);
    f.inbox.defer({ receipt: r.receipt, lease: lease.lease, reason: 'review_required' }); last = r.receipt;
  }
  f.store.db.prepare('UPDATE whatsapp_inbox SET review_metadata=NULL').run(); f.restart();
  assert.equal(f.inbox.health().groups[0].reviewIsolation.scopedReviews, 100);
  assert.equal(f.inbox.health().groups[0].reviewIsolation.scopedReviews, 200);
  assert.equal(f.inbox.health().groups[0].reviewIsolation.scopedReviews, 220);
  assert.throws(() => f.inbox.resumeReview({ receipt: last }), { code: 'scope_denied' });
  f.advance(60001);
  assert.equal(f.inbox.resumeReview({ receipt: last }).businessProcessed, false);
  assert.equal(f.inbox.pending(20)[0].receipt, last);
  assert.equal(f.inbox.health().groups[0].blockingReview, 220);
});
test('signed batch is encrypted and audited before ACK, survives restart and deduplicates without a business action', t => {
  const f = fixture(t); const input = packet(); const first = f.inbox.accept(input);
  assert.equal(first.persisted, true); assert.equal(first.businessProcessed, false);
  assert.equal(f.store.db.prepare('SELECT state FROM whatsapp_inbox').get().state, 'held');
  assert.equal(f.store.backlog().pending, 1);
  assert.deepEqual(f.inbox.health().capacity, { rows: 1, bytes: input.raw.length,
    maxRows: 100000, maxBytes: 1024 * 1024 * 1024, auditPending: 1, maxAuditBacklog: 10000 });
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
test('audit backlog limit rejects new receipts atomically and resumes after audit delivery', t => {
  const f = fixture(t, { maxAuditBacklog: 1 });
  f.inbox.accept(packet());
  const second = packet(body({ field: 'history' }));
  assert.throws(() => f.inbox.accept(second), { code: 'audit_unavailable' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 1);
  const claimed = f.store.claim(Date.now());
  f.store.acknowledge(claimed, { versionId: 'synthetic-audit-version', digest: claimed.digest }, Date.now());
  assert.equal(f.store.backlog().pending, 0);
  assert.equal(f.inbox.accept(second).persisted, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 2);
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
test('archive failure keeps the signed receipt retryable and cannot produce an HTTP 200', async t => {
  const f = fixture(t); let available = false; let copies = 0;
  const archive = { async put(receipt, envelope) {
    assert.match(receipt, /^[a-f0-9-]{36}$/);
    assert(!envelope.includes(Buffer.from('FICTITIOUS_CANCEL_REQUEST')));
    if (!available) throw Error('synthetic_archive_outage');
    copies++;
  } };
  const server = http.createServer(createWhatsappInboxHandler({ inbox: f.inbox,
    withApplicationSecret: work => work(APP), archive }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  network.allowPort(server.address().port);
  t.after(() => new Promise(resolve => { network.removePort(server.address().port); server.close(resolve); }));
  const send = () => new Promise((resolve, reject) => {
    const input = packet();
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': input.signature } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(input.raw);
  });
  assert.equal(await send(), 503);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT archived_at FROM whatsapp_inbox').get().archived_at, null);
  available = true;
  assert.equal(await send(), 200);
  assert.equal(await send(), 200);
  assert.equal(copies, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 1);
});
test('only imported archived receipts leave the hot inbox after 24 hours and deduplicate for seven days', async t => {
  const f = fixture(t, { maxRows: 2 });
  const first = packet(); const received = f.inbox.accept(first);
  const held = f.inbox.accept(packet(body({ field: 'history' })));
  assert.equal(f.inbox.maintain().released, 0);
  let envelope;
  await f.inbox.archive(received.receipt, { async put(receipt, body) { envelope = Buffer.from(body); } });
  const archived = JSON.parse(envelope);
  assert.equal(archived.receipt, received.receipt);
  assert.equal(archived.byteCount, first.raw.length);
  assert(!envelope.includes(Buffer.from('FICTITIOUS_CANCEL_REQUEST')));
  const checked = verifyArchiveEnvelope(envelope, f.cipher, archived.appId);
  assert(checked.raw.equals(first.raw)); checked.raw.fill(0);
  const lease = f.inbox.lease(received.receipt); lease.raw.fill(0);
  f.inbox.confirm({ receipt: received.receipt, lease: lease.lease, importReceipt: randomUUID() });
  f.advance(24 * 3600000 + 1);
  assert.equal(f.inbox.maintain().released, 0);
  assert.deepEqual(f.inbox.untaggedImported(), [received.receipt]);
  await f.inbox.tagImported(received.receipt, { async tagImported() {} });
  assert.equal(f.inbox.maintain().released, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM whatsapp_inbox WHERE receipt=?').get(held.receipt).state, 'held');
  assert.equal(f.inbox.accept(first).receipt, received.receipt);
  f.restart();
  assert.equal(f.inbox.accept(first).receipt, received.receipt);
  f.advance(7 * 24 * 3600000);
  f.inbox.maintain();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox_receipts').get().n, 0);
});
test('a failed archive or import tag rotates behind other receipts without deleting any', async t => {
  const f = fixture(t, { archiveEnabled: true });
  const first = f.inbox.accept(packet());
  f.advance(1);
  const second = f.inbox.accept(packet(body({ field: 'history' })));
  await assert.rejects(f.inbox.archive(first.receipt, { async put() { throw Error('synthetic outage'); } }),
    { code: 'audit_unavailable' });
  assert.deepEqual(f.inbox.unarchived(), [second.receipt]);
  assert.equal(f.inbox.health().archive.failedArchive, 1);
  f.advance(60001);
  assert.deepEqual(f.inbox.unarchived(), [first.receipt,second.receipt]);
  for (const receipt of [first.receipt,second.receipt]) {
    await f.inbox.archive(receipt, { async put() {} });
    const lease = f.inbox.lease(receipt); lease.raw.fill(0);
    f.inbox.confirm({ receipt, lease: lease.lease, importReceipt: randomUUID() });
  }
  await assert.rejects(f.inbox.tagImported(first.receipt, { async tagImported() { throw Error('synthetic tag outage'); } }),
    { code: 'audit_unavailable' });
  assert.deepEqual(f.inbox.untaggedImported(), [second.receipt]);
  assert.equal(f.inbox.health().archive.failedTag, 1);
  assert.equal(f.inbox.maintain().released, 0);
  assert.deepEqual(f.inbox.health().archive, { pending: 0, oldestAt: null,
    untaggedImported: 2, oldestUntaggedAt: f.store.db.prepare('SELECT imported_at FROM whatsapp_inbox WHERE receipt=?').get(first.receipt).imported_at,
    lastArchivedAt: f.store.db.prepare('SELECT archived_at FROM whatsapp_inbox WHERE receipt=?').get(second.receipt).archived_at,
    failedArchive: 0, failedTag: 1, lastTaggedAt: null });
  f.restart();
  assert.deepEqual(f.inbox.untaggedImported(), [second.receipt]);
});

test('local WhatsApp audit copies expire after seven days only with a verified S3 receipt', t => {
  const f = fixture(t);
  const created = [];
  for (let n=0;n<5;n++) {
    f.inbox.accept(packet(body({field:'synthetic_'+String.fromCharCode(97+n)})));
    created.push(f.store.claim(Date.now()));
    f.store.acknowledge(created[n],{versionId:'synthetic-audit-version',digest:created[n].digest},Date.now());
  }
  f.store.db.prepare('UPDATE audit_outbox SET receipt=? WHERE id=?')
    .run(JSON.stringify({versionId:'synthetic-audit-version',digest:'0'.repeat(64)}),created[1].id);
  f.store.db.prepare('UPDATE audit_outbox SET receipt=? WHERE id=?').run('corrupt-json',created[2].id);
  const outside = JSON.parse(created[3].event); outside.reason='synthetic_other_operation';
  f.store.db.prepare('UPDATE audit_outbox SET event=? WHERE id=?').run(JSON.stringify(outside),created[3].id);
  f.store.db.prepare('UPDATE audit_outbox SET delivered_at=NULL WHERE id=?').run(created[4].id);
  assert.equal(f.inbox.maintain().auditReleased,0);
  f.advance(7 * 24 * 3600000 + 10000);
  assert.equal(f.inbox.maintain(1).auditReleased,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM audit_outbox').get().n,4);
  assert.equal(f.store.backlog().pending,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n,5);
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
  f.advance(24 * 3600000 + 1);
  const retry=f.inbox.lease(old[0].receipt);retry.raw.fill(0);
  assert.throws(()=>f.inbox.defer({receipt:retry.receipt,lease:old[0].lease,reason:'unsupported_event'}),{code:'scope_denied'});
  assert.equal(f.inbox.defer({receipt:retry.receipt,lease:retry.lease,reason:'unsupported_event'}).businessProcessed,false);
  assert.throws(()=>f.inbox.lease(retry.receipt),{code:'scope_denied'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,1);
});
test('due review retries cannot delay new patient messages and retain a bounded retry share',t=>{
 const f=fixture(t),old=new Set(),fresh=new Set();
 for(let n=0;n<25;n++) {
  const receipt=f.inbox.accept(packet(body({field:'account_update',value:{sequence:n}}))).receipt;
  const lease=f.inbox.lease(receipt);lease.raw.fill(0);
  f.inbox.defer({receipt,lease:lease.lease,reason:'review_required'});old.add(receipt);
 }
 f.advance(24 * 3600000 + 1);
 for(let n=0;n<25;n++) {
  const input=body();input.entry[0].changes[0].value.messages[0].id='synthetic-'+n;
  fresh.add(f.inbox.accept(packet(input)).receipt);
 }
 const assertPending=inbox=>{
  const next=inbox.pending(20);
  assert.equal(next.length,20);
  assert.equal(next.filter(row=>fresh.has(row.receipt)).length,19);
  assert.equal(next.filter(row=>old.has(row.receipt)).length,1);
  assert(next.slice(0,19).every(row=>fresh.has(row.receipt)));
 };
 assertPending(f.inbox);f.restart();assertPending(f.inbox);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,0);
});
test('recoverable retries retain throughput while review retries use one slot',t=>{
 const f=fixture(t),recoverable=new Set(),review=new Set(),fresh=new Set();
 for(let n=0;n<25;n++) {
  for(const [reason,sequence,target] of [['import_retry',n,recoverable],['review_required',n+25,review]]) {
   const receipt=f.inbox.accept(packet(body({field:'account_update',value:{sequence}}))).receipt;
   const lease=f.inbox.lease(receipt);lease.raw.fill(0);
   f.inbox.defer({receipt,lease:lease.lease,reason});target.add(receipt);
  }
 }
 f.advance(24 * 3600000 + 1);
 for(let n=0;n<25;n++) {
  const input=body();input.entry[0].changes[0].value.messages[0].id='recoverable-test-'+n;
  fresh.add(f.inbox.accept(packet(input)).receipt);
 }
 const next=f.inbox.pending(20);
 assert.equal(next.filter(row=>fresh.has(row.receipt)).length,16);
 assert.equal(next.filter(row=>recoverable.has(row.receipt)).length,3);
 assert.equal(next.filter(row=>review.has(row.receipt)).length,1);
 for(const receipt of fresh) {
  const lease=f.inbox.lease(receipt);lease.raw.fill(0);
  f.inbox.confirm({receipt,lease:lease.lease,importReceipt:randomUUID()});
 }
 const after=f.inbox.pending(20);
 assert.equal(after.filter(row=>recoverable.has(row.receipt)).length,19);
 assert.equal(after.filter(row=>review.has(row.receipt)).length,1);
 f.restart();assert.deepEqual(f.inbox.pending(20),after);
});
test('review retries wait a day while transient retries remain available after a minute',t=>{
 const f=fixture(t);
 const review=f.inbox.accept(packet(body({field:'account_update'})));
 const reviewLease=f.inbox.lease(review.receipt);reviewLease.raw.fill(0);
 f.inbox.defer({receipt:review.receipt,lease:reviewLease.lease,reason:'review_required'});
 const transient=f.inbox.accept(packet(body({field:'history'})));
 const transientLease=f.inbox.lease(transient.receipt);transientLease.raw.fill(0);
 f.inbox.defer({receipt:transient.receipt,lease:transientLease.lease,reason:'import_retry'});
 f.advance(60001);
 assert.deepEqual(f.inbox.pending().map(row=>row.receipt),[transient.receipt]);
 f.advance(24 * 3600000);
 assert(f.inbox.pending().some(row=>row.receipt===review.receipt));
});
test('a crashed consumer rotates failed leases behind newly arrived work',t=>{
 const f=fixture(t),a=f.inbox.accept(packet());f.advance(1);
 const b=f.inbox.accept(packet(body({field:'history'})));f.advance(1);
 f.inbox.lease(a.receipt).raw.fill(0);f.advance(60001);f.restart();
 assert.equal(f.inbox.pending()[0].receipt,b.receipt);
});
test('review health attributes signed contact events without importing them and retains unknown review barriers',t=>{
 const scopeBindings=[{wabaId:'301',phoneId:'401',clinicIds:[71]}];
 const f=fixture(t,{scopeBindings});
 for(let n=0;n<101;n++) {
  const administrative=f.inbox.accept(packet(body({field:'account_update',value:{sequence:n}})));
  const l=f.inbox.lease(administrative.receipt);l.raw.fill(0);
  f.inbox.defer({receipt:l.receipt,lease:l.lease,reason:'review_required'});f.advance(1);
 }
 const input=body();input.entry[0].changes[0].value.messaging_product='whatsapp';
 const one=f.inbox.accept(packet(input)),lease=f.inbox.lease(one.receipt);lease.raw.fill(0);
 f.inbox.defer({receipt:lease.receipt,lease:lease.lease,reason:'review_required'});
 const health=f.inbox.health();const group=health.groups.find(g=>g.scopes.includes('301:401'));
 assert.equal(group.blockingReview,1);assert.equal(group.reviewIsolation.scopedReviews,1);
 assert.equal(group.reviewIsolation.contacts[0].clinicId,71);
 assert.match(group.reviewIsolation.contacts[0].contactKey,/^[a-f0-9]{64}$/);
 assert(!JSON.stringify(health).includes('34000000001'));assert(!JSON.stringify(health).includes('FICTITIOUS_CANCEL_REQUEST'));
 assert.deepEqual(f.inbox.health(),health);f.restart();assert.deepEqual(f.inbox.health(),health);
 const unknown=f.inbox.accept(packet(body({field:'smb_app_state_sync'}))),other=f.inbox.lease(unknown.receipt);other.raw.fill(0);
 f.inbox.defer({receipt:other.receipt,lease:other.lease,reason:'review_required'});
 const later=f.inbox.health().groups.find(g=>g.scopes.includes('301:401'));
 assert.equal(later.blockingReview,2);assert.equal(later.reviewIsolation.scopedReviews,1);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,0);
});
test('durable review diagnostics include late events without relying on a sampled isolation budget',t=>{
 const scopeBindings=[{wabaId:'301',phoneId:'401',clinicIds:[71]}];
 const f=fixture(t,{scopeBindings});
 for(let n=0;n<121;n++) {
  const input=body();const value=input.entry[0].changes[0].value;
  value.messaging_product='whatsapp';value.messages[0].id='synthetic-review-'+n;
  const r=f.inbox.accept(packet(input)),lease=f.inbox.lease(r.receipt);lease.raw.fill(0);
  f.inbox.defer({receipt:r.receipt,lease:lease.lease,reason:'review_required'});f.advance(1);
 }
 const h=f.inbox.health(),g=h.groups.find(group=>group.scopes.includes('301:401'));
 assert.equal(g.blockingReview,121);assert.equal(g.reviewIsolation.scopedReviews,121);
 assert.equal(g.reviewSummary[0].category,'incoming_messages');assert.equal(g.reviewSummary[0].count,121);
 assert.equal(g.reviewSummary.reduce((total,item)=>total+item.count,0),g.blockingReview);
 assert(!JSON.stringify(h).includes('FICTITIOUS_CANCEL_REQUEST'));assert(!JSON.stringify(h).includes('34000000001'));
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,0);
 assert.deepEqual(f.inbox.health(),h);f.restart();assert.deepEqual(f.inbox.health(),h);
});
test('older reviews from another scope cannot starve a shared active phone of contact attribution',t=>{
 const scopeBindings=[{wabaId:'301',phoneId:'401',clinicIds:[71]},
  {wabaId:'302',phoneId:'402',clinicIds:[72,73]}];
 const f=fixture(t,{scopeBindings,bindings:[{wabaId:'301',phoneIds:['401']},{wabaId:'302',phoneIds:['402']}]});
 const retain=(phoneId,wabaId,n)=>{
  const input=body();const entry=input.entry[0],value=entry.changes[0].value;
  entry.id=wabaId;value.metadata.phone_number_id=phoneId;value.messaging_product='whatsapp';
  value.messages[0].id='synthetic-review-'+phoneId+'-'+n;
  const accepted=f.inbox.accept(packet(input)),lease=f.inbox.lease(accepted.receipt);lease.raw.fill(0);
  f.inbox.defer({receipt:accepted.receipt,lease:lease.lease,reason:'review_required'});f.advance(1);
 };
 for(let n=0;n<150;n++)retain('401','301',n);
 for(let n=0;n<2;n++)retain('402','302',n);
 const before=f.store.db.prepare('SELECT receipt,state,lease,imported_at FROM whatsapp_inbox ORDER BY receipt').all();
 const health=f.inbox.health(),old=health.groups.find(g=>g.scopes.includes('301:401'));
 const active=health.groups.find(g=>g.scopes.includes('302:402'));
 assert.equal(active.blockingReview,2);assert.equal(active.reviewIsolation.scopedReviews,2);
 assert.deepEqual(active.reviewIsolation.contacts.map(c=>c.clinicId),[72,73]);
 assert.equal(old.reviewIsolation.scopedReviews,150);
 assert.equal(health.groups.reduce((n,g)=>n+(g.reviewIsolation?.scopedReviews||0),0),152);
 assert.deepEqual(f.store.db.prepare('SELECT receipt,state,lease,imported_at FROM whatsapp_inbox ORDER BY receipt').all(),before);
 assert(!JSON.stringify(health).includes('FICTITIOUS_CANCEL_REQUEST'));
 assert(!JSON.stringify(health).includes('34000000001'));
 assert.deepEqual(f.inbox.health(),health);f.restart();assert.deepEqual(f.inbox.health(),health);
});
test('fair review selection retains an unknown active-phone barrier rather than inventing contact attribution',t=>{
 const scopeBindings=[{wabaId:'301',phoneId:'401',clinicIds:[71]},
  {wabaId:'302',phoneId:'402',clinicIds:[72]}];
 const f=fixture(t,{scopeBindings,bindings:[{wabaId:'301',phoneIds:['401']},{wabaId:'302',phoneIds:['402']}]});
 for(let n=0;n<110;n++){
  const input=body();input.entry[0].changes[0].value.messaging_product='whatsapp';
  input.entry[0].changes[0].value.messages[0].id='synthetic-old-'+n;
  const accepted=f.inbox.accept(packet(input)),lease=f.inbox.lease(accepted.receipt);lease.raw.fill(0);
  f.inbox.defer({receipt:accepted.receipt,lease:lease.lease,reason:'review_required'});f.advance(1);
 }
 const unknown=body({field:'smb_app_state_sync'});unknown.entry[0].id='302';
 unknown.entry[0].changes[0].value.metadata.phone_number_id='402';
 const accepted=f.inbox.accept(packet(unknown)),lease=f.inbox.lease(accepted.receipt);lease.raw.fill(0);
 f.inbox.defer({receipt:accepted.receipt,lease:lease.lease,reason:'review_required'});
 const active=f.inbox.health().groups.find(g=>g.scopes.includes('302:402'));
 assert.equal(active.blockingReview,1);assert.equal(active.reviewIsolation,undefined);
 assert.equal(active.reviewSummary[0].category,'app_state_changes');
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM whatsapp_inbox WHERE state='imported'").get().n,0);
});
