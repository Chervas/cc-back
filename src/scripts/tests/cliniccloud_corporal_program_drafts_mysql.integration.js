'use strict';
const assert=require('node:assert/strict'),Sequelize=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {fixture}=require('./fixtures/corporal_program_drafts.fixture');
const {prepare}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {createTreatmentProgramsService}=require('../../services/treatmentPrograms.service');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
 db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER},{timestamps:false});
 db.Tratamiento=sql.define('Tratamiento',{id_tratamiento:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,codigo:D.STRING,
  clinica_id:D.INTEGER,grupo_clinica_id:D.INTEGER,origen:D.STRING,activo:D.BOOLEAN,sesiones_defecto:D.INTEGER,
  duracion_min:D.INTEGER,clinical_config:D.JSON,eliminado_por_clinica:D.JSON},{timestamps:false});
 for(const file of ['treatmentprogram','treatmentprogramrevision']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 await sql.sync();await db.Clinica.bulkCreate([{id_clinica:72,grupoClinicaId:29},{id_clinica:66,grupoClinicaId:29}]);
 const f=fixture();await db.Tratamiento.bulkCreate(f.treatments);const pkg=prepare(f),service=createTreatmentProgramsService({db});
 const existing=await service.create({clinicId:72,actorId:7,payload:{name:'BS Tono',kind:'program',status:'draft',total_price:null,appointments:[]}});
 const before=hash(await db.Tratamiento.findAll({raw:true}));
 for(const p of pkg.programs){
  const args={clinicId:72,actorId:7,payload:p.payload};const preview=await service.preview(args);assert.equal(preview.item.purchase_enabled,false);
  const a=await service.create(args),b=await service.create(args);assert.equal(a.created,true);assert.equal(b.created,false);assert.equal(a.item.id,b.item.id);
  assert.equal(a.item.status,'draft');assert.equal(a.item.total_price,null);assert.equal(a.item.summary.ready_for_scheduling,false);
  assert.deepEqual(a.item.appointments.map(a=>a.treatment_ids),p.payload.appointments.map(a=>a.treatment_ids));
  assert.equal(a.item.appointments.length,p.payload.appointments.length);
  await assert.rejects(service.update({id:a.item.id,clinicId:72,actorId:7,payload:{expected_version:1,status:'active'}}),{code:'program_not_ready'});
  await assert.rejects(service.get({id:a.item.id,clinicId:66}),{code:'program_not_found'});
 }
 assert.equal(await db.TreatmentProgram.count(),12);assert.equal(await db.TreatmentProgramRevision.count(),12);
 assert.equal(hash(await db.Tratamiento.findAll({raw:true})),before);
 const original=await service.get({id:existing.item.id,clinicId:72});assert.equal(original.item.version,1);assert.equal(original.item.name,'BS Tono');
 const list=await service.list({clinicId:72});assert.equal(list.total,12);assert(list.items.every(i=>!i.purchase_enabled));
 report.checks.push('Eleven drafts / 92 visits, canonical revisions and replay; existing Tono and individual treatments unchanged.');
 report.checks.push('Incomplete activation and foreign clinic access rejected; real SQL, synthetic data, no application DB/provider sockets.');
}).catch(e=>{console.error(e);process.exitCode=1;});
