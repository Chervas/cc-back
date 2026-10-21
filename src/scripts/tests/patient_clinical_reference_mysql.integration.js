'use strict';
const assert=require('node:assert/strict'),{DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,clinica_id:D.INTEGER,nombre:D.STRING,medicacion:D.TEXT,antecedentes:D.TEXT},{timestamps:false});
 db.PacienteClinica=sql.define('PacienteClinica',{id:{type:D.INTEGER,primaryKey:true},paciente_id:D.INTEGER,clinica_id:D.INTEGER},{timestamps:false});
 await sql.sync();await db.Paciente.create({id_paciente:9,public_id:'OWNED-CLINICAL-REFERENCE',clinica_id:72,nombre:'Ficticio',medicacion:'Original',antecedentes:'Conservar'});
 const service=require('../../services/patientClinicalReference.service').createPatientClinicalReferenceService({db,canAccess:async()=>true});
 const save=medicacion=>service.update({patientIdentifier:'OWNED-CLINICAL-REFERENCE',clinicId:72,actorId:7,payload:{expected_medication:'Original',medicacion}});
 const results=await Promise.allSettled([save('Versión A ficticia'),save('Versión B ficticia')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected');assert.equal(rejected.reason.code,'clinical_reference_conflict');
 const current=await db.Paciente.findByPk(9);assert.equal(current.medicacion,results.find(r=>r.status==='fulfilled').value.item.medicacion);assert.equal(current.antecedentes,'Conservar');assert.equal(current.nombre,'Ficticio');
 await assert.rejects(service.update({patientIdentifier:'OWNED-CLINICAL-REFERENCE',clinicId:73,actorId:7,payload:{expected_medication:current.medicacion,medicacion:'No'}}),{statusCode:404});
 assert.equal((await db.Paciente.findByPk(9)).medicacion,current.medicacion);
 report.checks.push('Actual clinical-reference service in owned MySQL: two concurrent stale medication edits yield one winner and one 409, only medication changes; missing patient membership blocks writes. No DEV DB or external providers.');
}).catch(error=>{console.error(error);process.exitCode=1;});
