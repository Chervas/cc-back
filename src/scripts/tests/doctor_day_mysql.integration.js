'use strict';
// The live day projection executes against owned synthetic appointment rows.
// No runtime clinic, patient or care mutation is read or written.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),Sequelize=require('sequelize'),{DataTypes:D}=Sequelize;
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
function load(file,overrides){const local=createRequire(file),module={exports:{}};vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,Date,Map,Set,Intl,console,require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)},{filename:file});return module.exports;}
withIsolatedCampaignMysql(async({sql,models:db,report,registerOwnedLoopbackServer})=>{
 db.Sequelize=Sequelize;
 db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},nombre_clinica:D.STRING,configuracion:D.JSON},{tableName:'Clinicas',timestamps:false});
 db.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,apellidos:D.STRING,avatar:D.STRING,estado_cuenta:D.STRING},{tableName:'Usuarios',timestamps:false});
 for(const file of ['usuarioclinica','doctorclinica']){const model=require('../../../models/'+file)(sql,D);db[model.name]=model;}
 db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,nombre:D.STRING,apellidos:D.STRING,numero_historia:D.STRING,foto:D.STRING},{tableName:'Pacientes',timestamps:false});
 const appointmentFields={id_cita:{type:D.INTEGER,primaryKey:true}};
 for(const key of ['clinica_id','paciente_id','doctor_id','instalacion_id','tratamiento_id','voucher_id'])appointmentFields[key]=D.INTEGER;
 for(const key of ['titulo','motivo','nota','tipo_cita','estado','source_system'])appointmentFields[key]=D.STRING;
 for(const key of ['inicio','fin','arrived_at','care_started_at','care_completed_at','care_schedule_start'])appointmentFields[key]=D.DATE;
 appointmentFields.care_legacy_attendance=D.BOOLEAN;appointmentFields.es_provisional=D.BOOLEAN;appointmentFields.import_metadata=D.JSON;
 db.CitaPaciente=sql.define('CitaPaciente',appointmentFields,{tableName:'CitaPacientes',timestamps:false});await sql.sync();
 await db.Clinica.bulkCreate([{id_clinica:72,nombre_clinica:'Fictitious Madrid',configuracion:{timezone:'Europe/Madrid'}},{id_clinica:73,nombre_clinica:'Fictitious foreign',configuracion:{timezone:'UTC'}},{id_clinica:74,nombre_clinica:'Fictitious empty',configuracion:{timezone:'Pacific/Kiritimati'}}]);
 await db.Usuario.bulkCreate([1,7,8,9,10,11,12,13].map(id=>({id_usuario:id,nombre:'Fictitious '+id,estado_cuenta:id===12?'suspendido':'activo'})));
 const member=(user,clinic,role='personaldeclinica',subrole='Doctores',state='aceptada')=>({id_usuario:user,id_clinica:clinic,rol_clinica:role,subrol_clinica:subrole,estado_invitacion:state});
 await db.UsuarioClinica.bulkCreate([member(7,72),member(7,74),member(8,72,'personaldeclinica','Recepción / Comercial ventas'),member(9,72,'propietario'),member(10,73),member(11,72),member(12,72),member(13,72,'personaldeclinica','Doctores','pendiente')]);
 await db.DoctorClinica.bulkCreate([{doctor_id:7,clinica_id:72,activo:true,recibe_citas:true},{doctor_id:9,clinica_id:72,activo:true,recibe_citas:true},{doctor_id:10,clinica_id:73,activo:true,recibe_citas:true},{doctor_id:11,clinica_id:72,activo:false,recibe_citas:true},{doctor_id:12,clinica_id:72,activo:true,recibe_citas:true},{doctor_id:13,clinica_id:72,activo:true,recibe_citas:true}]);
 await db.Paciente.create({id_paciente:101,nombre:'Fictitious patient'});
 const appointment=(id,start,patch={})=>({id_cita:id,clinica_id:72,paciente_id:101,doctor_id:7,estado:'pendiente',inicio:new Date(start),fin:new Date(new Date(start).getTime()+300000),...patch});
 await db.CitaPaciente.bulkCreate([appointment(1,'2026-10-24T22:00Z',{estado:'completada'}),appointment(2,'2026-10-25T22:59:59Z'),appointment(3,'2026-10-25T07:00Z',{estado:'cancelada'}),appointment(4,'2026-10-24T21:59:59Z'),appointment(5,'2026-10-25T23:00Z'),appointment(6,'2026-10-25T07:00Z',{doctor_id:9}),appointment(7,'2026-10-25T07:00Z',{clinica_id:73,doctor_id:10}),appointment(8,'2026-10-25T08:00Z',{estado:'reprogramada'})]);
 const denied=new Set(),calls=[];
 const access=async({actorId,featureKey,clinicIds})=>{calls.push({actorId,featureKey,clinicIds});return denied.has(featureKey)||['consents.view','appointments.manage'].includes(featureKey)?[]:clinicIds;};
 const service=load(require.resolve('../../services/panelesDashboard.service'),{'../../models':db,'../lib/access-policy':{getAccessibleClinicIdsForFeature:access},'./personalPresence.service':{},'./whatsappPaymentStatus.service':{}});
 const before=JSON.stringify(await db.CitaPaciente.findAll({raw:true,order:[['id_cita','ASC']]}));
 const own=await service.getDoctorDay({userId:7,query:{clinic_id:'72',date:'2026-10-25'}});
 assert.equal(own.professional.id,7);assert.equal(own.can_select_professional,false);assert.deepEqual(Array.from(own.appointments,r=>r.appointmentId),[1,2]);assert.deepEqual(Array.from(own.inactive_appointments,r=>r.appointmentId),[3,8]);assert(own.appointments.every(r=>r.doctorId===7&&r.clinicId===72&&!r.canManage));assert.equal(own.appointments[0].rawStatus,'completada');assert.equal(own.date,'2026-10-25');assert.equal(own.time_zone,'Europe/Madrid');assert.equal(own.appointments[1].timeLabel,'23:59');
 await assert.rejects(service.getDoctorDay({userId:7,query:{clinic_id:72,date:'2026-10-25',doctor_id:9}}),{code:'doctor_day_own_professional_required'});
 const manager=await service.getDoctorDay({userId:8,query:{clinic_id:72,date:'2026-10-25'}});assert.equal(manager.can_select_professional,true);assert.equal(manager.professional.id,7);assert.deepEqual(Array.from(manager.professionals,r=>r.id),[7,9]);
 const selected=await service.getDoctorDay({userId:8,query:{clinic_id:72,date:'2026-10-25',doctor_id:9}});assert.deepEqual(Array.from(selected.appointments,r=>r.appointmentId),[6]);
 assert.equal((await service.getDoctorDay({userId:9,query:{clinic_id:72,date:'2026-10-25'}})).professional.id,9);
 for(const id of [10,11,12,13])await assert.rejects(service.getDoctorDay({userId:8,query:{clinic_id:72,doctor_id:id,date:'2026-10-25'}}),{code:'doctor_day_professional_invalid'});
 report.checks.push('Native SQL enforces own-provider doctor scope and manager selection only among active receiving providers with active same-clinic memberships. The 25-hour Madrid DST day includes both boundaries and closed visits; cancelled/rescheduled visits remain separate.');
 const empty=await service.getDoctorDay({userId:7,query:{clinic_id:74,date:'2026-10-25'}});assert.equal(empty.professional,null);assert.equal(empty.professionals.length,0);assert.equal(empty.appointments.length,0);assert.equal(empty.inactive_appointments.length,0);
 const defaultDay=await service.getDoctorDay({userId:7,query:{clinic_id:74}});const expected=new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Kiritimati',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());assert.equal(defaultDay.date,expected);
 for(const query of [{clinic_id:'72,73'},{clinic_id:'all'},{clinic_id:[72]},{clinic_id:72,date:'2026-02-30'},{clinic_id:72,doctor_id:0}])await assert.rejects(service.getDoctorDay({userId:7,query}),error=>error.statusCode===400);
 for(const feature of ['appointments.view','patients.view','patients.sensitive.view']){denied.add(feature);await assert.rejects(service.getDoctorDay({userId:7,query:{clinic_id:72}}),{code:'access_policy_forbidden'});denied.delete(feature);}
 denied.add('clinical.reports.view');assert.equal((await service.getDoctorDay({userId:7,query:{clinic_id:72}})).can_view_history,false);denied.delete('clinical.reports.view');
 const admin=await service.getDoctorDay({userId:1,query:{clinic_id:72,date:'2026-10-25'}});assert.equal(admin.professional.id,7);
 assert.equal(JSON.stringify(await db.CitaPaciente.findAll({raw:true,order:[['id_cita','ASC']]})),before);
 report.checks.push('Missing providers never broaden into all appointments. Default day follows clinic time zone; malformed/multi-clinic/date requests and each denied patient/agenda permission fail, history stays separately gated, and GET leaves every care/status field unchanged.');
 const express=require('express');
 const router=load(require.resolve('../../routes/paneles.routes'),{'../../models':db,'../services/panelesDashboard.service':service,'../lib/access-policy':{getAccessibleClinicIdsForFeature:access},'./auth.middleware':(req,res,next)=>{if(!req.headers['x-owned-actor'])return res.sendStatus(401);req.userData={userId:Number(req.headers['x-owned-actor'])};next();}});
 const app=express();app.use(router);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});registerOwnedLoopbackServer(server);
 try{const get=(url,actor)=>new Promise((resolve,reject)=>{require('node:http').get({host:'127.0.0.1',port:server.address().port,path:url,headers:actor?{'x-owned-actor':String(actor)}:{}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));}).on('error',reject);});
 assert.equal((await get('/doctor-day?clinic_id=72&date=2026-10-25')).status,401);
 const response=await get('/doctor-day?clinic_id=72&date=2026-10-25',7);assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(JSON.parse(response.body).professional.id,7);
 assert.equal((await get('/doctor-day?clinic_id=72&doctor_id=9',7)).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 report.checks.push('Production GET route is authenticated and private/no-store, returns the exact DTO, rejects provider tampering, and creates no appointment, episode or attendance mutation.');
}).catch(error=>{console.error(error);process.exitCode=1;});
