'use strict';

// Operator-only, read-only adapter for the existing selective RDS release
// ledger. It never creates a snapshot, loads a DB password or opens a DB.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const R = require('../rdsSchemaMigration');
const P = require('../rdsSchemaMigrationPolicy');
const T = require('../rdsSchemaMigrationTransport');
const { digest } = require('../securitySchemaContract');
const { hash: stableHash } = require('./adapter');

const ACCOUNT = '137819318729', REGION = 'eu-west-3';
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const PROOF_TTL_MS = 5 * 60 * 1000;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const RESULT_PATH = new RegExp(`^${R.STATE}/runs/(${UUID})/result\\.json$`);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (condition, code) => { if (!condition) fail(code); };

function sourceIdentity(value) {
  const uuid = value?.server_uuid || value?.serverUuid;
  need(value && (!value.target || value.target === 'crm') && (!value.runtime || value.runtime === 'staging')
    && value.host === T.HOST && value.port === 3306 && value.database === T.DATABASE
    && typeof uuid === 'string' && new RegExp(`^${UUID}$`).test(uuid)
    && typeof value.server_hostname === 'string' && /^[A-Za-z0-9_.-]{1,255}$/.test(value.server_hostname), 'RDS_BACKUP_SOURCE_IDENTITY_INVALID');
  // Only facts observed through SQL belong to this identity. Account, region and
  // DBI are independently derived from the trusted RDS ledger and fresh AWS.
  return { host: value.host, port: 3306, database: value.database, server_uuid: uuid, server_hostname: value.server_hostname };
}

