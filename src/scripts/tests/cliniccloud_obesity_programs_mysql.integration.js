'use strict';
const assert=require('node:assert/strict'),Sequelize=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {fixture}=require('./fixtures/obesity_programs.fixture');
const variants=require('../../lib/cliniccloud-import/obesity-program-variants');
const programs=require('../../lib/cliniccloud-import/obesity-program-drafts');
const {createTreatmentProgramsService}=require('../../services/treatmentPrograms.service');
const {hash}=require('../../lib/cliniccloud-import/adapter');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
 db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,equipment_booking_enabled:D.BOOLEAN},{timestamps:false});
 db.Instalacion=sql.define('Instalacion',{id:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,activo:D.BOOLEAN},{timestamps:false});
 db.DoctorClinica=sql.define('DoctorClinica',{id:{type:D.INTEGER,primaryKey:true},doctor_id:D.INTEGER,clinica_id:D.INTEGER,activo:D.BOOLEAN,recibe_citas:D.BOOLEAN},{timestamps:false});
 for(const file of ['tratamiento','treatmentprogram','treatmentprogramrevision','installationphysicalalias','bookingequipment','bookingequipmentclinic','bookingequipmentroompolicy']){
  const m=require('../../../models/'+file)(sql,D);db[m.name]=m;
 }
 db.Instalacion.belongsTo(db.Clinica,{foreignKey:'clinica_id',targetKey:'id_clinica',as:'clinica'});db.BookingEquipment.associate(db);
 await sql.sync();const f=fixture();
 await db.Clinica.bulkCreate([66,72].map(id_clinica=>({id_clinica,grupoClinicaId:29,equipment_booking_enabled:true})));
 await db.Instalacion.bulkCreate([...f.before.rooms,...[74,77,85].map(id=>({id,clinica_id:72,activo:true}))]);
 await db.DoctorClinica.bulkCreate([...f.before.staff,...[126,223].map(doctor_id=>({id:doctor_id,doctor_id,clinica_id:72,activo:true,recibe_citas:true}))]);
 await db.BookingEquipmentRoomPolicy.bulkCreate(f.before.policies);
 await db.BookingEquipment.bulkCreate(f.before.units.map(u=>({...u,name:'Equipo ficticio '+u.id})));
 await db.BookingEquipmentClinic.bulkCreate(f.before.shares);
 await db.Tratamiento.bulkCreate(f.before.treatments);
 f.before.treatments=await db.Tratamiento.findAll({order:[['id_tratamiento','ASC']],raw:true});
 const pkg=variants.prepare(f),baseHash=hash(f.before.treatments),created=[];
 const {createTratamiento}=require('../../controllers/tratamientos.controller');
 const invoke=body=>new Promise((resolve,reject)=>createTratamiento({body},{status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}},reject));
 for(const v of pkg.variants){
  const r=await invoke(v.payload);assert.equal(r.status,201);
  const row=await db.Tratamiento.findByPk(r.body.id_tratamiento,{raw:true});variants.verifyVariant(row,v);created.push(row);
  assert.equal(r.body.catalog_price.amount,null);assert(r.body.catalog_price.review_required);assert.equal(row.appointment_automation_template_key,null);
 }
 assert.equal(await db.Tratamiento.count(),8);
 assert.equal(hash(await db.Tratamiento.findAll({where:{id_tratamiento:f.before.treatments.map(t=>t.id_tratamiento)},order:[['id_tratamiento','ASC']],raw:true})),baseHash);
 report.checks.push('Canonical treatment controller creates two inactive, unpriced variants; original six treatments unchanged; no automation template assigned.');
 const all=await db.Tratamiento.findAll({raw:true}),pp=programs.prepare({plan:f.plan,sourceHashes:f.sourceHashes,clinics:f.before.clinics,treatments:all,existingPrograms:[]});
 const service=createTreatmentProgramsService({db}),durations=[90,135,225,270,360,480,630];
 for(const [i,p]of pp.programs.entries()){
  const args={clinicId:72,actorId:7,payload:p.payload};
  const preview=await service.preview(args);assert.equal(preview.item.purchase_enabled,false);
  const a=await service.create(args),b=await service.create(args);assert(a.created);assert(!b.created);assert.equal(a.item.id,b.item.id);
  assert.equal(a.item.summary.duration_minutes,durations[i]);assert.equal(a.item.total_price,null);assert.equal(a.item.status,'draft');
  assert.equal(a.item.purchase_enabled,false);assert.equal(a.item.summary.ready_for_scheduling,false);
  assert(a.item.appointments.every(a=>a.treatment_ids.length===1&&!a.issues.some(i=>['installation_unavailable','professional_unavailable','equipment_unavailable'].includes(i.code))));
  await assert.rejects(service.update({id:a.item.id,clinicId:72,actorId:7,payload:{expected_version:1,status:'active'}}),{code:'program_not_ready'});
  await assert.rejects(service.update({id:a.item.id,clinicId:66,actorId:7,payload:{expected_version:1,notes:'Wrong clinic'}}),{code:'program_not_found'});
 }
 assert.equal(await db.TreatmentProgram.count(),7);assert.equal(await db.TreatmentProgramRevision.count(),7);
 assert.equal(hash(await db.Tratamiento.findAll({raw:true})),hash(all));
 assert.equal((await service.list({clinicId:72})).total,7);assert.equal((await service.options({clinicId:72})).total,0);
 report.checks.push('Seven SQL-backed drafts and seven revisions, exact minutes/composition; idempotent create, activation and cross-clinic guards; no patient/appointment/provider writes.');
}).catch(e=>{console.error(e);process.exitCode=1;});
