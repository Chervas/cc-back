#!/usr/bin/env node
'use strict';

// Read-only preparation/check only. Deliberately no apply mode or SQL DML.
const fs = require('node:fs');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const planner = require('../lib/cliniccloud-import/bs-client-program-replies');
const fail = code => { throw Error(code); };
function privateJson(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('BS_REPLIES_PRIVATE_INPUT_REQUIRED');
  return JSON.parse(readBytes(filename));
}
async function capture(connection) {
  const select = async (sql, params = []) => (await connection.query(sql, params))[0];
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const clinics = await select('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica');
    const programs = await select('SELECT * FROM TreatmentPrograms WHERE clinic_id IN (66,72) ORDER BY id');
    const treatments = await select('SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) ORDER BY id_tratamiento');
    const revisions = programs.length ? await select('SELECT * FROM TreatmentProgramRevisions WHERE program_id IN (?) ORDER BY id', [programs.map(row => row.id)]) : [];
    const rooms = await select('SELECT * FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY id');
    const professionals = await select('SELECT id,doctor_id,clinica_id,activo,recibe_citas FROM DoctorClinicas WHERE clinica_id IN (66,72) ORDER BY id');
    const aliases = await select('SELECT * FROM InstallationPhysicalAliases WHERE group_id=29 ORDER BY installation_id');
    const equipment = await select('SELECT * FROM BookingEquipment WHERE group_id=29 ORDER BY id');
    const equipmentClinics = await select('SELECT * FROM BookingEquipmentClinics WHERE clinic_id IN (66,72) ORDER BY equipment_id,clinic_id');
    const equipmentRoomPolicies = await select('SELECT p.* FROM BookingEquipmentRoomPolicies p JOIN Instalaciones i ON i.id=p.installation_id WHERE i.clinica_id IN (66,72) ORDER BY p.installation_id');
    await connection.query('ROLLBACK');
    return { target: 'crm', group_id: 29, captured_at: new Date().toISOString(), clinics, programs,
      configuration: { treatments, rooms, professionals, aliases, equipment, equipmentClinics, equipmentRoomPolicies },
      revisions, read_only: true, application_bootstrapped: false, patient_rows_read: false };
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
}
function stableSnapshot(snapshot) {
  const result = { ...snapshot }; delete result.captured_at; return result;
}
async function canonicalPreviews(plan, snapshot) {
  const browser = await require('puppeteer-core').connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
  try {
    const page = (await browser.pages()).find(p => p.url().startsWith('https://crm.clinicaclick.com/') && !p.url().includes('/sign-in'));
    if (!page) fail('BS_REPLIES_NORMAL_CRM_SESSION_REQUIRED');
    const results = [];
    for (const row of snapshot.programs) {
      const operation = plan.operations.find(value => value.program_id === Number(row.id));
      // A preview POST calls normalize/summarize/enrichment, but never creates a
      // definition, revision, booking, sale, consent document or message.
      const payload = { ...(operation?.after || planner.values(row)), status: row.status === 'archived' ? 'archived' : 'active' };
      const response = await page.evaluate(async ({ clinicId, programId, payload }) => {
        const token = localStorage.getItem('accessToken');
        if (!token) return { status: 401 };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const current = await fetch(`/api/treatment-programs/${programId}?clinic_id=${clinicId}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
          });
          if (!current.ok) return { status: current.status };
          const existing = await current.json();
          const result = await fetch(`/api/treatment-programs/preview?clinic_id=${clinicId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload), signal: controller.signal,
          });
          const body = await result.json();
          return { status: result.status, current: existing.item, item: body.item, code: body.code || body.error?.code || null };
        } finally { clearTimeout(timer); }
      }, { clinicId: Number(row.clinic_id), programId: row.public_id, payload });
      if (response.status !== 200 || !response.item) fail(`BS_REPLIES_CANONICAL_PREVIEW_FAILED_${response.status}`);
      if (response.current?.id !== row.public_id || response.current?.version !== Number(row.version_number)
          || hash(planner.canonicalApiValues(response.current)) !== hash(planner.values(row))) fail('BS_REPLIES_CANONICAL_GET_DIFFERS_FROM_SNAPSHOT');
      results.push({ program_id: Number(row.id), checked_at: new Date().toISOString(), current: response.current, item: response.item });
    }
    return results;
  } finally { browser.disconnect(); }
}
async function run(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--workbook', '--decision', '--package', '--private-output', '--canonical-preview']);
  if (args['--target'] !== 'crm' || !['prepare', 'check'].includes(args['--mode'])) fail('BS_REPLIES_EXPLICIT_READ_ONLY_MODE_REQUIRED');
  if (args['--canonical-preview'] != null && args['--canonical-preview'] !== 'true') fail('BS_REPLIES_PREVIEW_FLAG_INVALID');
  const connection = await connectOperatorDatabase('crm');
  try {
    const snapshot = await capture(connection);
    if (args['--mode'] === 'check') {
      if (args['--canonical-preview']) fail('BS_REPLIES_CHECK_DOES_NOT_REFRESH_SEALED_PREVIEWS');
      const bundle = privateJson(args['--package']); planner.assertPlan(bundle.plan);
      if (hash(bundle.snapshot) !== bundle.plan.snapshot_sha256) fail('BS_REPLIES_SEALED_SNAPSHOT_CHANGED');
      if (hash(readBytes(args['--workbook'])) !== bundle.plan.decision.workbook_sha256) fail('BS_REPLIES_WORKBOOK_CHANGED');
      if (bundle.canonical_readiness_sha256 !== hash(bundle.canonical_readiness)) fail('BS_REPLIES_CANONICAL_EVIDENCE_CHANGED');
      const states = bundle.plan.operations.map(operation => {
        const current = snapshot.programs.find(row => Number(row.id) === operation.program_id);
        let state = planner.assessCurrent(operation, current);
        if (state === 'applied_requires_revision_verification' && planner.verifyAppliedRevision(operation, current, snapshot.revisions)) state = 'applied_verified';
        return { program_id: operation.program_id, state };
      });
      const configurationUnchanged = hash(snapshot.configuration) === hash(bundle.snapshot.configuration);
      const originalRevisionsPreserved = bundle.snapshot.revisions.every(row => hash(row) === hash(snapshot.revisions.find(current => Number(current.id) === Number(row.id))));
      const targetIds = new Set(bundle.plan.operations.map(row => row.program_id));
      const otherProgramsUnchanged = hash(snapshot.programs.filter(row => !targetIds.has(Number(row.id))))
        === hash(bundle.snapshot.programs.filter(row => !targetIds.has(Number(row.id))));
      const age = Date.now() - Date.parse(bundle.plan.created_at);
      const fresh = age >= 0 && age <= 7200000;
      const result = { version: planner.VERSION, target: 'crm', mode: 'check_read_only', checked_at: snapshot.captured_at,
        package_sha256: bundle.plan.package_sha256, states, configuration_unchanged: configurationUnchanged,
        original_revisions_preserved: originalRevisionsPreserved, other_programs_unchanged: otherProgramsUnchanged,
        package_within_two_hours: fresh,
        all_pending_exact: states.every(row => row.state === 'pending') && configurationUnchanged && originalRevisionsPreserved && otherProgramsUnchanged && fresh,
        all_applied_verified: states.every(row => row.state === 'applied_verified') && configurationUnchanged && originalRevisionsPreserved && otherProgramsUnchanged,
        writes: 0, provider_calls: 0, application_bootstrapped: false };
      writePrivateJson(args['--private-output'], result); return result;
    }
    const decision = privateJson(args['--decision']);
    if (hash(readBytes(args['--workbook'])) !== decision.workbook_sha256) fail('BS_REPLIES_WORKBOOK_CHANGED');
    let plan = planner.buildPlan({ snapshot, decision });
    if (args['--canonical-preview']) {
      const previews = await canonicalPreviews(plan, snapshot);
      const after = await capture(connection);
      if (hash(stableSnapshot(snapshot)) !== hash(stableSnapshot(after))) fail('BS_REPLIES_CONFIGURATION_CHANGED_DURING_PREVIEW');
      plan = planner.buildPlan({ snapshot, decision, previews });
      snapshot.canonical_readiness = previews;
    }
    // Keep the DB snapshot byte-stable: API evidence is separately sealed in the
    // bundle, while only previews used by an operation are part of that plan.
    const apiReadiness = snapshot.canonical_readiness || [];
    delete snapshot.canonical_readiness;
    const bundle = { snapshot, plan, canonical_readiness: apiReadiness, canonical_readiness_sha256: hash(apiReadiness), writes: 0, provider_calls: 0 };
    writePrivateJson(args['--private-output'], bundle);
    return { version: planner.VERSION, mode: 'prepared_read_only', target: 'crm', package_sha256: plan.package_sha256,
      programs_read: snapshot.programs.length, operations: plan.operations.map(operation => ({ program_id: operation.program_id,
        expected_version: operation.expected_version, dates_changed: operation.dates_changed, activation: operation.activation,
        issues: operation.canonical_preview?.item?.summary?.issues || [] })), writes: 0, provider_calls: 0 };
  } finally { await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^BS_REPLIES_/.test(error.message) ? error.message : 'BS_REPLIES_READ_ONLY_PREPARATION_FAILED'); process.exitCode = 1;
});
module.exports = { capture, stableSnapshot, canonicalPreviews, run };
