'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { hash } = require('./adapter');
const fail = code => { throw Error(code); };

async function nativeRdsProof(input) {
  const helper = path.join(__dirname, 'rds-backup-receipt.js');
  const child = spawn('/usr/bin/sudo', ['-n', '--', '/usr/bin/node', helper], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  let output = '', diagnostic = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), 150000);
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(Error('FOLLOWUP_RDS_BACKUP_HELPER_FAILED')));
      child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(Error(
        /^RDS_BACKUP_[A-Z_]+\s*$/.test(diagnostic) ? diagnostic.trim() : 'FOLLOWUP_RDS_BACKUP_HELPER_FAILED')));
    });
    return JSON.parse(output);
  } finally { clearTimeout(timer); output = ''; diagnostic = ''; }
}

function validateProof(proof, prepared, now = Date.now()) {
  if (!proof || proof.target !== prepared.target || proof.sourceIdentitySha256 !== hash(prepared.database_identity)
    || !Number.isSafeInteger(proof.checkedAtEpochMs) || proof.checkedAtEpochMs > now
    || !Number.isSafeInteger(proof.expiresAtEpochMs) || proof.expiresAtEpochMs <= now
    || proof.expiresAtEpochMs <= proof.checkedAtEpochMs || proof.expiresAtEpochMs - proof.checkedAtEpochMs > 300000) fail('FOLLOWUP_BACKUP_PROOF_EXPIRED_OR_CHANGED');
  if (prepared.target === 'crm' && (proof.schema !== 'clinicaclick-rds-backup-verification/1'
    || proof.runtime !== 'staging' || proof.freshAwsRead !== true || proof.snapshotStatus !== 'available'
    || proof.clinicalRowDmlPerformed !== false)) fail('FOLLOWUP_VERIFIED_RDS_BACKUP_REQUIRED');
  return proof;
}

async function verifyReconciliationBackup({ options, prepared, verifySqlBackup, verifyRdsBackup = nativeRdsProof, now = Date.now }) {
  if (prepared.target === 'crm') {
    if (!options['--rds-backup-receipt'] || !options['--rds-backup-sha256'] || options['--backup-file'] || options['--backup-sha256']) fail('FOLLOWUP_VERIFIED_RDS_BACKUP_REQUIRED');
    const proof = await verifyRdsBackup({ sourceIdentity: prepared.database_identity,
      receiptPath: options['--rds-backup-receipt'], receiptSha256: options['--rds-backup-sha256'] });
    return validateProof(proof, prepared, now());
  }
  if (prepared.target !== 'dev' || !options['--backup-file'] || !options['--backup-sha256']
    || options['--rds-backup-receipt'] || options['--rds-backup-sha256']) fail('FOLLOWUP_DEV_BACKUP_REQUIRED');
  await verifySqlBackup(options['--backup-file'], options['--backup-sha256']);
  const at = now();
  return { schema: 'cliniccloud-dev-backup-verification/1', target: 'dev', sourceIdentitySha256: hash(prepared.database_identity), checkedAtEpochMs: at, expiresAtEpochMs: at + 300000 };
}

function createOperationVerifier(backupProof, prepared, verifyOperation, now = Date.now) {
  return (operation, liveIdentity) => {
    validateProof(backupProof, prepared, now());
    return verifyOperation(operation, liveIdentity);
  };
}

module.exports = { nativeRdsProof, validateProof, verifyReconciliationBackup, createOperationVerifier };
