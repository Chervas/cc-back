'use strict';
// Runs the pure synthetic fixtures too. No production model index or data is loaded.
const assert=require('node:assert/strict');
const Sequelize=require('sequelize');
const {fixture}=require('./cliniccloud_capillary_program_variants.test');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {prepare:prepareOriginal}=require('../../lib/cliniccloud-import/capillary-program-drafts');
const {prepare,verifyVariant,programUpdate,verifyProgram}=require('../../lib/cliniccloud-import/capillary-program-variants');
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
  await db.Instalacion.bulkCreate([...f.before.rooms,...[84,87].map(id=>({id,clinica_id:72,activo:true}))]);
  await db.DoctorClinica.bulkCreate(f.before.staff);
  await db.InstallationPhysicalAlias.bulkCreate(f.before.aliases.map(row=>({...row,group_id:29})));
  await db.BookingEquipment.bulkCreate(f.before.units.map(u=>({...u,name:'Equipo ficticio '+u.id,owner_clinic_id:u.id===15?66:72})));
  await db.BookingEquipmentClinic.bulkCreate(f.before.shares);
  await db.Tratamiento.bulkCreate(f.before.treatments.map(t=>({...t,disciplina:'capilar'})));
  f.before.treatments=await db.Tratamiento.findAll({order:[['id_tratamiento','ASC']],raw:true});
  const original=prepareOriginal({plan:f.plan,pdfSha256:f.pdfSha256,clinics:f.before.clinics,treatments:f.before.treatments,existingPrograms:[]});
  const service=createTreatmentProgramsService({db});
  for(const p of original.programs)await service.create({clinicId:66,actorId:7,payload:p.payload});
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
  report.checks.push('Real treatment controller and ORM create exactly three inactive drafts; null price stays null, provenance and all phases survive canonical normalization.');
  assert.equal(await db.Tratamiento.count(),f.before.treatments.length+3);
  assert.equal(hash(await db.Tratamiento.findAll({where:{id_tratamiento:f.before.treatments.map(t=>t.id_tratamiento)},order:[['id_tratamiento','ASC']],raw:true})),baseHash);
  for(const p of pkg.programs){
    const payload=programUpdate(p,variants),args={id:p.before.public_id,clinicId:66,actorId:7,payload};
    const updated=await service.update(args);assert.equal(updated.item.status,'draft');assert.equal(updated.item.purchase_enabled,false);
    assert.equal(updated.item.total_price,null);assert.equal(updated.item.version,2);
    verifyProgram(await db.TreatmentProgram.findByPk(p.before.id,{raw:true}),p,variants);
    await assert.rejects(service.update(args),{code:'program_version_conflict'});
    await assert.rejects(service.update({...args,payload:{expected_version:2,status:'active'}}),{code:'program_not_ready'});
    await assert.rejects(service.update({...args,clinicId:72,payload:{expected_version:2,notes:'wrong clinic'}}),{code:'program_not_found'});
  }
  assert.equal(await db.TreatmentProgram.count(),5);assert.equal(await db.TreatmentProgramRevision.count(),8);
  for(const untouched of f.before.programs.filter(p=>!pkg.programs.some(t=>t.before.id===p.id))){
    assert.equal(hash(await db.TreatmentProgram.findByPk(untouched.id,{raw:true})),hash(untouched));
  }
  report.checks.push('Three canonical version-2 revisions fill 15 placeholders; unchanged standalone treatments, two untouched programs, cadence and reviews preserved; activation, stale revision and cross-clinic updates rejected.');
  const after=(await service.list({clinicId:66})).items;
  assert.equal(after.length,5);assert(after.every(i=>!i.purchase_enabled));
  assert.equal((await service.options({clinicId:66})).total,0);
  report.checks.push('No draft variant appears in active treatment choices; real SQL-backed program read model remains non-purchasable. No appointments, patient data, providers or reminders in this isolated test.');
}).catch(e=>{console.error(e);process.exitCode=1;});
