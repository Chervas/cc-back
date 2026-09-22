#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { prepareConsentLinks, verifyConsentLinks, verifyLinkedState } = require('../lib/cliniccloud-import/catalog-consent-links');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');

async function capture(c, plan, review, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const keys = new Set(review.bindings.map(b => b.source_catalog_key));
  const codes = plan.rows.filter(r => keys.has(r.source_catalog_key)).map(r => r.proposed_code);
  const templateIds = [...new Set(review.bindings.map(b => b.clinic_template_id))].sort((a,b) => a-b);
  if (!codes.length || codes.length > 75 || !templateIds.length || templateIds.length > 150) throw Error('CONSENT_LINK_SCOPE_LIMIT');
  const [clinics] = await c.query('SELECT id_clinica,grupoClinicaId AS grupo_clinica_id FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica' + suffix);
  const [treatments] = await c.query('SELECT * FROM Tratamientos WHERE codigo IN (?) ORDER BY id_tratamiento' + suffix, [codes]);
  if (!treatments.length) throw Error('CONSENT_LINK_DRAFTS_MISSING');
  const ids = treatments.map(t => t.id_tratamiento);
  const [templates] = await c.query('SELECT * FROM ClinicConsentTemplates WHERE id IN (?) ORDER BY id' + suffix, [templateIds]);
  const [versions] = await c.query('SELECT * FROM ClinicConsentTemplateVersions WHERE clinic_template_id IN (?) ORDER BY id' + suffix, [templateIds]);
  const [requirements] = await c.query('SELECT * FROM TreatmentConsentRequirements WHERE tratamiento_id IN (?) ORDER BY id' + suffix, [ids]);
  const [appointments] = await c.query('SELECT id_cita,tratamiento_id FROM CitasPacientes WHERE tratamiento_id IN (?) ORDER BY id_cita' + suffix, [ids]);
  return { clinics, treatments, templates, versions, requirements, appointments };
}
async function execute({ c, pkg, plan, journal, dryRun = false }) {
  let commitAttempted = false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await c.beginTransaction();
    const before = await capture(c, plan, pkg.review, true);
    if (hash(before) !== pkg.before_sha256) {
      // Preserve exact prior application; never restore a later human edit.
      verifyLinkedState(before, pkg);
      await c.rollback(); await journal.append({ stage: 'consent_links_replay_preserved', inserted: 0 });
      return { status: 'replay_preserved', inserted: 0 };
    }
    await journal.append({ stage: 'consent_links_prepared', before, operations: pkg.operations });
    const inserted = [];
    for (const row of pkg.operations) {
      const [result] = await c.query('INSERT INTO TreatmentConsentRequirements SET ?,createdAt=UTC_TIMESTAMP(),updatedAt=UTC_TIMESTAMP()', [row]);
      if (result.affectedRows !== 1 || !result.insertId) throw Error('CONSENT_LINK_INSERT_FAILED');
      inserted.push(result.insertId);
    }
    const after = await capture(c, plan, pkg.review);
    verifyLinkedState(after, pkg);
    await journal.append({ stage: 'consent_links_verified_before_commit', inserted_ids: inserted, after_sha256: hash(after), after });
    if (dryRun) {
      await c.rollback();
      if (hash(await capture(c, plan, pkg.review)) !== pkg.before_sha256) throw Error('CONSENT_LINK_ROLLBACK_MISMATCH');
      await journal.append({ stage: 'consent_links_dry_run_rolled_back', proposed: inserted.length });
      return { status: 'rolled_back_and_verified', proposed: inserted.length, inserted: 0 };
    }
    commitAttempted = true; await c.commit();
    await journal.append({ stage: 'consent_links_committed', inserted: inserted.length, after_sha256: hash(after) });
    const independent = await connectOperatorDatabase('crm');
    try {
      await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const readback = await capture(independent, plan, pkg.review);
      verifyLinkedState(readback, pkg);
      if (hash(readback) !== hash(after)) throw Error('CONSENT_LINK_READBACK_MISMATCH');
      await independent.rollback();
      await journal.append({ stage: 'consent_links_independent_read_verified', after_sha256: hash(readback) });
    } finally { await independent.end(); }
    return { status: 'committed_and_verified', inserted: inserted.length,
      treatments: pkg.before.treatments.length, activated: 0, messages: 0, clinical_approval: false };
  } catch (error) {
    await c.rollback().catch(() => {});
    if (commitAttempted) throw Error('CONSENT_LINK_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');
    throw error;
  }
}
async function run(args) {
  const o = parseArgs(args, ['--mode','--target','--plan','--workbook','--review','--package','--private-output',
    '--approved-sha256','--backup-manifest','--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare','dry-run','apply','verify'].includes(o['--mode'])) throw Error('EXPLICIT_CRM_CONSENT_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
    || execFileSync('git', ['branch','--show-current'], { encoding:'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const plan = privateJson(o['--plan']);
  if (hash(readBytes(o['--workbook'])) !== plan.workbook_sha256) throw Error('CONSENT_LINK_SOURCE_CHANGED');
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    if (o['--mode'] === 'prepare') {
      const review = privateJson(o['--review']);
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(c, plan, review);
      const pkg = prepareConsentLinks({ plan, review, before });
      await c.rollback(); writePrivateJson(o['--private-output'], pkg);
      return { status:'prepared', treatments: before.treatments.length, proposed: pkg.operations.length, package_sha256:pkg.package_sha256, writes:0 };
    }
    const pkg = privateJson(o['--package']); verifyConsentLinks(pkg, plan);
    if (o['--mode'] === 'verify') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const after = await capture(c, plan, pkg.review); verifyLinkedState(after, pkg); await c.rollback();
      writePrivateJson(o['--private-output'], { verified_at:new Date().toISOString(), package_sha256:pkg.package_sha256,
        after_sha256:hash(after), after, policy:pkg.policy });
      return { status:'verified_read_only', requirements:after.requirements.length, treatments:after.treatments.length };
    }
    if (o['--approved-sha256'] !== pkg.package_sha256 || !Number.isFinite(Date.parse(pkg.created_at))
      || Date.now()-Date.parse(pkg.created_at)>7200000 || Date.parse(pkg.created_at)>Date.now()) throw Error('FRESH_CONSENT_LINK_APPROVAL_REQUIRED');
    if (!pkg.operations.length) throw Error('CONSENT_LINK_EMPTY_PACKAGE');
    const manifest = privateJson(o['--backup-manifest']);
    if (manifest.database_target !== 'crm' || !manifest.full_gzip_verified || !manifest.dump_completion_verified) throw Error('CONSENT_LINK_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    await journal.append({ stage:'consent_links_verified', mode:o['--mode'], backup_manifest_sha256:hash(readBytes(o['--backup-manifest'])) });
    return await execute({ c, pkg, plan, journal, dryRun:o['--mode']==='dry-run' });
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
  console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CONSENT_LINK_FAILED_REVIEW_PRIVATE_JOURNAL'); process.exitCode=1;
});
module.exports = { capture, execute, run };
