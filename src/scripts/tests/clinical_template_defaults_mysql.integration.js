'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),{DataTypes:D,Sequelize:S}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const C=require('../../lib/clinical-episode-contract'),T=require('../../lib/clinical-template-contract');
function load(file,overrides){const local=createRequire(file),module={exports:{}};vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)},{filename:file});return module.exports;}
withIsolatedCampaignMysql(async({sql,models:db,report,registerOwnedLoopbackServer})=>{
 db.Sequelize=S;
 db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},configuracion:D.JSON,grupoClinicaId:D.INTEGER},{tableName:'Clinicas',timestamps:false});
 db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,clinica_id:D.INTEGER,nombre:D.STRING,apellidos:D.STRING,fecha_nacimiento:D.DATEONLY},{tableName:'Pacientes',timestamps:false});
 db.PacienteClinica=sql.define('PacienteClinica',{id:{type:D.INTEGER,primaryKey:true},paciente_id:D.INTEGER,clinica_id:D.INTEGER},{tableName:'PacientesClinicas',timestamps:false});
 db.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,apellidos:D.STRING},{tableName:'Usuarios',timestamps:false});
 db.Tratamiento=sql.define('Tratamiento',{id_tratamiento:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,disciplina:D.STRING,origen:D.STRING,clinica_id:D.INTEGER,grupo_clinica_id:D.INTEGER,activo:D.BOOLEAN,eliminado_por_clinica:D.JSON,clinical_config:D.JSON},{tableName:'Tratamientos',timestamps:false});
 db.CitaPaciente=sql.define('CitaPaciente',{id_cita:{type:D.INTEGER,primaryKey:true},paciente_id:D.INTEGER,clinica_id:D.INTEGER,tratamiento_id:D.INTEGER,doctor_id:D.INTEGER,voucher_id:D.BIGINT.UNSIGNED,import_metadata:D.JSON,
  inicio:D.DATE,fin:D.DATE,estado:D.STRING,titulo:D.STRING,care_started_at:D.DATE,care_schedule_start:D.DATE},{tableName:'CitasPacientes',timestamps:false});
 for(const file of ['appointmentclinicalreport','appointmentclinicalreportrevision','clinicalepisodeappointment','patientvoucher']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 await sql.sync();
 await db.Clinica.bulkCreate([{id_clinica:72,grupoClinicaId:5,configuracion:{timezone:'Europe/Madrid'}},{id_clinica:73}]);
 await db.Paciente.bulkCreate(Array.from({length:12},(_,i)=>({id_paciente:11+i,public_id:'synthetic-'+(11+i),clinica_id:i===11?73:72,nombre:'Paciente',apellidos:'Ficticio'})));
 await db.Usuario.create({id_usuario:7,nombre:'Profesional',apellidos:'Ficticio'});
 await db.Tratamiento.bulkCreate([{id_tratamiento:1,nombre:'Tratamiento ficticio',disciplina:'estetica',origen:'sistema',activo:true},
  {id_tratamiento:2,nombre:'Ajeno',disciplina:'general',origen:'clinica',clinica_id:73,activo:true},
  {id_tratamiento:3,nombre:'Inactivo',disciplina:'estetica',origen:'sistema',activo:false},
  {id_tratamiento:4,nombre:'Oculto',disciplina:'estetica',origen:'sistema',activo:true,eliminado_por_clinica:[72]},
  {id_tratamiento:5,nombre:'Tratamiento de grupo',disciplina:'capilar',origen:'grupo',grupo_clinica_id:5,activo:true},
  {id_tratamiento:6,nombre:'Otra consulta',disciplina:'capilar',origen:'sistema',activo:true}]);
 const retained=await db.AppointmentClinicalReport.create({public_id:'historical-final',clinic_id:72,patient_id:11,status:'final',version_number:1,summary:'Texto histórico exacto'});
 await db.AppointmentClinicalReportRevision.create({report_id:retained.id,version_number:1,status:'final',snapshot:{summary:'Snapshot anterior exacto'},change_type:'created',actor_id:7});
 const old=(await db.AppointmentClinicalReport.findByPk(retained.id)).toJSON();delete old.template_default_origin;
 await sql.getQueryInterface().removeColumn('AppointmentClinicalReports','template_default_origin');
 await require('../../../migrations/20261021090000-clinical-episode-templates').up(sql.getQueryInterface(),S);
 for(const file of ['clinicalepisodetemplate','clinicalepisodetemplateversion']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 const migration=require('../../../migrations/20261025170000-clinical-treatment-template-defaults');
 await migration.up(sql.getQueryInterface(),S);await migration.up(sql.getQueryInterface(),S);
 for(const file of ['clinicaltreatmenttemplatedefault','clinicaltreatmenttemplatedefaultrevision']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 const reread=(await db.AppointmentClinicalReport.findByPk(retained.id)).toJSON();assert.equal(reread.template_default_origin,null);delete reread.template_default_origin;assert.deepEqual(reread,old);
 assert.deepEqual((await db.AppointmentClinicalReportRevision.findOne({where:{report_id:retained.id}})).snapshot,{summary:'Snapshot anterior exacto'});
 await assert.rejects(migration.down(),/history_preserved/);
 assert((await sql.getQueryInterface().showIndex('ClinicalTreatmentTemplateDefaults')).some(row=>row.name==='clinical_treatment_template_default_scope'&&row.unique));
 assert((await sql.getQueryInterface().getForeignKeyReferencesForTable('ClinicalTreatmentTemplateDefaults')).some(row=>row.referencedTableName==='Tratamientos'));
 report.checks.push('Actual selected additive DDL runs twice, adds two audited tables/real unique and FK constraints and nullable report origin; historical final row/revision remain exact and rollback refuses.');
 const canAccess=async({actorId,clinicId,featureKey})=>clinicId===72&&(actorId===7||actorId===8&&!['clinic.settings.edit','clinical.reports.manage'].includes(featureKey));
 const defaults=require('../../services/clinicalTemplateDefaults.service').createService({db,canAccess});
 const templates=require('../../services/clinicalEpisodeTemplates.service').createClinicalEpisodeTemplateService({db});
 const episodes=require('../../services/clinicalEpisodes.service').createClinicalEpisodeService({db,canAccess,now:()=>new Date('2026-10-25T12:00:00Z')});
 const scope={actorId:7,clinicId:72},custom='custom_'+crypto.randomUUID();
 const definition={...T.builtin('estetica'),title:'Primera valoración ficticia',expected_version:0,idempotency_key:'owned-initial-template',
  form_schema:{version:1,key:'first_visit',title:'Valoración',kind:'standard',sections:[{id:'clinical',title:'Valoración',fields:[{id:'detail',label:'Detalle',type:'text',required:false}]}]}};
 definition.fields.push({key:custom,label:'Exploración propia',visible:true});definition.rich_document.sections[custom]=C.plainDocument('Texto inicial propio');definition.rich_document.sections.summary=C.plainDocument('Texto inicial genérico');
 const template=(await templates.create({...scope,payload:definition})).item,ref={id:template.id,version:1};
 const foreign=(await templates.create({clinicId:73,actorId:7,payload:{...T.builtin('general'),expected_version:0,idempotency_key:'foreign-initial-template'}})).item;
 const command={expected_version:0,idempotency_key:'owned-default-command',enabled:true,template_ref:ref};
 const pair=await Promise.all([defaults.save({...scope,treatmentId:1,payload:command}),defaults.save({...scope,treatmentId:1,payload:command})]);
 assert.equal(pair.filter(row=>row.replayed).length,1);assert.equal(await db.ClinicalTreatmentTemplateDefault.count(),1);assert.equal(await db.ClinicalTreatmentTemplateDefaultRevision.count(),1);
 const preference=pair[0].item;
 await assert.rejects(defaults.save({...scope,treatmentId:6,payload:command}),{code:'clinical_template_default_request_conflict'});
 await assert.rejects(defaults.save({...scope,treatmentId:6,payload:{...command,idempotency_key:'foreign-ref-command',template_ref:{id:foreign.id,version:1}}}),{code:'clinical_template_not_found'});
 for(const id of [2,3,4])await assert.rejects(defaults.save({...scope,treatmentId:id,payload:{...command,idempotency_key:'bad-treatment-'+id}}));
 await assert.rejects(defaults.save({...scope,actorId:8,treatmentId:1,payload:command}),{code:'access_policy_forbidden'});
 const rev=(await db.ClinicalTreatmentTemplateDefaultRevision.findOne());await assert.rejects(rev.update({snapshot:{changed:true}}),/immutable/);
 const race=await Promise.allSettled([1,2].map(n=>defaults.save({...scope,treatmentId:1,payload:{...command,expected_version:1,idempotency_key:'owned-default-race-'+n}})));
 assert.equal(race.filter(row=>row.status==='fulfilled').length,1);assert.equal(race.find(row=>row.status==='rejected').reason.details.applied,false);
 assert.equal((await defaults.save({...scope,treatmentId:1,payload:command})).item.version,1);
 await defaults.save({...scope,treatmentId:5,payload:{...command,idempotency_key:'owned-group-default'}});
 const opts=await defaults.treatments({...scope,actorId:8,query:{limit:1}});assert.equal(opts.items[0].id,1);assert.equal(opts.items[0].current_default.version,2);assert(opts.next_cursor);
 await assert.rejects(defaults.treatments({...scope,query:{q:'Otra',cursor:opts.next_cursor}}),{code:'clinical_template_default_cursor'});
 const listed=await defaults.list({...scope,actorId:8,query:{template_id:template.id,limit:1}});assert.equal(listed.items.length,1);assert(listed.next_cursor);
 const laterTemplate=await templates.save({...scope,id:template.id,payload:{...definition,expected_version:1,title:'Versión posterior no adoptada'}});assert.equal(laterTemplate.item.version,2);
 report.checks.push('Configuration uses clinic/catalog scope and clinical-view + clinic-settings-edit, with no agenda permission. Same command races replay one revision; stale CAS/changed command/foreign or hidden/inactive targets reject. Pinned versions and immutable old preference receipts remain exact. Scoped pagination includes group catalog.');
 const counts=async()=>({heads:await db.ClinicalTreatmentTemplateDefault.count(),revisions:await db.ClinicalTreatmentTemplateDefaultRevision.count(),reports:await db.AppointmentClinicalReport.count(),clinicalRevisions:await db.AppointmentClinicalReportRevision.count()});
 const beforePreview=await counts(),preview=await defaults.resolve({...scope,actorId:8,patientIdentifier:12,payload:{treatment_id:1}});assert.equal(preview.item.scope,'treatment');assert.deepEqual(await counts(),beforePreview);
 await assert.rejects(defaults.resolve({...scope,patientIdentifier:22,payload:{treatment_id:1}}),{code:'clinical_episode_patient_not_found'});
 let seq=0;const create=(patientId,payload)=>episodes.create({...scope,patientIdentifier:patientId,payload:{expected_version:0,idempotency_key:'owned-initial-episode-'+(++seq),...payload}});
 const firstPayload={expected_version:0,idempotency_key:'first-context-exact',use_template_default:true,treatment_id:1,template_ref:ref,summary:''};
 const first=(await episodes.create({...scope,patientIdentifier:12,payload:firstPayload})).item;
 assert.equal(first.summary,null);assert.equal(C.documentText(first.rich_document.sections[custom]),'Texto inicial propio');assert.equal(first.rich_document.labels[custom],'Exploración propia');
 assert.equal(first.template_snapshot.sha256,template.sha256);assert.equal(first.template_default_origin.preference_id,preference.id);assert.equal(first.template_default_origin.preference_version,2);
 assert.equal(first.form_data.instances.length,1);assert.equal(first.form_data.instances[0].template_ref.id,template.id);assert.equal(first.form_data.instances[0].context_snapshot['patient.full_name'],'Paciente Ficticio');
 const firstRevision=(await episodes.revisions({id:first.id,clinicId:72})).items[0].snapshot;assert.deepEqual(firstRevision.template_default_origin,first.template_default_origin);
 assert.equal((await defaults.resolve({...scope,patientIdentifier:12,payload:{treatment_id:1}})).reason,'not_first');
 await assert.rejects(create(12,{use_template_default:true,treatment_id:1,template_ref:ref}),{code:'clinical_template_default_not_first'});
 const second=(await create(12,{use_template_default:true,treatment_id:1})).item;assert.equal(second.template_snapshot,null);assert.equal(second.template_default_origin,null);
 const manual=(await create(13,{use_template_default:false,treatment_id:1,template_ref:{id:'builtin:general',version:1},summary:'Elección manual'})).item;
 assert.equal(manual.template_snapshot.id,'builtin:general');assert.equal(manual.summary,'Elección manual');assert.equal(manual.template_default_origin,null);assert.equal(manual.form_data,null);
 const explicitRich=(await create(14,{use_template_default:true,treatment_id:1,rich_document:{version:1,sections:{[custom]:{ops:[{insert:'Texto propio del profesional',attributes:{bold:true}},{insert:'\n'}]},plan:C.plainDocument('')}}})).item;
 assert.equal(C.documentText(explicitRich.rich_document.sections[custom]),'Texto propio del profesional');assert.equal(explicitRich.rich_document.sections[custom].ops[0].attributes.bold,true);assert.equal(explicitRich.plan,null);
 report.checks.push('Read-only patient preview requires clinical view and sensitive patient scope, with no writes. First creation pins template/ref/hash and preference origin, fills only absent texts, retains explicit empty text and creates its integrated empty form. Second context creation never auto-applies; manual override remains authoritative.');
 const vouchers=await db.PatientVoucher.bulkCreate([1,2].map(id=>({id,public_id:'owned-initial-voucher-'+id,clinic_id:72,patient_id:11,treatment_id:1,name:'Bono ficticio '+id,total_units:3,available_units:3,sold_amount:300,status:'active'})));
 for(const row of vouchers){const origin={kind:'voucher',id:row.public_id},p=await defaults.resolve({...scope,patientIdentifier:11,payload:{service_ref:origin}});assert.equal(p.item.scope,'service');const item=(await create(11,{use_template_default:true,service_ref:origin,template_ref:ref})).item;assert.deepEqual(item.template_default_origin.service_ref,origin);}
 assert.equal((await defaults.resolve({...scope,patientIdentifier:11,payload:{service_ref:{kind:'voucher',id:vouchers[0].public_id}}})).reason,'not_first');
 await db.CitaPaciente.bulkCreate([101,102].map((id,i)=>({id_cita:id,paciente_id:11,clinica_id:72,tratamiento_id:1,voucher_id:i+1,doctor_id:7,inicio:'2026-10-20T10:00:00Z',fin:'2026-10-20T10:30:00Z',estado:'pendiente'})));
 const ambiguous=await defaults.resolve({...scope,patientIdentifier:11,payload:{appointment_ids:[101,102]}});assert.equal(ambiguous.item,null);assert.equal(ambiguous.reason,'ambiguous_context');
 const ambiguousEpisode=(await create(11,{use_template_default:true,appointment_ids:[101,102],summary:'Visita con varios servicios'})).item;assert.equal(ambiguousEpisode.template_default_origin,null);assert.equal(ambiguousEpisode.service_ref,null);assert.deepEqual(ambiguousEpisode.appointment_ids,[101,102]);
 await db.PatientVoucher.bulkCreate([3,4].map((id,i)=>({id,public_id:'explicit-initial-voucher-'+id,clinic_id:72,patient_id:18,treatment_id:i?6:1,name:'Servicio explícito '+id,total_units:3,available_units:3,sold_amount:300,status:'active'})));
 await db.CitaPaciente.bulkCreate([103,104].map((id,i)=>({id_cita:id,paciente_id:18,clinica_id:72,tratamiento_id:i?6:1,voucher_id:i+3,doctor_id:7,inicio:'2026-10-20T10:00:00Z',fin:'2026-10-20T10:30:00Z',estado:'pendiente'})));
 assert.equal((await defaults.resolve({...scope,patientIdentifier:18,payload:{appointment_ids:[103,104]}})).reason,'ambiguous_context');
 const explicit=await defaults.resolve({...scope,patientIdentifier:18,payload:{appointment_ids:[103,104],service_ref:{kind:'voucher',id:'explicit-initial-voucher-3'}}});assert.equal(explicit.item.treatment_id,1);assert.equal(explicit.item.scope,'service');
 report.checks.push('Canonical voucher identities permit a separate initial episode per purchased service without confusing prior visits for another service; multi-service appointment visits never guess a treatment fallback, and all real links remain documented.');
 const concurrency=await Promise.all([create(16,{use_template_default:true,treatment_id:1}),create(16,{use_template_default:true,treatment_id:1})]);assert.equal(concurrency.filter(row=>row.item.template_default_origin).length,1);
 const previewRace=await Promise.allSettled([create(15,{use_template_default:true,treatment_id:1,template_ref:ref}),create(15,{use_template_default:true,treatment_id:1,template_ref:ref})]);
 assert.equal(previewRace.filter(row=>row.status==='fulfilled').length,1);assert.equal(previewRace.find(row=>row.status==='rejected').reason.code,'clinical_template_default_not_first');
 const exact={expected_version:0,idempotency_key:'owned-exact-first-concurrent',use_template_default:true,treatment_id:1,template_ref:ref};
 const exactRows=await Promise.all([episodes.create({...scope,patientIdentifier:17,payload:exact}),episodes.create({...scope,patientIdentifier:17,payload:exact})]);assert.equal(exactRows.filter(row=>row.replayed).length,1);assert.equal(exactRows[0].item.id,exactRows[1].item.id);assert.deepEqual(exactRows[0].item.form_data,exactRows[1].item.form_data);
 const oldPreview=await defaults.resolve({...scope,patientIdentifier:18,payload:{treatment_id:1}});
 const changed=await defaults.save({...scope,treatmentId:1,payload:{expected_version:2,idempotency_key:'owned-initial-change',enabled:true,template_ref:{id:'builtin:general',version:1}}});assert.equal(changed.item.version,3);
 const changedPayload={expected_version:0,idempotency_key:'owned-preview-mismatch-retry',use_template_default:true,treatment_id:1,template_ref:oldPreview.item.template_ref};
 await assert.rejects(episodes.create({...scope,patientIdentifier:18,payload:changedPayload}),{code:'clinical_template_default_changed'});
 const beforeFailure=await counts();db.ClinicalTreatmentTemplateDefaultRevision.addHook('beforeCreate','fail-pref-audit',()=>{throw Error('OWNED_PREF_AUDIT_FAILURE');});
 try{await assert.rejects(defaults.save({...scope,treatmentId:1,payload:{expected_version:3,idempotency_key:'owned-failed-pref-audit',enabled:true,template_ref:ref}}),/OWNED_PREF/);}finally{db.ClinicalTreatmentTemplateDefaultRevision.removeHook('beforeCreate','fail-pref-audit');}
 assert.deepEqual(await counts(),beforeFailure);assert.equal((await defaults.list({...scope,query:{}})).items.find(row=>row.treatment_id===1).version,3);
 await defaults.save({...scope,treatmentId:1,payload:{expected_version:3,idempotency_key:'owned-failed-pref-audit',enabled:true,template_ref:ref}});
 assert.equal((await episodes.create({...scope,patientIdentifier:18,payload:changedPayload})).created,true);
 assert.equal((await episodes.create({...scope,patientIdentifier:18,payload:changedPayload})).replayed,true);
 const beforeClinicalFailure=await counts();db.AppointmentClinicalReportRevision.addHook('beforeCreate','fail-initial-audit',()=>{throw Error('OWNED_CLINICAL_AUDIT_FAILURE');});
 try{await assert.rejects(create(19,{use_template_default:true,treatment_id:1,template_ref:ref}),/OWNED_CLINICAL/);}finally{db.AppointmentClinicalReportRevision.removeHook('beforeCreate','fail-initial-audit');}
 assert.deepEqual(await counts(),beforeClinicalFailure);
 report.checks.push('Patient mutex serializes simultaneous first creations: exactly one default, and identical command replays one episode/form identity. Changed preview is definitively rejected. Preference and episode audit failures roll back head/origin/form atomically.');
 await templates.archive({...scope,id:template.id,payload:{expected_version:2,acknowledged:true}});
 assert.equal((await defaults.resolve({...scope,patientIdentifier:20,payload:{treatment_id:1}})).reason,'template_archived');
 assert.equal((await defaults.list({...scope,query:{template_id:template.id}})).items.find(row=>row.treatment_id===1).available,false);
 const archivedFallback=(await create(20,{use_template_default:true,treatment_id:1})).item;assert.equal(archivedFallback.template_default_origin,null);assert.equal(archivedFallback.template_snapshot,null);
 const replayAfterArchive=await episodes.create({...scope,patientIdentifier:12,payload:firstPayload});assert.equal(replayAfterArchive.replayed,true);assert.equal(replayAfterArchive.item.template_snapshot.sha256,template.sha256);
 const disabled=await defaults.save({...scope,treatmentId:1,payload:{expected_version:4,idempotency_key:'owned-disable-archived',enabled:false,template_ref:ref}});assert.equal(disabled.item.version,5);assert.equal(disabled.item.enabled,false);
 const continued=(await episodes.save({...scope,id:first.id,payload:{expected_version:1,summary:'Seguimiento conservado'}})).item;assert.equal(continued.template_snapshot.sha256,template.sha256);assert.deepEqual(continued.template_default_origin,first.template_default_origin);
 assert.equal((await episodes.revisions({id:first.id,clinicId:72})).items.find(row=>row.version===1).snapshot.template_snapshot.sha256,template.sha256);
 report.checks.push('Archived/disabled defaults cease new automatic adoption but never block a manual consultation; disabling an archived reference is allowed. Exact episode replay happens before changing preferences, and existing episode text/template/form/original origin and immutable history remain usable.');
 const controller=require('../../controllers/clinicalTemplateDefaults.controller').createController({service:defaults});
 const router=load(require.resolve('../../routes/clinicalTemplateDefaults.routes'),{'../controllers/clinicalTemplateDefaults.controller':controller,'./auth.middleware':(req,_res,next)=>{const actor=Number(req.headers['x-owned-actor']);req.userData=actor?{userId:actor}:null;next();}});
 const express=require('express'),app=express();app.use(express.json());app.use('/api/clinical-episode-template-defaults',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));registerOwnedLoopbackServer(server);
 async function http(path,method='GET',body,actor=7){return new Promise((resolve,reject)=>{const req=require('node:http').request({host:'127.0.0.1',port:server.address().port,path:'/api/clinical-episode-template-defaults'+path,method,headers:{'Content-Type':'application/json','x-owned-actor':String(actor)}},res=>{let out='';res.setEncoding('utf8');res.on('data',chunk=>out+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(out),cache:res.headers['cache-control']}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
 try{const before=await counts();assert.equal((await http('/?clinic_id=72','GET',undefined,0)).status,401);assert.equal((await http('/?clinic_id=73')).status,403);
  const read=await http('/treatments?clinic_id=72','GET',undefined,8);assert.equal(read.status,200);assert.equal(read.cache,'private, no-store');assert.equal(read.body.items.some(row=>row.id===2),false);
  assert.equal((await http('/treatments/1?clinic_id=72','PUT',{expected_version:5,idempotency_key:'http-denied-default',enabled:false},8)).status,403);
  const previewHttp=await http('/patients/21/resolve?clinic_id=72','POST',{treatment_id:1},8);assert.equal(previewHttp.status,200);assert.equal(previewHttp.body.reason,'disabled');
  assert.equal((await http('/patients/22/resolve?clinic_id=72','POST',{treatment_id:1},8)).status,404);assert.deepEqual(await counts(),before);
 }finally{await new Promise(resolve=>server.close(resolve));}
 report.checks.push('Actual HTTP router/controller/service rejects unauthenticated, foreign clinic/patient and missing settings-write permission; clinical-view-only staff can preview/browse with private no-store, no agenda grant and no writes.');
 report.boundary='Owned socket-only MySQL8, real selected additive DDL/models/services/HTTP; synthetic ACL and authentication only. No runtime DB, provider, financial writes, appointment state transition, notification or flags.';
}).catch(error=>{console.error(error);process.exitCode=1;});
