#!/usr/bin/env node
'use strict';
// Explicit, one-time onboarding of the authorized provisional BS roster only.
// No application bootstrap, login token, MFA change, message, or appointment.
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { validateRoster, aliasEmail, assertActivationIdentity, activateEntry, hash } = require('../lib/cliniccloud-import/staff-activation');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
async function capture(c, plan, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [clinics] = await c.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica'+suffix);
  if (clinics.length !== 2 || clinics.some(x=>Number(x.grupoClinicaId)!==29)) throw Error('STAFF_GROUP_CHANGED');
  const [[actor]] = await c.query('SELECT id_usuario,email_usuario FROM Usuarios WHERE id_usuario=1'+suffix);
  if(actor?.email_usuario!=='carlos@clinicaclick.com') throw Error('STAFF_OPERATOR_CHANGED');
  const [triggers]=await c.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('Usuarios','UsuarioClinica','DoctorClinicas')");
  if(triggers.length) throw Error('STAFF_TRIGGERS_REQUIRE_REVIEW');
  const ids=plan.staff.map(p=>p.id).filter(Boolean), emails=plan.staff.map(p=>aliasEmail(plan.mailbox,p.alias));
  const [users]=await c.query('SELECT * FROM Usuarios WHERE id_usuario IN (?) OR email_usuario IN (?) OR nombre IN (?) ORDER BY id_usuario'+suffix,[ids,emails,plan.staff.filter(p=>!p.id).map(p=>p.name)]);
  const [memberships]=await c.query('SELECT * FROM UsuarioClinica WHERE id_usuario IN (?) ORDER BY id_usuario,id_clinica'+suffix,[ids]);
  const [professionals]=await c.query('SELECT * FROM DoctorClinicas WHERE doctor_id IN (?) ORDER BY id'+suffix,[ids]);
  return {clinics,actor,users,memberships,professionals};
}
async function run(args) {
  const o=parseArgs(args,['--mode','--target','--plan','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  if(o['--target']!=='crm'||!['prepare','apply'].includes(o['--mode'])||process.cwd()!=='/home/ubuntu/wt/back-dev'||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev') throw Error('STAFF_EXPLICIT_DEV_OPERATOR_REQUIRED');
  const c=await connectOperatorDatabase('crm'); let journal,commitAttempted=false;
  try {
    if(o['--mode']==='prepare') {
      const plan=validateRoster(privateJson(o['--plan']));
      await c.query('START TRANSACTION READ ONLY');const before=await capture(c,plan);await c.rollback();
      const entries=[];
      for(const p of plan.staff) {
        const email=aliasEmail(plan.mailbox,p.alias);
        if(before.users.some(u=>u.email_usuario===email)) throw Error('STAFF_ALIAS_ALREADY_EXISTS');
        if(p.id) assertActivationIdentity(p,before.users.find(u=>u.id_usuario===p.id),before.memberships.filter(m=>m.id_usuario===p.id),[66,72]);
        else if(before.users.some(u=>u.nombre===p.name)) throw Error('STAFF_NAME_REQUIRES_MATCHING');
        const password=randomBytes(18).toString('base64url')+'9a!';
        entries.push({...p,email,password,password_hash:await bcrypt.hash(password,12)});
      }
      const body={version:1,target:'crm',created_at:new Date().toISOString(),plan,before,before_sha256:hash(before),entries};
      const pkg={...body,package_sha256:hash(body)};writePrivateJson(o['--private-output'],pkg);
      return {status:'prepared',existing:entries.filter(e=>e.id).length,new:entries.filter(e=>!e.id).length,package_sha256:pkg.package_sha256};
    }
    const pkg=privateJson(o['--package']),{package_sha256,...body}=pkg;
    validateRoster(pkg.plan);
    if(hash(body)!==package_sha256||o['--approved-sha256']!==package_sha256||Date.now()-Date.parse(pkg.created_at)>7200000||Date.parse(pkg.created_at)>Date.now())throw Error('STAFF_FRESH_PACKAGE_REQUIRED');
    if(hash(pkg.entries.map(({email,password,password_hash,...e})=>e))!==hash(pkg.plan.staff))throw Error('STAFF_PACKAGE_ROSTER_CHANGED');
    for(const e of pkg.entries) if(e.email!==aliasEmail(pkg.plan.mailbox,e.alias)||!await bcrypt.compare(e.password,e.password_hash))throw Error('STAFF_CREDENTIAL_PACKAGE_INVALID');
    const manifest=privateJson(o['--backup-manifest']);
    if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified)throw Error('STAFF_COMPLETE_BACKUP_REQUIRED');
    const backup=await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c,package_sha256,o['--private-journal']);journal=openJournal(o['--private-journal'],package_sha256);
    await c.beginTransaction(); const before=await capture(c,pkg.plan,true);
    if(hash(before)!==pkg.before_sha256)throw Error('STAFF_STATE_CHANGED_OR_ALREADY_APPLIED');
    await journal.append({stage:'prepared',backup,before,entries:pkg.entries.map(({password,...e})=>e),authority:'owner_requested_bs_staff_temporary_alias_onboarding'});
    const activated=[];
    for(const entry of pkg.entries) activated.push(await activateEntry(c,entry,{actorId:1,allowedClinics:[66,72]}));
    await journal.append({stage:'written_before_commit',activated});commitAttempted=true;await c.commit();await journal.append({stage:'committed',activated});
    return {status:'committed',activated:activated.length,mfa_changed:false,login_sessions_created:0,messages_sent:0,appointments_changed:0};
  } catch(e) {await c.rollback().catch(()=>{});if(commitAttempted)throw Error('STAFF_COMMIT_REQUIRES_JOURNAL_REVIEW');throw e;}
  finally {journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'STAFF_PROVISION_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={run,capture};
