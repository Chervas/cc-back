'use strict';
const assert=require('node:assert/strict');
const Sequelize=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {prepare,PDF_SHA256}=require('../../lib/cliniccloud-import/capillary-program-drafts');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {createTreatmentProgramsService}=require('../../services/treatmentPrograms.service');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
 db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER},{timestamps:false});
 db.Tratamiento=sql.define('Tratamiento',{id_tratamiento:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,codigo:D.STRING,
   clinica_id:D.INTEGER,grupo_clinica_id:D.INTEGER,origen:D.STRING,activo:D.BOOLEAN,sesiones_defecto:D.INTEGER,
   duracion_min:D.INTEGER,clinical_config:D.JSON,eliminado_por_clinica:D.JSON},{timestamps:false});
 for(const file of ['treatmentprogram','treatmentprogramrevision']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 await sql.sync();await db.Clinica.create({id_clinica:66,grupoClinicaId:29});
 const rows=[],treatments=[];
 for(const [index,[sourceRow,minutes]]of [[22,30],[24,30],[33,20],[31,20],[43,10]].entries()){
   const source={sheet:'Capilar · sesiones y bonos',source_row:sourceRow,kind:'treatment',clinic_id:66,
     proposed_code:'SYNTHETIC-'+sourceRow,display_name:'Prueba ficticia '+sourceRow,source_catalog_key:'key-'+sourceRow,
     provenance:{file_sha256:hash('fiction'),source_row:sourceRow}};rows.push(source);
   const t={id_tratamiento:index+1,nombre:source.display_name,codigo:source.proposed_code,clinica_id:66,origen:'clinica',activo:0,
     duracion_min:minutes,sesiones_defecto:1,clinical_config:{catalog_status:'draft',source_catalog_key:source.source_catalog_key,source_catalog:source.provenance}};
   treatments.push(t);await db.Tratamiento.create(t);
 }
 const body={version:1,mode:'catalog_dry_run_only',workbook_sha256:hash('fiction'),clinics:{medical:72,capilar:66},rows};
 const pkg=prepare({plan:{...body,plan_sha256:hash(body)},pdfSha256:PDF_SHA256,clinics:[{id_clinica:66,grupoClinicaId:29}],treatments,existingPrograms:[]});
 const service=createTreatmentProgramsService({db}),before=hash(await db.Tratamiento.findAll({raw:true}));
 for(const p of pkg.programs){
   const args={clinicId:66,actorId:7,payload:p.payload};
   const preview=await service.preview(args);assert.equal(preview.item.purchase_enabled,false);
   const a=await service.create(args),b=await service.create(args);
   assert.equal(a.created,true);assert.equal(b.created,false);assert.equal(a.item.id,b.item.id);
   assert.equal(a.item.status,'draft');assert.equal(a.item.total_price,null);assert.equal(a.item.summary.ready_for_scheduling,false);
   assert.deepEqual(a.item.appointments.map(a=>a.treatment_ids),p.payload.appointments.map(a=>a.treatment_ids));
   await assert.rejects(service.update({id:a.item.id,clinicId:66,actorId:7,payload:{expected_version:1,status:'active'}}),{code:'program_not_ready'});
 }
 assert.equal(await db.TreatmentProgram.count(),5);assert.equal(await db.TreatmentProgramRevision.count(),5);
 assert.equal(hash(await db.Tratamiento.findAll({raw:true})),before);
 report.checks.push('Five documentary drafts create five canonical revisions; retry does not duplicate; incomplete activation is rejected; treatments unchanged.');
 const list=await service.list({clinicId:66});assert.equal(list.total,5);assert(list.items.every(i=>!i.purchase_enabled));
 report.checks.push('Real SQL-backed read model preserves session counts and blocks purchase; isolated synthetic database, no external sockets.');
}).catch(e=>{console.error(e);process.exitCode=1;});
