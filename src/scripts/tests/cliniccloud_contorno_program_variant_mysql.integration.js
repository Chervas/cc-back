'use strict';
// Runs the pure synthetic fixtures too. No production model index or data is loaded.
const assert=require('node:assert/strict');
const Sequelize=require('sequelize');
const {fixture}=require('./cliniccloud_contorno_program_variant.test');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {prepare:prepareOriginal}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {prepare,verifyVariant,programUpdate,verifyProgram}=require('../../lib/cliniccloud-import/contorno-program-variant');
const {createTreatmentProgramsService}=require('../../services/treatmentPrograms.service');
const {hash}=require('../../lib/cliniccloud-import/adapter');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
  db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,equipment_booking_enabled:D.BOOLEAN},{timestamps:false});
  db.Instalacion=sql.define('Instalacion',{id:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,activo:D.BOOLEAN},{timestamps:false});
  db.DoctorClinica=sql.define('DoctorClinica',{id:{type:D.INTEGER,primaryKey:true},doctor_id:D.INTEGER,clinica_id:D.INTEGER,activo:D.BOOLEAN,recibe_citas:D.BOOLEAN},{timestamps:false});
  for(const file of ['tratamiento','treatmentprogram','treatmentprogramrevision','installationphysicalalias','bookingequipment','bookingequipmentclinic','bookingequipmentroompolicy']){
    const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
  }
  db.Instalacion.belongsTo(db.Clinica,{foreignKey:'clinica_id',targetKey:'id_clinica',as:'clinica'});
  db.BookingEquipment.associate(db);
  await sql.sync();
  const f=fixture();
  await db.Clinica.bulkCreate([66,72].map(id_clinica=>({id_clinica,grupoClinicaId:29,equipment_booking_enabled:true})));
  await db.Instalacion.bulkCreate(f.before.rooms);
  await db.BookingEquipmentRoomPolicy.bulkCreate(f.before.policies);
  await db.DoctorClinica.bulkCreate(f.before.staff);
  await db.InstallationPhysicalAlias.bulkCreate(f.before.aliases.map(row=>({...row,group_id:29})));
  await db.BookingEquipment.bulkCreate(f.before.units.map(u=>({...u,name:'Equipo ficticio '+u.id,owner_clinic_id:72})));
  await db.BookingEquipmentClinic.bulkCreate(f.before.shares);
  await db.Tratamiento.bulkCreate(f.before.treatments.map(t=>({...t,disciplina:'estetica'})));
  f.before.treatments=await db.Tratamiento.findAll({order:[['id_tratamiento','ASC']],raw:true});
  const original=prepareOriginal({plan:f.plan,sourceHashes:f.sourceHashes,clinics:f.before.clinics,treatments:f.before.treatments,existingPrograms:[]});
  const service=createTreatmentProgramsService({db});
  for(const p of original.programs)await service.create({clinicId:72,actorId:7,payload:p.payload});
  for(const existing of f.before.programs.filter(p=>p.version_number===2)){
    const row=await db.TreatmentProgram.findOne({where:{name:existing.name},raw:true});
    await service.update({id:row.public_id,clinicId:72,actorId:7,payload:{expected_version:1,notes:existing.notes}});
  }
  f.before.programs=await db.TreatmentProgram.findAll({order:[['id','ASC']],raw:true});
  const pkg=prepare(f),baseHash=hash(f.before.treatments),variants=[];
  const {createTratamiento}=require('../../controllers/tratamientos.controller');
  const invoke=body=>new Promise((resolve,reject)=>{
    const res={status(code){this.statusCode=code;return this;},json(value){resolve({status:this.statusCode,body:value});}};
    createTratamiento({body},res,reject);
  });
  for(const variant of pkg.variants){
    const result=await invoke(variant.payload);assert.equal(result.status,201);
    const row=await db.Tratamiento.findByPk(result.body.id_tratamiento,{raw:true});
    verifyVariant(row,variant);variants.push(row);
    assert.equal(result.body.catalog_price.amount,null);
    assert.equal(result.body.catalog_price.review_required,true);
    assert.equal(row.appointment_automation_template_key,null);
  }
  report.checks.push('Real treatment controller and ORM create exactly one inactive draft; null price stays null, provenance and all phases survive canonical normalization.');
  assert.equal(await db.Tratamiento.count(),f.before.treatments.length+1);
  assert.equal(hash(await db.Tratamiento.findAll({where:{id_tratamiento:f.before.treatments.map(t=>t.id_tratamiento)},order:[['id_tratamiento','ASC']],raw:true})),baseHash);
  for(const p of pkg.programs){
    const payload=programUpdate(p,variants),args={id:p.before.public_id,clinicId:72,actorId:7,payload};
    const updated=await service.update(args);assert.equal(updated.item.status,'draft');assert.equal(updated.item.purchase_enabled,false);
    assert.equal(updated.item.total_price,null);assert.equal(updated.item.version,2);
    assert.deepEqual(updated.item.appointments.map(a=>a.duration_minutes),[45,55,45,45,55,45,45,55]);
    assert.equal(updated.item.summary.duration_minutes,390);
    assert(updated.item.appointments.every(a=>!a.issues.some(i=>['installation_unavailable','professional_unavailable','equipment_unavailable'].includes(i.code))));
    verifyProgram(await db.TreatmentProgram.findByPk(p.before.id,{raw:true}),p,variants);
    await assert.rejects(service.update(args),{code:'program_version_conflict'});
    await assert.rejects(service.update({...args,payload:{expected_version:2,status:'active'}}),{code:'program_not_ready'});
    await assert.rejects(service.update({...args,clinicId:66,payload:{expected_version:2,notes:'wrong clinic'}}),{code:'program_not_found'});
  }
  assert.equal(await db.TreatmentProgram.count(),11);assert.equal(await db.TreatmentProgramRevision.count(),19);
  for(const untouched of f.before.programs.filter(p=>!pkg.programs.some(t=>t.before.id===p.id))){
    assert.equal(hash(await db.TreatmentProgram.findByPk(untouched.id,{raw:true})),hash(untouched));
  }
  report.checks.push('One canonical version-2 revision fills eight entries (mesotherapy after 2/5/8); unchanged standalone treatments and ten other programs, cadence and reviews preserved; activation, stale revision and cross-clinic updates rejected.');
  const after=(await service.list({clinicId:72})).items;
  assert.equal(after.length,11);assert(after.every(i=>!i.purchase_enabled));
  assert.equal((await service.options({clinicId:72})).total,0);
  report.checks.push('Real SQL-backed program read model remains non-purchasable. No appointments, patient data, providers or reminders in this isolated test.');
}).catch(e=>{console.error(e);process.exitCode=1;});
