#!/usr/bin/env node
'use strict';
// Two literal-source examples only. Inactive treatment drafts + program drafts;
// no calendar/economy/event imports, no runtime capabilities or legacy changes.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { prepareProgramExamples } = require('../lib/cliniccloud-import/program-examples');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const fail = code => { throw new Error(code); };
async function run(args) {
  const o = parseArgs(args, ['--mode', '--catalog-plan', '--workbook', '--client-replies', '--private-output', '--approved-sha256', '--backup-manifest']);
  if (!['prepare', 'apply'].includes(o['--mode']) || !o['--private-output']) fail('EXPLICIT_MODE_AND_PRIVATE_OUTPUT_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') fail('DEV_WORKTREE_REQUIRED');
  const plan = privateJson(o['--catalog-plan']);
  if (hash(readBytes(o['--workbook'])) !== plan.workbook_sha256 || hash(readBytes(o['--client-replies'])) !== plan.replies_sha256) fail('CATALOG_SOURCES_CHANGED');
  const examples = prepareProgramExamples(plan);
  const packageBody = { version: 'cliniccloud-program-examples/1', source_plan_sha256: plan.plan_sha256, examples,
    clinic_id: 72, treatment_active: false, program_status: 'draft', appointments_created: false, automation_activated: false, fiscal_price_base: null };
  const packageHash = hash(packageBody);
  if (o['--mode'] === 'prepare') { writePrivateJson(o['--private-output'], { ...packageBody, package_sha256: packageHash }); return { mode: 'offline_prepare', package_sha256: packageHash, treatment_drafts: 2, program_drafts: 2 }; }
  if (o['--approved-sha256'] !== packageHash) fail('EXACT_PACKAGE_HASH_REQUIRED');
  const backup = await validateBackup(o['--backup-manifest']);
  writePrivateJson(o['--private-output'], { status: 'intent', package_sha256: packageHash, backup, package: packageBody });
  require('dotenv').config({ quiet: true });
  const db = require('../../models');
  let committed = false;
  try {
    const result = await db.sequelize.transaction(async transaction => {
      const clinic = await db.Clinica.findByPk(72, { attributes: ['id_clinica', 'grupoClinicaId'], transaction, lock: transaction.LOCK.UPDATE });
      const capilar = await db.Clinica.findByPk(66, { attributes: ['id_clinica', 'grupoClinicaId'], transaction });
      if (!clinic?.grupoClinicaId || clinic.grupoClinicaId !== capilar?.grupoClinicaId) fail('CLINIC_SCOPE_CHANGED');
      const output = [];
      for (const example of examples) {
        const existing = await db.Tratamiento.findAll({ where: { codigo: example.treatment.codigo }, transaction });
        if (existing.length > 1) fail('DUPLICATE_SOURCE_TREATMENT_CODE');
        let treatment = existing[0];
        if (treatment && (treatment.clinica_id !== 72 || treatment.activo || treatment.clinical_config?.import_batch !== example.treatment.clinical_config.import_batch || hash(treatment.clinical_config) !== hash(example.treatment.clinical_config))) fail('EXISTING_TREATMENT_REQUIRES_REVIEW');
        if (treatment && hash(Object.fromEntries(Object.keys(example.treatment).map(key => [key, treatment[key]]))) !== hash(example.treatment)) fail('EXISTING_TREATMENT_FIELDS_CHANGED');
        const treatmentCreated = !treatment;
        treatment ||= await db.Tratamiento.create(example.treatment, { transaction });
        const values = { ...example.program, appointments: example.program.appointments.map(({ treatment_code, ...appointment }) => ({ ...appointment, treatment_ids: [treatment.id_tratamiento] })) };
        const requestKey = hash(['cliniccloud-program-examples', 72, example.source_catalog_key]);
        let program = await db.TreatmentProgram.findOne({ where: { request_key: requestKey }, transaction });
        const programCreated = !program;
        if (program && (program.clinic_id !== 72 || program.status !== 'draft' || program.request_payload_hash !== hash(values))) fail('EXISTING_PROGRAM_REQUIRES_REVIEW');
        if (program && hash(Object.fromEntries(Object.keys(values).map(key => [key, key === 'total_price' ? Number(program[key]) : program[key]]))) !== hash(values)) fail('EXISTING_PROGRAM_FIELDS_CHANGED');
        if (!program) {
          const nameCollision = await db.TreatmentProgram.count({ where: { clinic_id: 72, name: values.name }, transaction });
          if (nameCollision) fail('PROGRAM_NAME_ALREADY_EXISTS_REVIEW_REQUIRED');
          program = await db.TreatmentProgram.create({ public_id: crypto.randomUUID(), clinic_id: 72, ...values, request_key: requestKey, request_payload_hash: hash(values), version_number: 1, created_by: null, updated_by: null }, { transaction });
          await db.TreatmentProgramRevision.create({ program_id: program.id, version_number: 1, snapshot: program.toJSON(), actor_id: null, created_at: new Date() }, { transaction });
        }
        output.push({ treatment_id: treatment.id_tratamiento, program_id: program.public_id, treatment_created: treatmentCreated, program_created: programCreated, treatment_after: treatment.toJSON(), program_after: program.toJSON() });
      }
      return output;
    });
    committed = true;
    writePrivateJson(o['--private-output'] + '.result.json', { status: 'committed', package_sha256: packageHash, result, automation_activated: false });
    return { mode: 'draft_examples_only', treatment_drafts_created: result.filter(r => r.treatment_created).length, program_drafts_created: result.filter(r => r.program_created).length, appointments_created: 0, sales_created: 0, automation_activated: false, package_sha256: packageHash };
  } catch (error) {
    if (committed) fail('COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    // A transaction failure can be a lost COMMIT response. Do not claim rollback.
    throw error;
  } finally { await db.sequelize.close(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'DRAFT_EXAMPLES_STOPPED_REVIEW_PRIVATE_JOURNAL'); process.exitCode = 1; });
module.exports = { run };
