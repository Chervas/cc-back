'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),Sequelize=require('sequelize');
function fixture({denied=[],role='personaldeclinica',subrole='Doctores'}={}){
 const queries=[],db={Sequelize};const read=name=>{queries.push(name);throw Error('UNEXPECTED_'+name);};
 db.UsuarioClinica={findOne:async()=>({rol_clinica:role,subrol_clinica:subrole}),findAll:()=>read('membership-list')};db.Clinica={findByPk:async()=>({id_clinica:72,nombre_clinica:'Fictitious',configuracion:{timezone:'Europe/Madrid'}})};
 db.DoctorClinica={findAll:async()=>[]};db.CitaPaciente={findAll:()=>read('appointments')};db.Usuario={findAll:()=>read('users')};
 const file=require.resolve('../../services/panelesDashboard.service'),local=createRequire(file),module={exports:{}};
 const overrides={'../../models':db,'../lib/access-policy':{getAccessibleClinicIdsForFeature:async({featureKey,clinicIds})=>denied.includes(featureKey)?[]:clinicIds},'./personalPresence.service':{},'./whatsappPaymentStatus.service':{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,Date,Map,Set,Intl,require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)},{filename:file});return {service:module.exports,queries};
}
test('doctor day denies each required permission before loading patient appointments',async()=>{
 for(const feature of ['appointments.view','patients.view','patients.sensitive.view']){const f=fixture({denied:[feature]});await assert.rejects(f.service.getDoctorDay({userId:7,query:{clinic_id:72}}),{code:'access_policy_forbidden'});assert.equal(f.queries.length,0);}
});
test('scope parsing rejects all/multiple clinic and invalid calendar inputs without loading records',async()=>{
 const f=fixture();for(const query of [{clinic_id:'all'},{clinic_id:'72,73'},{clinic_id:[72]},{clinic_id:72,date:'2026-02-30'},{clinic_id:72,doctor_id:'7e0'}])await assert.rejects(f.service.getDoctorDay({userId:7,query}),error=>error.statusCode===400);assert.equal(f.queries.length,0);
});
test('doctor cannot select another provider even with full ACL; agency cannot inherit operations from an administrative label',async()=>{
 const f=fixture();await assert.rejects(f.service.getDoctorDay({userId:7,query:{clinic_id:72,doctor_id:8}}),{code:'doctor_day_own_professional_required'});assert.equal(f.queries.length,0);
 const agency=fixture({role:'agencia',subrole:'Administrativos'});await assert.rejects(agency.service.getDoctorDay({userId:7,query:{clinic_id:72}}),{code:'doctor_day_role_forbidden'});assert.equal(agency.queries.length,0);
});
test('empty provider list resets selection and never runs an unscoped appointment query',async()=>{
 const f=fixture(),result=await f.service.getDoctorDay({userId:7,query:{clinic_id:72,date:'2026-10-25'}});assert.equal(result.professional,null);assert.equal(result.professionals.length,0);assert.equal(result.appointments.length,0);assert.equal(f.queries.length,0);
 const manager=fixture({role:'propietario'}),response=await manager.service.getDoctorDay({userId:9,query:{clinic_id:72,date:'2026-10-25'}});assert.equal(response.can_select_professional,true);assert.equal(response.professional,null);assert.equal(manager.queries.length,0);
});
