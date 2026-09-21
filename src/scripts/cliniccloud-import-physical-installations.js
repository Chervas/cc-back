#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { preparePhysicalInstallations, verifyPhysicalPackage } = require('../lib/cliniccloud-import/physical-installations');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
async function capture(c, lock = false) {
  const [clinics] = await c.query(`SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica${lock ? ' FOR UPDATE' : ''}`);
  if (clinics.length !== 2 || clinics.some(r => Number(r.grupoClinicaId) !== 29)) throw Error('PHYSICAL_GROUP_DRIFT');
  const [triggers] = await c.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('Instalaciones','InstallationPhysicalAliases')");
  if (triggers.length) throw Error('PHYSICAL_TRIGGERS_REQUIRE_REVIEW');
  const [installations] = await c.query(`SELECT * FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY id${lock ? ' FOR UPDATE' : ''}`);
  const [aliases] = await c.query(`SELECT * FROM InstallationPhysicalAliases WHERE group_id=29 ORDER BY installation_id${lock ? ' FOR UPDATE' : ''}`);
  return { installations, aliases };
}
async function run(args) {
  const o = parseArgs(args, ['--mode','--target','--sources','--private-output','--package','--approved-sha256','--backup-manifest','--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare','apply'].includes(o['--mode'])) throw Error('EXPLICIT_CRM_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const c = await connectOperatorDatabase('crm'); let journal, commitAttempted = false;
  try {
    if (o['--mode'] === 'prepare') {
      const sources = privateJson(o['--sources']);
      for (const s of sources) if (hash(readBytes(s.path)) !== s.sha256) throw Error('PHYSICAL_SOURCE_DRIFT');
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const current = await capture(c);
      await c.rollback();
      const pkg = preparePhysicalInstallations({ sources, ...current, groupId: 29, target: 'crm' });
      writePrivateJson(o['--private-output'], pkg);
      return { mode: 'prepared', logical_installations: pkg.rows.length, physical_locations: new Set(pkg.rows.map(r=>r.key)).size,
        installations_to_create: pkg.additions.length, installations_preserved: pkg.preserved.length,
        aliases_to_create: pkg.alias_additions.length, package_sha256: pkg.package_sha256 };
    }
    const pkg = privateJson(o['--package']); verifyPhysicalPackage(pkg);
    if (o['--approved-sha256'] !== pkg.package_sha256 || !Number.isFinite(Date.parse(pkg.created_at)) || Date.now()-Date.parse(pkg.created_at)>2*3600000 || Date.parse(pkg.created_at)>Date.now()) throw Error('FRESH_PHYSICAL_PACKAGE_APPROVAL_REQUIRED');
    for (const s of pkg.sources) if (hash(readBytes(s.path)) !== s.sha256) throw Error('PHYSICAL_SOURCE_DRIFT');
    const manifest = privateJson(o['--backup-manifest']);
    if (manifest.database_target !== 'crm' || !manifest.full_gzip_verified || !manifest.dump_completion_verified) throw Error('VERIFIED_CRM_BACKUP_REQUIRED');
    const backup = await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
    const before = await capture(c, true);
    // Replay is intentionally fail-closed: new IDs or changed old rows require
    // reading the durable journal, never creating another set automatically.
    if (hash(before) !== pkg.before_sha256) throw Error('PHYSICAL_RESOURCE_STATE_DRIFT_REVIEW_JOURNAL');
    await journal.append({ stage: 'prepared', backup, before, proposed: pkg.additions, preserved:pkg.preserved, operator: 'codex-authorized-cliniccloud-import' });
    const inserted = [];
    for (const row of pkg.additions) {
      const [result] = await c.query('INSERT INTO Instalaciones (clinica_id,nombre,tipo,descripcion,color,capacidad,activo,requiere_preparacion,tiempo_preparacion_minutos,es_exclusiva,default_duracion_minutos,especialidades_permitidas,tratamientos_exclusivos,equipamiento,orden_visualizacion,created_at,updated_at) VALUES (?,?,?,?,?,1,0,0,0,0,30,?,?,?, ?,UTC_TIMESTAMP(),UTC_TIMESTAMP())',
        [row.clinic_id,row.name,row.type,`Mapa físico documental BS 2026. ${row.key}. Pendiente de activación tras conciliar agenda. Paquete ${pkg.package_sha256}.`,'#64748b','[]','[]','[]',row.key==='Hospital'?90:Number(row.key.slice(1))]);
      if (result.affectedRows!==1 || !Number.isSafeInteger(Number(result.insertId))) throw Error('PHYSICAL_INSERT_FAILED');
      inserted.push({ ...row, id: Number(result.insertId) });
    }
    const insertedAliases = [];
    for (const addition of pkg.alias_additions) {
      const row = inserted.find(r=>r.key===addition.key&&r.clinic_id===addition.clinic_id);
      const canonical = [...inserted,...pkg.preserved].find(r=>r.key===addition.key&&r.clinic_id===addition.canonical_clinic_id);
      if (!canonical) throw Error('PHYSICAL_CANONICAL_ROW_MISSING');
      await c.query('INSERT INTO InstallationPhysicalAliases (installation_id,canonical_installation_id,group_id,created_at,updated_at) VALUES (?,?,29,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[row.id,canonical.id]);
      insertedAliases.push({ installation_id:row.id,canonical_installation_id:canonical.id,group_id:29 });
    }
    const after = await capture(c);
    if (hash(after.installations.filter(r=>!inserted.some(i=>i.id===r.id)))!==hash(before.installations)
      || hash(after.aliases.filter(r=>!insertedAliases.some(a=>a.installation_id===r.installation_id)))!==hash(before.aliases)
      || inserted.some(i=>!after.installations.some(r=>r.id===i.id&&r.clinica_id===i.clinic_id&&r.nombre===i.name&&Number(r.activo)===0))
      || insertedAliases.some(a=>!after.aliases.some(r=>r.installation_id===a.installation_id&&r.canonical_installation_id===a.canonical_installation_id))) throw Error('PHYSICAL_POST_WRITE_VERIFICATION_FAILED');
    await journal.append({ stage:'written_before_commit', inserted, inserted_aliases:insertedAliases, after_sha256:hash(after) });
    commitAttempted=true; await c.commit();
    await journal.append({ stage:'committed', inserted, inserted_aliases:insertedAliases, after_sha256:hash(after) });
    return { status:'committed', installations_created:inserted.length, physical_aliases_created:insertedAliases.length, active_installations_created:0, appointments_changed:0, reminders_activated:false };
  } catch(e) {
    await c.rollback().catch(()=>{});
    if (commitAttempted) throw Error('PHYSICAL_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');
    throw e;
  } finally { journal?.close(); await c.end(); }
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'PHYSICAL_IMPORT_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={run,capture};
