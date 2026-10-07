'use strict';

// OWNED diagnostic regression: four first employee email challenges and MFA
// run concurrently through native HTTP routes. No sequence/retry workaround.
// The unchanged launcher permits only its private MySQL socket and loopback;
// the unchanged helper substitutes only a transactional, nondelivering outbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const safeSql = value => String(value || '')
  .replace(/'(?:\\.|''|[^'])*'/g, "'[REDACTED]'")
  .replace(/\b0x[0-9a-f]+\b/gi, '[REDACTED]')
  .replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED]')
  .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED]');
function deadlockEvidence(status) {
  const match = String(status).match(/LATEST DETECTED DEADLOCK\n[-]+\n([\s\S]*?)(?=\n[-]+\nTRANSACTIONS\n)/);
  if (!match) return { found: false };
  // Physical-record hex/ASCII dumps can contain authentication bindings.
  // Retain the native lock/table/index/query report without any record data.
  const lines = match[1].split('\n').flatMap(line => /^\s*\d+: len \d+; hex /i.test(line)
    ? /asc supremum;/i.test(line) ? ['[Physical record: supremum]'] : [] : [line]);
  return { found: true, nativeExcerptSha256: sha256(match[1]), sanitizedNativeExcerpt: safeSql(lines.join('\n')) };
}