function createRdsBackupReceiptVerifier({ io = fs, readPrivate = R.readPrivate, getuid = () => process.getuid(),
  now = Date.now, execute = promisify(execFile), awsFactory = T.createAws } = {}) {
  function directory(dir) {
    const stat = io.lstatSync(dir);
    need(path.resolve(dir) === dir && io.realpathSync(dir) === dir && stat.isDirectory()
      && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 511) === 448, 'RDS_BACKUP_PRIVATE_DIRECTORY_REQUIRED');
  }
  function read(file, parse) {
    // readPrivate itself performs NOFOLLOW, ownership, mode, inode, size and
    // replacement checks. Prechecking the existing directory also prevents its
    // mkdir helper from creating anything during this read-only operation.
    directory(path.dirname(file));
    return readPrivate(file, 0, parse);
  }
  async function describeSnapshot(profile, snapshotId) {
    let result;
    try {
      result = await execute('/sbin/runuser', ['-u', 'ubuntu', '--', '/home/ubuntu/.local/bin/aws', '--profile', profile,
        '--region', REGION, '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '5', '--cli-read-timeout', '30',
        'rds', 'describe-db-snapshots', '--db-snapshot-identifier', snapshotId], {
        timeout: 40000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: '/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/home/ubuntu', LC_ALL: 'C', AWS_PAGER: '',
          AWS_CONFIG_FILE: '/home/ubuntu/.aws/config', AWS_SHARED_CREDENTIALS_FILE: '/home/ubuntu/.aws/credentials',
          AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1' },
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      if (error && typeof error === 'object') { error.stdout = ''; error.stderr = ''; }
      fail('RDS_BACKUP_AWS_READ_FAILED');
    } finally { if (result) { result.stdout = ''; result.stderr = ''; } }
  }
  return async function verifyRdsBackupReceipt({ sourceIdentity: inputIdentity, receiptPath, receiptSha256 }) {
    need(getuid() === 0, 'RDS_BACKUP_NATIVE_ROOT_HELPER_REQUIRED');
    const source = sourceIdentity(inputIdentity), match = typeof receiptPath === 'string' && receiptPath.match(RESULT_PATH);
    need(match && hex(receiptSha256), 'RDS_BACKUP_RECEIPT_REFERENCE_INVALID');
    const nonce = match[1], run = path.dirname(receiptPath);
    directory(R.STATE); directory(`${R.STATE}/runs`); directory(`${R.STATE}/claims`);
    let result, resultRef, plan, planRef, journal, journalRef, claim;
    try {
      ({ value: result, reference: resultRef } = read(receiptPath));
      need(resultRef.path === receiptPath && resultRef.sha256 === receiptSha256, 'RDS_BACKUP_RECEIPT_HASH_MISMATCH');
      need(typeof result.planRef?.path === 'string' && path.isAbsolute(result.planRef.path)
        && path.resolve(result.planRef.path) === result.planRef.path && result.planRef.path.endsWith('.json')
        && hex(result.planRef.sha256), 'RDS_BACKUP_PLAN_REFERENCE_INVALID');
      ({ value: plan, reference: planRef } = read(result.planRef.path));
      need(planRef.sha256 === result.planRef.sha256, 'RDS_BACKUP_PLAN_HASH_MISMATCH');
      ({ value: claim } = read(`${R.STATE}/claims/${planRef.sha256}.json`));
      ({ value: journal, reference: journalRef } = read(`${run}/journal.jsonl`, bytes => {
        const text = bytes.toString(); need(text.endsWith('\n'), 'RDS_BACKUP_JOURNAL_TRUNCATED');
        return text.trim().split('\n').map(line => JSON.parse(line));
      }));
    } catch (error) {
      if (/^RDS_BACKUP_[A-Z_]+$/.test(error?.code || '')) throw error;
      fail('RDS_BACKUP_PRIVATE_RECEIPT_UNREADABLE');
    }
    need(planRef.sha256 === result.planRef.sha256 && digest(claim.planRef) === digest(planRef)
      && claim.operationNonce === nonce && result.operationNonce === nonce, 'RDS_BACKUP_LEDGER_BINDING_INVALID');
    need(plan.schema === P.PLAN_SCHEMA && plan.effectiveContractScope?.runtime === 'staging'
      && result.status === 'rds_schema_applied_and_verified' && result.compatibility?.compatible === true
      && result.closure?.physicalCloseObserved === true && result.closure?.physicalStreamDestroyed === true
      && result.sourceRevision === plan.sourceRevision && result.effectiveContractDigest === plan.effectiveContractDigest
      && digest(result.effectiveContractScope) === digest(plan.effectiveContractScope)
      && digest(result.identity) === digest(plan.identity) && result.afterDigest === digest(result.after)
      && Array.isArray(plan.toApply) && plan.toApply.length > 0
      && digest(result.completed) === digest(plan.toApply)
      && result.completed.every(name => result.after?.migrations?.includes(name))
      && plan.policy?.schemaOnly === true && plan.policy?.clinicalRowDml === false,
    'RDS_BACKUP_SUCCESSFUL_STAGING_RELEASE_REQUIRED');
    const identity = result.identity;
    need(identity?.host === source.host && identity.database === source.database && identity.port === source.port
      && identity.physicalDbId === T.PRIMARY_DBI && identity.serverUuid === source.server_uuid
      && identity.strictTls === true && identity.hostnameVerified === true && identity.caSha256 === T.CA_SHA,
    'RDS_BACKUP_DATABASE_IDENTITY_MISMATCH');
    const backup = result.backup, snapshotId = `cc-schema-${nonce.replace(/-/g, '')}`;
    const snapshotArn = `arn:aws:rds:${REGION}:${ACCOUNT}:snapshot:${snapshotId}`;
    const created = Date.parse(backup?.createdAt), checked = backup?.checkedAtEpochMs;
    const at = now();
    need(backup?.snapshotId === snapshotId && backup.snapshotArn === snapshotArn
      && backup.physicalDbId === T.PRIMARY_DBI && backup.status === 'available'
      && Number.isFinite(created) && created <= at && at - created <= MAX_BACKUP_AGE_MS
      && Number.isSafeInteger(checked) && created <= checked && checked <= at && at - checked <= MAX_BACKUP_AGE_MS,
    'RDS_BACKUP_SNAPSHOT_STALE_OR_INVALID');
    const requests = journal.filter(row => row.event === 'backup_request'), acknowledgements = journal.filter(row => row.event === 'backup_create_ack');
    const available = journal.filter(row => row.event === 'backup_available'), terminal = journal.filter(row => row.event === 'terminal');
    need(requests.length === 1 && acknowledgements.length === 1 && available.length === 1 && terminal.length === 1
      && requests[0].snapshotId === snapshotId && acknowledgements[0].snapshotId === snapshotId
      && ['snapshotId','snapshotArn','physicalDbId','createdAt','status','checkedAtEpochMs'].every(key => available[0][key] === backup[key])
      && terminal[0] === journal[journal.length - 1] && terminal[0].accepted === true
      && terminal[0].status === result.status && Number.isSafeInteger(terminal[0].atEpochMs)
      && terminal[0].atEpochMs >= checked && terminal[0].atEpochMs <= at
      && journal.indexOf(requests[0]) < journal.indexOf(acknowledgements[0])
      && journal.indexOf(acknowledgements[0]) < journal.indexOf(available[0]), 'RDS_BACKUP_JOURNAL_BINDING_INVALID');
    need(/^[A-Za-z0-9_-]{1,64}$/.test(plan.awsProfile || ''), 'RDS_BACKUP_PROFILE_INVALID');
    const aws = awsFactory({ profile: plan.awsProfile, execute, now });
    function validateDb(db) {
      need(db?.DBInstanceIdentifier === T.DB_ID && db.DbiResourceId === T.PRIMARY_DBI
        && db.Endpoint?.Address === source.host && db.Endpoint.Port === source.port && db.PubliclyAccessible === false
        && db.DBInstanceArn === `arn:aws:rds:${REGION}:${ACCOUNT}:db:${T.DB_ID}`
        && db.Engine === 'mysql' && db.EngineVersion === identity.engineVersion && db.StorageEncrypted === true,
      'RDS_BACKUP_FRESH_DATABASE_IDENTITY_MISMATCH');
    }
    validateDb(await aws.inspect());
    const response = await describeSnapshot(plan.awsProfile, snapshotId), live = response?.DBSnapshots?.[0];
    need(response?.DBSnapshots?.length === 1 && live.DBSnapshotIdentifier === snapshotId && live.DBSnapshotArn === snapshotArn
      && live.DBInstanceIdentifier === T.DB_ID && live.DbiResourceId === T.PRIMARY_DBI && live.Status === 'available'
      && live.Encrypted === true && live.Engine === 'mysql' && live.EngineVersion === identity.engineVersion
      && Date.parse(live.SnapshotCreateTime) === created && now() - created <= MAX_BACKUP_AGE_MS,
    'RDS_BACKUP_FRESH_SNAPSHOT_MISMATCH');
    // Recheck the native account/session and physical instance after the read.
    validateDb(await aws.inspect());
    const verifiedAt = now();
    need(verifiedAt >= at && verifiedAt - created < MAX_BACKUP_AGE_MS, 'RDS_BACKUP_SNAPSHOT_STALE_OR_INVALID');
    return { schema: 'clinicaclick-rds-backup-verification/1', target: 'crm', runtime: 'staging',
      receiptRef: resultRef, planRef, journalRef, operationNonce: nonce, sourceIdentitySha256: stableHash(source),
      awsAccountId: ACCOUNT, awsRegion: REGION, dbInstanceIdentifier: T.DB_ID, physicalDbId: T.PRIMARY_DBI,
      host: source.host, port: source.port, database: source.database, serverUuid: source.server_uuid,
      snapshotId, snapshotArn, snapshotCreatedAt: new Date(created).toISOString(), snapshotStatus: 'available',
      checkedAtEpochMs: verifiedAt, expiresAtEpochMs: Math.min(verifiedAt + PROOF_TTL_MS, created + MAX_BACKUP_AGE_MS),
      freshAwsRead: true, clinicalRowDmlPerformed: false };
  };
}

const verifyRdsBackupReceipt = createRdsBackupReceiptVerifier();
module.exports = { ACCOUNT, REGION, MAX_BACKUP_AGE_MS, PROOF_TTL_MS, createRdsBackupReceiptVerifier, verifyRdsBackupReceipt };

if (require.main === module) {
  // Native root helper: non-secret identity/reference enters over stdin, never
  // credentials or patient data. No actor prompt and no wider sudo policy.
  (async () => {
    let bytes = 0, text = '';
    for await (const part of process.stdin) { bytes += part.length; need(bytes <= 65536, 'RDS_BACKUP_INPUT_TOO_LARGE'); text += part; }
    const result = await verifyRdsBackupReceipt(JSON.parse(text));
    process.stdout.write(JSON.stringify(result) + '\n');
  })().catch(error => { process.stderr.write(/^RDS_BACKUP_[A-Z_]+$/.test(error?.code || '') ? error.code + '\n' : 'RDS_BACKUP_VERIFICATION_FAILED\n'); process.exitCode = 1; });
}
