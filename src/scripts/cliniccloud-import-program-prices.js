#!/usr/bin/env node
'use strict';

// Offline operator: SQL reads only; mutations use the normal session-bound API.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { normalizeValues } = require('../lib/treatmentPrograms.contract');
const { SOURCES, prepare, verifyPackage, verifyState } = require('../lib/cliniccloud-import/program-prices');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');

async function capture(c) {
  const select = async sql => (await c.query(sql))[0];
  return {
    clinics: await select('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN(66,72) ORDER BY id_clinica'),
    programs: await select('SELECT * FROM TreatmentPrograms WHERE clinic_id IN(66,72) ORDER BY id'),
    revisions: await select('SELECT r.* FROM TreatmentProgramRevisions r JOIN TreatmentPrograms p ON p.id=r.program_id WHERE p.clinic_id IN(66,72) ORDER BY r.id'),
  };
}
async function protectedRows(c) {
  const result = {};
  const queries = {
    appointments: 'SELECT * FROM CitasPacientes WHERE clinica_id IN(66,72) ORDER BY id_cita',
    treatments: 'SELECT * FROM Tratamientos WHERE clinica_id IN(66,72) ORDER BY id_tratamiento',
    requirements: 'SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN(66,72) ORDER BY id',
    budgets: 'SELECT * FROM EconomicBudgets WHERE clinic_id IN(66,72) ORDER BY id',
    budget_versions: 'SELECT v.* FROM EconomicBudgetVersions v JOIN EconomicBudgets b ON b.id=v.budget_id WHERE b.clinic_id IN(66,72) ORDER BY v.id',
    purchases: 'SELECT * FROM PatientVouchers WHERE clinic_id IN(66,72) ORDER BY id',
    program_sessions: 'SELECT s.* FROM PatientProgramSessions s JOIN PatientVouchers v ON v.id=s.voucher_id WHERE v.clinic_id IN(66,72) ORDER BY s.id',
    booking_requests: 'SELECT s.* FROM PatientProgramBookingRequests s JOIN PatientVouchers v ON v.id=s.voucher_id WHERE v.clinic_id IN(66,72) ORDER BY s.id',
  };
  for (const [key, sql] of Object.entries(queries)) {
    const [rows] = await c.query(sql); result[key] = { count: rows.length, sha256: hash(rows) };
  }
  return result;
}
function assertPreserved(actual, before, pkg) {
  assert.equal(hash(actual.clinics), hash(before.clinics), 'PROGRAM_PRICE_SCOPE_CHANGED');
  assert.equal(actual.programs.length, before.programs.length, 'PROGRAM_PRICE_CATALOG_CHANGED');
  const ids = new Set(pkg.operations.map(op => op.before.id));
  for (const row of before.programs.filter(p => !ids.has(p.id))) {
    const current = actual.programs.find(p => p.id === row.id);
    assert(current && hash(current) === hash(row), 'PROGRAM_PRICE_OTHER_PROGRAM_CHANGED');
  }
  for (const row of before.revisions) {
    const current = actual.revisions.find(r => r.id === row.id);
    assert(current && hash(current) === hash(row), 'PROGRAM_PRICE_OLD_REVISION_CHANGED');
  }
  const newRevisions = actual.revisions.filter(r => !before.revisions.some(old => old.id === r.id));
  assert(newRevisions.every(r => ids.has(r.program_id)), 'PROGRAM_PRICE_OTHER_REVISION_CHANGED');
}
async function execute({ pkg, before, read, call, journal, preview = false }) {
  verifyPackage(pkg);
  let updated = 0, skipped = 0;
  for (const op of pkg.operations) {
    const actual = await read(); assertPreserved(actual, before, pkg); verifyState(actual, pkg);
    const row = actual.programs.find(p => p.id === op.before.id);
    if (!preview && row.version_number === op.before.version_number + 1) { skipped++; continue; }
    const route = `treatment-programs/${preview ? 'preview' : op.before.public_id}?clinic_id=${op.clinic_id}`;
    const payload = preview ? normalizeValues(op.payload, { current: op.before }) : op.payload;
    await journal?.append({ stage: 'api_intent', code: op.code, route, payload_sha256: hash(payload), expected_version: op.before.version_number });
    const response = await call(route, preview ? 'POST' : 'PATCH', payload);
    await journal?.append({ stage: 'api_returned', code: op.code, status: response.status });
    assert.equal(response.status, 200, 'PROGRAM_PRICE_API_REJECTED_RECONCILE_BEFORE_RETRY');
    const item = response.body.item;
    assert.equal(item.clinic_id, op.clinic_id); assert.equal(item.status, 'draft');
    assert.equal(item.purchase_enabled, false); assert.equal(item.total_price, op.source_gross_price);
    assert.equal(item.version, preview ? 0 : op.before.version_number + 1);
    assert.equal(hash(normalizeValues(item)), op.after_values_sha256, 'PROGRAM_PRICE_RESPONSE_CHANGED');
    if (!preview) updated++;
  }
  const actual = await read(); assertPreserved(actual, before, pkg);
  if (preview) assert.equal(hash(actual), hash(before), 'PROGRAM_PRICE_PREVIEW_WROTE');
  else verifyState(actual, pkg, { complete: true });
  return { updated, skipped, previewed: preview ? pkg.operations.length : 0 };
}
function sourceHashes(archive) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import sys,zipfile,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); out={}\nfor n in json.loads(sys.argv[2]):\n a=[i for i in z.infolist() if i.filename.split("/")[-1]==n and not i.filename.startswith("__MACOSX/")]; assert len(a)==1 and a[0].file_size<10485760; out[n]=hashlib.sha256(z.read(a[0])).hexdigest()\nprint(json.dumps(out))',
    archive, JSON.stringify(Object.keys(SOURCES))], { encoding: 'utf8', timeout: 30000 }));
}
const fresh = date => Number.isFinite(Date.parse(date)) && Date.parse(date) <= Date.now() && Date.now() - Date.parse(date) < 7200000;
async function run(args) {
  const o = parseArgs(args, ['--target', '--mode', '--archive', '--early-authorization', '--package', '--private-output', '--approved-sha256', '--backup-manifest', '--private-journal']);
  assert.equal(o['--target'], 'crm', 'EXPLICIT_CRM_TARGET_REQUIRED');
  assert(['prepare', 'preview', 'apply', 'verify'].includes(o['--mode']), 'EXPLICIT_PROGRAM_PRICE_MODE_REQUIRED');
  assert.equal(process.cwd(), '/home/ubuntu/wt/back-dev');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), 'dev');
  const hashes = sourceHashes(o['--archive']); assert.equal(hash(hashes), hash(SOURCES), 'PROGRAM_PRICE_SOURCE_CHANGED');
  const c = await connectOperatorDatabase('crm'); let browser, journal;
  try {
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const before = await capture(c), baseline = await protectedRows(c); await c.rollback();
    if (o['--mode'] === 'prepare') {
      const pkg = prepare({ ...before, sourceHashes: hashes, authorization: o['--early-authorization'] });
      writePrivateJson(o['--private-output'], { prepared_at: new Date().toISOString(), ...pkg });
      return { status: 'prepared', programs: pkg.operations.length, package_sha256: pkg.package_sha256, writes: 0 };
    }
    const { prepared_at, ...pkg } = privateJson(o['--package']); verifyPackage(pkg); verifyState(before, pkg);
    if (o['--mode'] === 'verify') {
      verifyState(before, pkg, { complete: true });
      const result = { status: 'verified', programs: pkg.operations.length, writes: 0, policy: pkg.policy };
      writePrivateJson(o['--private-output'], result); return result;
    }
    // No credential copying, token minting or SQL fallback when MFA has expired.
    browser = await require('puppeteer-core').connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
    const page = (await browser.pages()).find(p => p.url().startsWith('https://crm.clinicaclick.com/') && !p.url().includes('/sign-in'));
    assert(page, 'NORMAL_CRM_SESSION_REQUIRED');
    const call = (route, method, payload) => page.evaluate(async ({ route, method, payload }) => {
      const response = await fetch('/api/' + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('accessToken') },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      return { status: response.status, body: await response.json() };
    }, { route, method, payload });
    for (const id of [66, 72]) assert.equal((await call(`treatment-programs?clinic_id=${id}`, 'GET')).status, 200, 'NORMAL_CRM_SESSION_REQUIRED');
    if (o['--mode'] === 'apply') {
      assert.equal(o['--approved-sha256'], pkg.package_sha256, 'EXACT_PROGRAM_PRICE_APPROVAL_REQUIRED');
      assert(fresh(prepared_at), 'FRESH_PROGRAM_PRICE_REVIEW_REQUIRED');
      assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'CLEAN_COMMITTED_OPERATOR_REQUIRED');
      const backup = privateJson(o['--backup-manifest']);
      assert(backup.database_target === 'crm' && backup.full_gzip_verified && backup.dump_completion_verified && fresh(backup.generated_at), 'FRESH_CRM_BACKUP_REQUIRED');
      await validateBackup(o['--backup-manifest']);
      await acquireExecutorLocks(c, pkg.package_sha256, o['--private-journal']);
      journal = openJournal(o['--private-journal'], pkg.package_sha256);
      await journal.append({ stage: 'before', before, protected_tables: baseline });
    }
    const counts = await execute({ pkg, before, read: () => capture(c), call, journal, preview: o['--mode'] === 'preview' });
    const independent = await connectOperatorDatabase('crm');
    try {
      await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const actual = await capture(independent); assertPreserved(actual, before, pkg);
      verifyState(actual, pkg, { complete: o['--mode'] === 'apply' });
      assert.equal(hash(await protectedRows(independent)), hash(baseline), 'PROTECTED_DATA_CHANGED_INSPECT_DO_NOT_RESTORE');
      await independent.rollback();
    } finally { await independent.end(); }
    const result = { status: o['--mode'], ...counts, protected_tables_unchanged: true, policy: pkg.policy };
    await journal?.append({ stage: 'independent_verified', result }); writePrivateJson(o['--private-output'], result); return result;
  } finally { browser?.disconnect(); journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'PROGRAM_PRICES_STOPPED_REVIEW_JOURNAL'); process.exitCode = 1;
});
module.exports = { capture, protectedRows, assertPreserved, execute, sourceHashes, run };
