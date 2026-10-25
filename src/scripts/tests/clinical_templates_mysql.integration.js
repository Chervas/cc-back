'use strict';
const assert = require('node:assert/strict'), { DataTypes: D, Sequelize } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const C = require('../../lib/clinical-episode-contract'), T = require('../../lib/clinical-template-contract');
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, configuracion: D.JSON }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, clinica_id: D.INTEGER,
    nombre: D.STRING, alergias: D.TEXT, medicacion: D.TEXT, antecedentes: D.TEXT, notas_medicas: D.TEXT, peso: D.DECIMAL(10,2) }, { tableName: 'Pacientes', timestamps: false });
  db.PacienteClinica = sql.define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, { timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER, inicio: D.DATE, fin: D.DATE,
    titulo: D.STRING, estado: D.STRING, doctor_id: D.INTEGER, tratamiento_id: D.INTEGER, care_started_at: D.DATE, care_schedule_start: D.DATE }, { tableName: 'CitasPacientes', timestamps: false });
  db.Usuario = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING, estado_cuenta: D.STRING }, { timestamps: false });
  db.UsuarioClinica = sql.define('UsuarioClinica', { id_usuario: { type: D.INTEGER, primaryKey: true }, id_clinica: { type: D.INTEGER, primaryKey: true }, rol_clinica: D.STRING,
    subrol_clinica: D.STRING, estado_invitacion: D.STRING }, { timestamps: false });
  db.DoctorClinica = sql.define('DoctorClinica', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true }, doctor_id: D.INTEGER, clinica_id: D.INTEGER, activo: D.BOOLEAN, recibe_citas: D.BOOLEAN }, { timestamps: false });
  for (const file of ['appointmentclinicalreport','appointmentclinicalreportrevision','clinicalepisodeappointment']) { const model = require('../../../models/'+file)(sql,D); db[model.name] = model; }
  await sql.sync(); await db.Clinica.bulkCreate([{id_clinica:72},{id_clinica:73}]);
  await db.Paciente.create({ id_paciente:11,public_id:'synthetic-patient',clinica_id:72,nombre:'Ficticio',alergias:null,medicacion:'Original',antecedentes:'Conservar',notas_medicas:null,peso:82.5 });
  const old = await db.AppointmentClinicalReport.create({ public_id:'retained-report',clinic_id:72,patient_id:11,status:'final',version_number:1,title:'Histórico',summary:'Texto histórico exacto',private_notes:'Privado conservado',template_key:'general',created_by:7,updated_by:7 });
  const historical = { public_id:'retained-report',version:1,summary:'Texto histórico exacto' };
  await db.AppointmentClinicalReportRevision.create({ report_id:old.id,version_number:1,status:'final',snapshot:historical,change_type:'created',actor_id:7 });
  const retainedBefore = (await db.AppointmentClinicalReport.findByPk(old.id)).toJSON(); delete retainedBefore.template_snapshot;
  await sql.getQueryInterface().removeColumn('AppointmentClinicalReports','template_snapshot');
  const migration = require('../../../migrations/20261021090000-clinical-episode-templates'); await migration.up(sql.getQueryInterface(),Sequelize); await migration.up(sql.getQueryInterface(),Sequelize);
  for (const file of ['clinicalepisodetemplate','clinicalepisodetemplateversion']) { const model = require('../../../models/'+file)(sql,D); db[model.name] = model; }
  const retainedAfter = (await db.AppointmentClinicalReport.findByPk(old.id)).toJSON(); assert.equal(retainedAfter.template_snapshot,null); delete retainedAfter.template_snapshot; assert.deepEqual(retainedAfter,retainedBefore);
  assert.deepEqual((await db.AppointmentClinicalReportRevision.findOne({where:{report_id:old.id}})).snapshot,historical);
  await assert.rejects(migration.down(),/history_preserved/);
  assert((await sql.getQueryInterface().showIndex('ClinicalEpisodeTemplateVersions')).some(index=>index.name==='clinical_template_revision_once'&&index.unique));
  const refs=await sql.getQueryInterface().getForeignKeyReferencesForTable('ClinicalEpisodeTemplateVersions');assert(refs.some(ref=>ref.referencedTableName==='ClinicalEpisodeTemplates'));
  report.checks.push('Actual additive migration twice in owned MySQL preserves retained clinical row/revision exactly, adds nullable snapshot and real unique/FK constraints; destructive down refuses. No runtime schema touched.');
  const templates = require('../../services/clinicalEpisodeTemplates.service').createClinicalEpisodeTemplateService({db});
  const payload = {...T.builtin('estetica'),expected_version:0,idempotency_key:'owned-template-request',title:'Texto genérico de prueba'};
  const concurrent = await Promise.all([templates.create({clinicId:72,actorId:7,payload}),templates.create({clinicId:72,actorId:7,payload})]);
  assert.equal(concurrent.filter(item=>item.created).length,1); assert.equal(await db.ClinicalEpisodeTemplate.count(),1); assert.equal(await db.ClinicalEpisodeTemplateVersion.count(),1);
  const v1=concurrent[0].item, originalSnapshot=JSON.stringify((await db.ClinicalEpisodeTemplateVersion.findOne()).snapshot);
  const race=await Promise.allSettled(['Versión A','Versión B'].map(title=>templates.save({id:v1.id,clinicId:72,actorId:7,payload:{...payload,title,expected_version:1}})));
  assert.equal(race.filter(item=>item.status==='fulfilled').length,1); assert.equal(race.find(item=>item.status==='rejected').reason.code,'clinical_template_version_conflict');
  assert.equal(await db.ClinicalEpisodeTemplateVersion.count(),2);assert.equal(JSON.stringify((await db.ClinicalEpisodeTemplateVersion.findOne({where:{version_number:1}})).snapshot),originalSnapshot);
  await assert.rejects(templates.get({id:v1.id,clinicId:73}),{code:'clinical_template_not_found'});assert((await templates.list({clinicId:73})).items.every(item=>item.builtin));
  const immutable=await db.ClinicalEpisodeTemplateVersion.findOne();await assert.rejects(immutable.update({snapshot:{changed:true}}),/immutable/);
  report.checks.push('Native template create replay makes one identity/revision; concurrent edits produce one v2 and one CAS409, v1 remains immutable; foreign clinic cannot read/select custom template.');
  const episodes = require('../../services/clinicalEpisodes.service').createClinicalEpisodeService({db, now: () => new Date('2026-10-25T12:00:00Z')});
  const texts=Object.fromEntries(C.TEXT_FIELDS.map(field=>[field,'Contenido '+field]));
  const rich={version:1,sections:Object.fromEntries(C.TEXT_FIELDS.map(field=>[field,{ops:[{insert:texts[field],attributes:{bold:true}},{insert:'\n'}]}]))};
  const created=await episodes.create({patientIdentifier:'synthetic-patient',clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'owned-episode-request',title:'Consulta de prueba',template_key:'estetica',occurred_at:'2026-10-21T10:00:00Z',template_ref:{id:v1.id,version:1},...texts,rich_document:rich}});
  assert.equal(created.item.template_snapshot.version,1);assert.equal(created.item.template_snapshot.sha256,v1.sha256);
  const saved=await episodes.save({id:created.item.id,clinicId:72,actorId:7,payload:{expected_version:1,plan:'Plan revisado'}});
  for(const field of C.TEXT_FIELDS.filter(field=>field!=='plan')){assert.equal(saved.item[field],texts[field]);assert.equal(saved.item.rich_document.sections[field].ops[0].attributes.bold,true);}
  assert.equal(saved.item.template_snapshot.version,1);
  const closed=await episodes.save({id:created.item.id,clinicId:72,actorId:7,mode:'finalize',payload:{expected_version:2}});assert.equal(closed.item.template_snapshot.version,1);
  await assert.rejects(episodes.save({id:created.item.id,clinicId:72,actorId:7,payload:{expected_version:3,template_ref:{id:v1.id,version:2}}}),{code:'clinical_report_final'});
  const oldRevision=await db.AppointmentClinicalReportRevision.findOne({where:{report_id:created.item.id===undefined?-1:(await db.AppointmentClinicalReport.findOne({where:{public_id:created.item.id}})).id,version_number:3}});assert.equal(oldRevision.snapshot.template_snapshot.version,1);
  assert.equal((await templates.get({id:v1.id,clinicId:72})).item.version,2);
  await assert.rejects(episodes.create({patientIdentifier:'synthetic-patient',clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'foreign-template-request',title:'No',occurred_at:'2026-10-21T10:00:00Z',template_ref:{id:v1.id,version:99}}}),{code:'clinical_template_version_not_found'});
  report.checks.push('Episode selection pins exact server template snapshot/hash; custom template v2 never upgrades existing episode. Partial edits/finalization preserve all eight text fields, rich Delta and immutable v1 clinical snapshot; final edits and nonexistent versions reject without ghost records.');
  const reference = require('../../services/patientClinicalReference.service').createPatientClinicalReferenceService({db,canAccess:async()=>true});
  const scope={patientIdentifier:'synthetic-patient',clinicId:72,actorId:7};
  const updates=await Promise.allSettled(['Alergia A','Alergia B'].map(alergias=>reference.update({...scope,payload:{changes:{alergias},expected_values:{alergias:null}}})));
  assert.equal(updates.filter(item=>item.status==='fulfilled').length,1);assert.equal(updates.find(item=>item.status==='rejected').reason.code,'clinical_reference_conflict');
  await assert.rejects(reference.update({...scope,payload:{changes:{alergias:'No',medicacion:'No'},expected_values:{alergias:null,medicacion:'Original'}}}),{code:'clinical_reference_conflict'});
  const patient=await db.Paciente.findByPk(11);assert.equal(patient.medicacion,'Original');assert.equal(patient.antecedentes,'Conservar');assert.equal(Number(patient.peso),82.5);assert.equal(patient.nombre,'Ficticio');
  assert.equal((await reference.read(scope)).item.alergias,patient.alergias);
  const final=(await episodes.get({id:created.item.id,clinicId:72})).item;assert.equal(final.status,'final');assert.equal(final.summary,texts.summary);
  report.checks.push('Reference clinical edits use native per-field CAS under patient lock: concurrent updates one winner/409, stale multi-field patch rolls back, patient metrics/name/other clinical fields and final narrative remain unchanged. No narrative extraction or automatic diagnoses.');

  const customKey='custom_384e46ed-d86e-4447-836e-346d27a67982';
  const customDefinition={...T.builtin('estetica'),title:'Consulta con exploración',expected_version:0,idempotency_key:'owned-unified-custom-template'};
  customDefinition.fields.reverse();customDefinition.fields.splice(2,0,{key:customKey,label:'Exploración específica',visible:true});
  customDefinition.rich_document.sections[customKey]=C.plainDocument('Texto de partida');
  const custom=(await templates.create({clinicId:72,actorId:7,payload:customDefinition})).item;
  assert.deepEqual(custom.fields.map(field=>field.key),customDefinition.fields.map(field=>field.key));
  const customEpisode=(await episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'owned-unified-custom-episode',
    title:'Consulta con apartado propio',occurred_at:'2026-10-21T10:00:00Z',template_ref:{id:custom.id,version:1},
    rich_document:{version:1,sections:{[customKey]:C.plainDocument('Exploración del episodio')}}}})).item;
  assert.equal(customEpisode.rich_document.labels[customKey],'Exploración específica');assert.equal(customEpisode[customKey],undefined);
  const switched=(await episodes.save({id:customEpisode.id,clinicId:72,actorId:7,payload:{expected_version:1,template_ref:{id:'builtin:general',version:1},summary:'',
    rich_document:{version:1,sections:{summary:C.plainDocument('')}}}})).item;
  assert.equal(switched.rich_document.labels[customKey],'Exploración específica');assert.equal(C.documentText(switched.rich_document.sections[customKey]),'Exploración del episodio');
  assert.equal(switched.template_snapshot.id,'builtin:general');
  await assert.rejects(episodes.save({id:customEpisode.id,clinicId:72,actorId:7,payload:{expected_version:1,rich_document:{version:1,sections:{[customKey]:C.plainDocument('Texto obsoleto')}}}}),{code:'clinical_report_version_conflict'});
  await assert.rejects(episodes.save({id:customEpisode.id,clinicId:72,actorId:7,payload:{expected_version:2,rich_document:{version:1,sections:{['custom_'+require('node:crypto').randomUUID()]:C.plainDocument('No definido')}}}}),{code:'clinical_episode_invalid_document'});
  const closedCustom=(await episodes.save({id:customEpisode.id,clinicId:72,actorId:7,mode:'finalize',payload:{expected_version:2}})).item;
  assert.equal(closedCustom.status,'final');assert.equal(C.documentText(closedCustom.rich_document.sections[customKey]),'Exploración del episodio');
  const clinicalRevisions=await episodes.revisions({id:customEpisode.id,clinicId:72});
  assert.equal(clinicalRevisions.items.find(item=>item.version===1).snapshot.template_snapshot.id,custom.id);
  assert.equal(clinicalRevisions.items.find(item=>item.version===3).snapshot.rich_document.labels[customKey],'Exploración específica');
  report.checks.push('Unified narrative blocks persist stable UUID/order/labels in existing JSON; custom-only content can finalize, template changes preserve unmatched text and labels, unknown custom IDs and stale writes reject, immutable original snapshots remain pinned.');

  const activeUsingCustom=(await episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'owned-unified-archive-existing-episode',title:'Conservar episodio',
    occurred_at:'2026-10-21T12:00:00Z',template_ref:{id:custom.id,version:1},summary:'Texto guardado'}})).item;
  const archiveRace=await Promise.allSettled([templates.archive({id:custom.id,clinicId:72,actorId:7,payload:{expected_version:1,acknowledged:true}}),
    templates.save({id:custom.id,clinicId:72,actorId:7,payload:{...customDefinition,expected_version:1,title:'Edición competidora'}})]);
  assert.equal(archiveRace.filter(item=>item.status==='fulfilled').length,1);assert.equal(archiveRace.find(item=>item.status==='rejected').reason.code,'clinical_template_version_conflict');
  let latest=(await templates.get({id:custom.id,clinicId:72})).item;
  if(!latest.archived)latest=(await templates.archive({id:custom.id,clinicId:72,actorId:7,payload:{expected_version:latest.version,acknowledged:true}})).item;
  assert.equal(latest.archived,true);assert(!(await templates.list({clinicId:72,query:{limit:1}})).items.some(item=>item.id===custom.id));
  assert.equal((await templates.get({id:custom.id,clinicId:72,version:1})).item.sha256,custom.sha256);
  await assert.rejects(templates.resolveReference({id:custom.id,version:1},72),{code:'clinical_template_archived'});
  await assert.rejects(templates.archive({id:custom.id,clinicId:73,actorId:7,payload:{expected_version:latest.version,acknowledged:true}}),{code:'clinical_template_not_found'});
  await assert.rejects(templates.archive({id:'builtin:general',clinicId:72,actorId:7,payload:{expected_version:1,acknowledged:true}}),{code:'clinical_template_system_immutable'});
  await assert.rejects(templates.save({id:custom.id,clinicId:72,actorId:7,payload:{...customDefinition,expected_version:latest.version}}),{code:'clinical_template_archived'});
  const continued=(await episodes.save({id:activeUsingCustom.id,clinicId:72,actorId:7,payload:{expected_version:1,template_ref:{id:custom.id,version:1},plan:'Seguimiento conservado'}})).item;
  assert.equal(continued.template_snapshot.version,1);assert.equal(continued.plan,'Seguimiento conservado');
  const beforeRejectedCreate=await db.AppointmentClinicalReport.count();
  await assert.rejects(episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'owned-archived-new-episode',template_ref:{id:custom.id,version:1}}}),{code:'clinical_template_archived'});
  assert.equal(await db.AppointmentClinicalReport.count(),beforeRejectedCreate);
  const duplicate=(await templates.create({clinicId:72,actorId:7,payload:{...custom,expected_version:0,idempotency_key:'owned-archive-copy',title:'Copia nueva'}})).item;
  assert.notEqual(duplicate.id,custom.id);assert.equal(duplicate.archived,undefined);
  const repeatableRead=await sql.transaction();
  try{
    // Establish a consistent snapshot before the archive commits, exactly as
    // the episode idempotency lookup can do. The locking template read must
    // still observe the current archived head, not this earlier snapshot.
    await db.Paciente.findByPk(11,{transaction:repeatableRead});
    await templates.archive({id:duplicate.id,clinicId:72,actorId:7,payload:{expected_version:1,acknowledged:true}});
    await assert.rejects(templates.resolveReference({id:duplicate.id,version:1},72,repeatableRead),{code:'clinical_template_archived'});
  }finally{await repeatableRead.rollback();}
  report.checks.push('Archiving is a CAS version race, hides library entries before pagination, refuses system/foreign-clinic edits and new archived selections; immutable old versions and already using episodes remain readable/editable, and a new explicit copy has independent identity.');

  const integratedForm=(await templates.create({clinicId:72,actorId:7,payload:{...T.builtin('general'),expected_version:0,idempotency_key:'owned-integrated-form-template',title:'Informe y formulario',
    form_schema:{version:1,key:'follow_up',title:'Valoración de la consulta',kind:'standard',sections:[{id:'clinical',title:'Datos de la consulta',fields:[{id:'assessment',label:'Valoración',type:'text',required:false}]}]}}})).item;
  const instanceId=require('node:crypto').randomUUID(),formInstance=answers=>({id:instanceId,template_ref:{id:integratedForm.id,version:1},answers});
  let withForm=(await episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{expected_version:0,idempotency_key:'owned-integrated-form-episode',title:'Consulta integrada',occurred_at:'2026-10-21T12:00:00Z',
    template_ref:{id:integratedForm.id,version:1},form_data:{version:1,instances:[formInstance({assessment:'Valoración inicial'})]}}})).item;
  await templates.archive({id:integratedForm.id,clinicId:72,actorId:7,payload:{expected_version:1,acknowledged:true}});
  withForm=(await episodes.save({id:withForm.id,clinicId:72,actorId:7,payload:{expected_version:1,template_ref:{id:integratedForm.id,version:1},form_data:{version:1,instances:[formInstance({assessment:'Valoración actualizada'})]}}})).item;
  withForm=(await episodes.save({id:withForm.id,clinicId:72,actorId:7,mode:'finalize',payload:{expected_version:2}})).item;
  assert.equal(withForm.form_data.instances[0].answers.assessment,'Valoración actualizada');assert.equal(withForm.status,'final');
  report.checks.push('An existing unified template with a structured form can be archived without blocking saved patient answers, later corrections or finalization: its immutable definition snapshot remains authoritative.');

  await db.Usuario.bulkCreate([7,8,9,10,11,12,13,14].map(id=>({id_usuario:id,nombre:'Profesional '+id,estado_cuenta:id===11?'desactivado':'activo'})));
  await db.UsuarioClinica.bulkCreate([7,8,9,10,11,12,13,14].map(id=>({id_usuario:id,id_clinica:id===9?73:72,rol_clinica:id===13?'paciente':id===14?'agencia':'personaldeclinica',subrol_clinica:id===12?'Administrativos':'Doctores',estado_invitacion:id===10?'pendiente':id===14?null:'aceptada'})));
  await db.DoctorClinica.bulkCreate([7,8,9,10,11,12,13,14].map(id=>({doctor_id:id,clinica_id:id===9?73:72,activo:true,recibe_citas:id!==8})));
  const options=await episodes.professionals({id:activeUsingCustom.id,clinicId:72});assert.deepEqual(options.items.map(item=>item.id).sort((a,b)=>a-b),[7,8,14]);
  await assert.rejects(episodes.professionals({id:activeUsingCustom.id,clinicId:73}),{code:'clinical_episode_not_found'});
  await db.CitaPaciente.bulkCreate([{id_cita:81,paciente_id:11,clinica_id:72,doctor_id:7,titulo:'Cita futura',estado:'programada',inicio:'2027-12-12T09:00:00Z',fin:'2027-12-12T09:30:00Z'},
    {id_cita:82,paciente_id:11,clinica_id:72,doctor_id:7,titulo:'Cita futura legacy',estado:'programada',inicio:'2027-12-12T10:00:00Z',fin:'2027-12-12T10:30:00Z'}]);
  const futurePayload={expected_version:0,idempotency_key:'owned-future-confirmation',appointment_ids:[81],summary:'Borrador anticipado'};
  const beforeFuture=await db.AppointmentClinicalReport.count();
  for(const confirmation of [undefined,false,'true',1])await assert.rejects(episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{...futurePayload,future_appointment_confirmed:confirmation}}),{code:'clinical_episode_future_appointment_confirmation_required'});
  assert.equal(await db.AppointmentClinicalReport.count(),beforeFuture);
  const future=(await episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:{...futurePayload,future_appointment_confirmed:true}})).item;
  const replay=await episodes.create({patientIdentifier:11,clinicId:72,actorId:7,payload:futurePayload});assert.equal(replay.replayed,true);assert.equal(replay.item.id,future.id);
  const reassigned=(await episodes.save({id:future.id,clinicId:72,actorId:7,payload:{expected_version:1,professional_id:8}})).item;
  assert.equal(reassigned.professional_id,8);assert.equal(reassigned.professional_name,'Profesional 8');
  for(const invalid of [9,10,11,12,13])await assert.rejects(episodes.save({id:future.id,clinicId:72,actorId:7,payload:{expected_version:2,professional_id:invalid}}),{code:'clinical_episode_professional_invalid'});
  await assert.rejects(episodes.save({id:future.id,clinicId:72,actorId:7,payload:{expected_version:1,professional_id:7}}),{code:'clinical_report_version_conflict'});
  const unchangedAppointment=await db.CitaPaciente.findByPk(81);assert.equal(unchangedAppointment.doctor_id,7);assert.equal(unchangedAppointment.estado,'programada');assert.equal(unchangedAppointment.care_started_at,null);
  const proRevisions=(await episodes.revisions({id:future.id,clinicId:72})).items;assert.equal(proRevisions[0].snapshot.professional_id,8);assert.equal(proRevisions[0].actor_id,7);assert.equal(proRevisions[1].snapshot.professional_id,7);
  await db.Usuario.update({estado_cuenta:'desactivado'},{where:{id_usuario:8}});
  const preservedResponsible=(await episodes.save({id:future.id,clinicId:72,actorId:7,payload:{expected_version:2,professional_id:8,summary:'Nueva anotación con responsable histórico conservado'}})).item;
  assert.equal(preservedResponsible.professional_id,8);assert.equal(preservedResponsible.version,3);
  await assert.rejects(episodes.saveLegacy({appointmentId:82,actorId:7,payload:{expected_version:0,summary:'Borrador legacy'}}),{code:'clinical_episode_future_appointment_confirmation_required'});
  await episodes.saveLegacy({appointmentId:82,actorId:7,payload:{expected_version:0,summary:'Borrador legacy',future_appointment_confirmed:true}});
  await assert.rejects(episodes.saveLegacy({appointmentId:82,actorId:7,payload:{expected_version:1,summary:'No debe guardarse',
    rich_document:{version:1,sections:{[customKey]:C.plainDocument('Bloque inyectado por cliente antiguo')},labels:{[customKey]:'Etiqueta no autorizada'}}}}),{code:'clinical_episode_invalid_document'});
  assert.equal((await db.CitaPaciente.findByPk(82)).estado,'programada');
  report.checks.push('Future first-entry normal/legacy require literal explicit acknowledgement before writes, replayed successful creation needs no new acknowledgement, appointment attendance/care stay untouched; scoped active doctor options include non-agenda professionals, reject foreign/pending/inactive/non-doctors, reassignment uses episode CAS and immutable authorship without moving appointment doctor.');
}).catch(error=>{console.error(error);process.exitCode=1;});