withIsolatedCampaignMysql(async owned => {
  const { sql, report } = owned;
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true });
  const { db, ids, request } = f;
  const contract = require('../../services/authEmailChallenge.contract');
  const sourceFiles = [__filename, require.resolve('./helpers/owned-visit-auth-acl-fixture'),
    require.resolve('./fixtures/isolated_campaign_mysql.fixture'), require.resolve('../../controllers/auth.controllers'),
    require.resolve('../../services/authEmailChallenge.service'), require.resolve('../../services/authEmailChallenge.contract'),
    require.resolve('../../services/platformAudit.repository'), require.resolve('../../../models/authemailchallenge'),
    require.resolve('../../../migrations/20260913130000-create-auth-email-challenges')];
  report.proof = {
    purpose: 'Native four-way first challenge/MFA concurrency diagnosis; negative HTTP result is preserved, never replaced by sequential login',
    auth: f.boundaries.auth, email: f.boundaries.email,
    boundaries: 'Fresh OWNED MySQL/socket and registered loopback only; no delivery, providers, workers, production data or persistent flags',
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(file))])),
    sqlErrors: [], sqlTrace: [], responses: [],
    originalFailure: {
      report: '/tmp/cc-campaign-opt-mysql-QKpJ5e/result.json',
      reportSha256: fs.existsSync('/tmp/cc-campaign-opt-mysql-QKpJ5e/result.json')
        ? sha256(fs.readFileSync('/tmp/cc-campaign-opt-mysql-QKpJ5e/result.json')) : null,
      limit: 'Original report records HTTP503 auth_email_unavailable but no native SQL error; original mysql-error.log contains no deadlock statement. A reproduction does not prove the original exception.'
    }
  };
  const [[metadata]] = await sql.query('SELECT @@transaction_isolation AS isolation, @@skip_networking AS isolated');
  report.proof.mysqlRuntime = metadata;
  assert.equal(Number(metadata.isolated), 1);
  report.proof.challengeIndexes = (await sql.query('SHOW INDEX FROM AuthEmailChallenges'))[0]
    .map(row => ({ name: row.Key_name, column: row.Column_name, position: row.Seq_in_index, unique: Number(row.Non_unique) === 0 }));
  assert.equal(await db.AuthEmailChallenge.count(), 0, 'These must be the first native challenges');
  assert.equal(await db.AuthSession.count(), 0);
  assert.equal(await db.OwnedAuthOutbox.count(), 0);
  const beforeDomain = await f.fingerprint();
  const nativeQuery = sql.query;
  let sequence = 0;
  // Observe/rethrow the same native Sequelize error, before auth's generic503
  // conversion. Never retain SQL bind parameters, email codes or HTTP tokens.
  sql.query = async function (statement, options) {
    const text = typeof statement === 'string' ? statement : statement?.query;
    const seq = ++sequence, transaction = options?.transaction;
    const diagnostic = { sequence: seq, transaction: transaction?.id || null,
      mysqlThreadId: transaction?.connection?.threadId || null, sql: safeSql(text) };
    if (/AuthEmailChallenges|OwnedAuthOutbox|PlatformAuditEvents|FOR UPDATE|ISOLATION LEVEL|(?:START TRANSACTION|COMMIT|ROLLBACK)/i.test(text || '')) {
      report.proof.sqlTrace.push(diagnostic);
    }
    try { return await nativeQuery.call(this, statement, options); }
    catch (error) {
      report.proof.sqlErrors.push({ ...diagnostic, name: error.name,
        nativeCode: error.original?.code || error.parent?.code || null,
        errno: error.original?.errno || error.parent?.errno || null,
        sqlState: error.original?.sqlState || error.parent?.sqlState || null,
        nativeSql: safeSql(error.original?.sql || error.sql) });
      throw error;
    }
  };
  try {
    const managedTokens = new Map();
    const userIds = [ids.assistant, ids.reception, ids.owner, ids.outsider];
    report.proof.concurrency = { users: userIds, count: userIds.length,
      launch: 'Promise.all: four independent first HTTP sign-ins; each successful password step immediately performs its actual MFA verification' };
    await Promise.all(userIds.map(async userId => {
      const started = await request('POST', '/api/auth/sign-in', {
        email: 'owned-' + userId + '@example.invalid', password: f.password });
      const observed = { syntheticUserId: userId, challengeStatus: started.status,
        challengeError: started.status === 202 ? null : started.body?.error || null, verificationStatus: null, verificationError: null };
      report.proof.responses.push(observed);
      if (started.status !== 202) return;
      const row = await db.AuthEmailChallenge.findOne({ attributes: ['challenge_id'],
        where: { challenge_hash: contract.challengeHash(started.body.challengeToken) }, raw: true, logging: false });
      assert(row, 'Successful native challenge must have a committed SQL row');
      const verified = await request('POST', '/api/auth/email-code/verify', {
        challengeToken: started.body.challengeToken, code: f.codeFor(row.challenge_id) });
      observed.verificationStatus = verified.status;
      observed.verificationError = verified.status === 200 ? null : verified.body?.error || null;
      if (verified.status === 200) managedTokens.set(userId, verified.body.token);
    }));
    report.proof.innodb = deadlockEvidence((await sql.query('SHOW ENGINE INNODB STATUS'))[0][0].Status);
    report.proof.authRows = await Promise.all(userIds.map(async userId => ({ syntheticUserId: userId,
      challenges: await db.AuthEmailChallenge.count({ where: { user_id: userId } }),
      outbox: await db.OwnedAuthOutbox.count({ where: { user_id: userId } }),
      sessions: await db.AuthSession.count({ where: { user_id: userId } }) })));
    assert.deepEqual(await f.fingerprint(), beforeDomain, 'Concurrent auth cannot mutate appointment/clinical/job domain rows');
    assert.equal(f.externalFetchAttempts, 0);
    assert.equal(require('../../services/jobScheduler.service')._getWorkerState().running, false);
    report.proof.externalFetchAttempts = f.externalFetchAttempts;
    report.proof.workersRunning = false;
    report.proof.httpRequests = f.requests;
    report.checks.push('Four first users launched concurrently through real native sign-in/MFA routes; private transactional nondelivering outbox, no providers/workers/domain changes');
    report.proof.concurrencyPassed = report.proof.responses.every(row => row.challengeStatus === 202 && row.verificationStatus === 200);
    assert.equal(report.proof.concurrencyPassed, true,
      'Concurrent first challenges/MFA failed; preserve native sanitized SQL/lock evidence and the negative report');
    report.checks.push('All four concurrent native first challenges and MFA verifications completed successfully');

    const sameUser = ids.doctorOne;
    const sameChallenges = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/api/auth/sign-in', {
      email: 'owned-' + sameUser + '@example.invalid', password: f.password })));
    const sameStatuses = sameChallenges.map(row => row.status).sort();
    assert.deepEqual(sameStatuses, [202, 429, 429, 429], 'User lock must preserve cooldown under four concurrent password steps');
    const same = sameChallenges.find(row => row.status === 202);
    const sameRow = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: contract.challengeHash(same.body.challengeToken) } });
    const sameVerifications = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/api/auth/email-code/verify', {
      challengeToken: same.body.challengeToken, code: f.codeFor(sameRow.challenge_id) })));
    const verificationStatuses = sameVerifications.map(row => row.status).sort();
    assert.deepEqual(verificationStatuses, [200, 401, 401, 401], 'A challenge must be consumed once despite concurrent correct codes');
    assert.equal(await db.AuthEmailChallenge.count({ where: { user_id: sameUser } }), 1);
    assert.equal(await db.OwnedAuthOutbox.count({ where: { user_id: sameUser } }), 1);
    assert.equal(await db.AuthSession.count({ where: { user_id: sameUser } }), 1);
    report.proof.sameAccount = { passwordStatuses: sameStatuses, verificationStatuses, challengeRows: 1, outboxRows: 1, sessionRows: 1 };
    report.checks.push('Four same-account password steps enforce one challenge/cooldown; four correct verifications create one session and deny all proof replays');

    const attemptsUser = ids.doctorTwo;
    const attemptsStart = await request('POST', '/api/auth/sign-in', {
      email: 'owned-' + attemptsUser + '@example.invalid', password: f.password });
    assert.equal(attemptsStart.status, 202);
    const attemptsRow = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: contract.challengeHash(attemptsStart.body.challengeToken) } });
    const wrong = f.codeFor(attemptsRow.challenge_id) === '000000' ? '111111' : '000000';
    const wrongResults = await Promise.all(Array.from({ length: 6 }, () => request('POST', '/api/auth/email-code/verify', {
      challengeToken: attemptsStart.body.challengeToken, code: wrong })));
    const wrongStatuses = wrongResults.map(row => row.status).sort();
    report.proof.attemptLimit = { concurrentWrongStatuses: wrongStatuses };
    // The fifth wrong code locks the challenge (429). Once locked, the native
    // state guard rejects further verification as an invalid challenge (401).
    assert.deepEqual(wrongStatuses, [401, 401, 401, 401, 401, 429]);
    await attemptsRow.reload();
    assert.equal(attemptsRow.attempts, 5); assert.equal(attemptsRow.state, 'locked');
    assert.equal(await db.AuthSession.count({ where: { user_id: attemptsUser } }), 0);
    const afterLock = await request('POST', '/api/auth/email-code/verify', {
      challengeToken: attemptsStart.body.challengeToken, code: f.codeFor(attemptsRow.challenge_id) });
    assert.equal(afterLock.status, 401);
    report.proof.attemptLimit = { concurrentWrongStatuses: wrongStatuses, attempts: attemptsRow.attempts,
      state: attemptsRow.state, correctAfterLockStatus: afterLock.status, sessionRows: 0 };
    report.checks.push('Six concurrent wrong verifications stop at exactly five durable attempts; lockout rejects the correct code without a session');

    const revokeToken = managedTokens.get(ids.assistant);
    const revoked = await request('POST', '/api/auth/sign-out', {}, revokeToken);
    assert.equal(revoked.status, 200);
    const revokedRead = await request('GET', '/api/auth/me', undefined, revokeToken);
    assert.equal(revokedRead.status, 401);
    assert.equal((await request('POST', '/api/auth/sign-out', {}, revokeToken)).status, 200);
    assert.equal(await db.AuthSession.count({ where: { user_id: ids.assistant, state: 'revoked' } }), 1);
    report.proof.revocation = { signOutStatus: revoked.status, oldSessionReadStatus: revokedRead.status, revokedSessionRows: 1 };
    report.checks.push('Native logout durably revokes an MFA session; old JWT is denied and repeated logout confirms the same revocation');

    const auditRows = await db.PlatformAuditEvent.findAll({ raw: true });
    const events = auditRows.map(row => require('../../../services/platform-audit/src/event').unpack(row).event);
    report.proof.auditIntegrity = { rows: auditRows.length, canonicalUnpackPassed: true,
      actions: Object.fromEntries([...new Set(events.map(event => event.action))].map(action => [action, events.filter(event => event.action === action).length])) };
    assert.equal(events.filter(event => event.action === 'session.issued').length, 5);
    assert.equal(events.filter(event => event.action === 'auth.email_code' && event.reason === 'code_verified').length, 5);
    assert.equal(events.filter(event => event.action === 'session.revoked').length, 1);
    assert.deepEqual(await f.fingerprint(), beforeDomain);
    assert.equal(f.externalFetchAttempts, 0);
    assert.equal(report.proof.sqlErrors.length, 0, 'No native SQL error may be hidden behind HTTP success');
    report.proof.httpRequests = f.requests;
    report.checks.push('All durable audit records pass canonical unpack/digest checks; exact issuance/verification/revocation counts and unchanged domain/provider boundary remain true');
  } finally {
    sql.query = nativeQuery;
    await f.close();
  }
}).catch(error => {
  console.error(JSON.stringify({ error: 'owned_auth_concurrency_regression_failed', code: error.code || null,
    detail: 'Inspect the isolated result.json; no credentials, codes or tokens are emitted.' }));
  process.exitCode = 1;
});
