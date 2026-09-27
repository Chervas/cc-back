'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),Sequelize=require('sequelize');
const {fixture}=require('./cliniccloud_corporal_program_profiles.test');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {prepare:prepareOriginal}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {prepare,verifyState,verifyProgram}=require('../../lib/cliniccloud-import/corporal-program-profiles');
const {capture,executeProfiles}=require('../cliniccloud-import-corporal-program-profiles');
const {validateCatalogResources}=require('../../lib/treatment-catalog-resources');
const {createTreatmentProgramsService}=require('../../services/treatmentPrograms.service');
const {hash}=require('../../lib/cliniccloud-import/adapter');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
 const define=(name,fields,tableName)=>sql.define(name,fields,{tableName,timestamps:false});
 db.Clinica=define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,equipment_booking_enabled:D.BOOLEAN},'Clinicas');
 db.Instalacion=define('Instalacion',{id:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,activo:D.BOOLEAN,capacidad:D.INTEGER,tiempo_preparacion_minutos:D.INTEGER,profesionales_permitidos:D.JSON},'Instalaciones');
 db.DoctorClinica=define('DoctorClinica',{id:{type:D.INTEGER,primaryKey:true},doctor_id:D.INTEGER,clinica_id:D.INTEGER,activo:D.BOOLEAN,recibe_citas:D.BOOLEAN},'DoctorClinicas');
 const Hours=define('DoctorHorario',{id:{type:D.INTEGER,primaryKey:true},doctor_clinica_id:D.INTEGER,activo:D.BOOLEAN,hora_inicio:D.STRING,hora_fin:D.STRING},'DoctorHorarios');
 const RoomHours=define('InstalacionHorario',{id:{type:D.INTEGER,primaryKey:true},instalacion_id:D.INTEGER,activo:D.BOOLEAN,hora_inicio:D.STRING,hora_fin:D.STRING},'InstalacionHorarios');
 for(const file of ['tratamiento','treatmentprogram','treatmentprogramrevision','installationphysicalalias','bookingequipment','bookingequipmentclinic','bookingequipmentroompolicy']){
  const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
 }
 db.Instalacion.belongsTo(db.Clinica,{foreignKey:'clinica_id',targetKey:'id_clinica',as:'clinica'});db.BookingEquipment.associate(db);
 await sql.sync();const f=fixture();
 await db.Clinica.bulkCreate([72,66].map(id_clinica=>({id_clinica,grupoClinicaId:29,equipment_booking_enabled:true})));
 await db.Instalacion.bulkCreate(f.before.rooms);await db.DoctorClinica.bulkCreate(f.before.staff);
 await Hours.bulkCreate(f.before.staff_hours);await RoomHours.bulkCreate(f.before.room_hours);
 await db.BookingEquipment.bulkCreate(f.before.units.map(u=>({...u,name:'Fictitious '+u.family_key})));
 await db.BookingEquipmentClinic.bulkCreate(f.before.shares);await db.BookingEquipmentRoomPolicy.bulkCreate(f.before.policies);
 await db.Tratamiento.bulkCreate(f.before.treatments.map(t=>({...t,disciplina:'estetica'})));
 const c=await require('mysql2/promise').createConnection({socketPath:path.join(report.root,'mysql.sock'),user:'root',database:report.database,dateStrings:true});
 try{
  let before=await capture(c);const original=prepareOriginal({plan:f.plan,sourceHashes:f.sourceHashes,clinics:before.clinics,treatments:before.treatments,existingPrograms:[]});
  const service=createTreatmentProgramsService({db});
  for(const p of original.programs)await service.create({clinicId:72,actorId:7,payload:p.payload});
  before=await capture(c);const pkg=prepare({plan:f.plan,sourceHashes:f.sourceHashes,before}),baseline=hash(before),events=[];
  const journal={append:async e=>events.push(e.stage)};
  for(const op of pkg.operations)await validateCatalogResources({...op.before,clinical_config:op.after_config},db,{environment:{BOOKING_PROFILES_ENABLED:'true',BOOKING_MULTI_RESOURCE_ENABLED:'true',BOOKING_EQUIPMENT_ENABLED:'true'}});
  report.checks.push('All five profiles pass the canonical catalog resource validator on isolated SQL.');
  await assert.rejects(executeProfiles({c,pkg,journal:{append:async e=>{if(e.stage==='profiles_written_before_commit')throw Error('journal failed');}}}),/journal failed/);
  assert.equal(hash(await capture(c)),baseline);
  assert.equal((await executeProfiles({c,pkg,journal,rehearse:true})).status,'rehearsed_rolled_back');assert.equal(hash(await capture(c)),baseline);
  assert.equal((await executeProfiles({c,pkg,journal})).updated,5);
  verifyState(await capture(c),pkg,{profilesComplete:true});assert.equal((await executeProfiles({c,pkg,journal})).updated,0);
  for(const p of pkg.programs){const args={id:p.before.public_id,clinicId:72,actorId:7,payload:p.payload};
   const result=await service.update(args);assert.equal(result.item.purchase_enabled,false);assert.equal(result.item.version,2);
   await assert.rejects(service.update(args),{code:'program_version_conflict'});
   await assert.rejects(service.update({...args,payload:{expected_version:2,status:'active'}}),{code:'program_not_ready'});
   await assert.rejects(service.update({...args,clinicId:66,payload:{expected_version:2,notes:'foreign'}}),{code:'program_not_found'});
   const revision=await db.TreatmentProgramRevision.findOne({where:{program_id:p.before.id,version_number:2},raw:true});verifyProgram(revision.snapshot,p);
  }
  verifyState(await capture(c),pkg,{complete:true});assert.equal((await executeProfiles({c,pkg,journal})).updated,0);
  assert.equal(await db.TreatmentProgramRevision.count(),18);
  report.checks.push('Journal failure and rehearsal roll back all five updates; exact replay makes zero writes. Seven canonical notes-only revisions preserve composition, cadence, price, scope and inactive state.');
  await c.query('UPDATE Tratamientos SET precio_base=999 WHERE id_tratamiento=?',[pkg.operations[0].id]);
  await assert.rejects(executeProfiles({c,pkg,journal}));
  report.checks.push('Readback rejects later human price edits; stale revisions, activation and foreign clinic requests are rejected. No patient/appointment/economy/provider tables or sockets.');
 }finally{await c.end();}
}).catch(e=>{console.error(e);process.exitCode=1;});
