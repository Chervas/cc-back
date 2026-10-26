'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Op}=require('sequelize');
const sharing=require('../../services/personalScheduleSharing.service');
const recurring=require('../../lib/personal-schedule-recurring');
const calendar=require('../../lib/availability-calendar');
const flexible=require('../../lib/flexible-agenda');
const root=path.resolve(__dirname,'../../..'),plain=value=>JSON.parse(JSON.stringify(value));

// Run actual readers with bounded model doubles; the actual sharing service and
// recurrence/exception expanders execute. No app bootstrap, SQL, HTTP or providers.
function load(relative,db,deps={}){
  const module={exports:{}};
  const context={module,exports:module.exports,Date,Intl,Set,Map,console,process:{env:{}},Buffer,
    require:name=>{
      if(Object.hasOwn(deps,name))return deps[name];
      if(name==='../../models')return db;
      if(name==='sequelize')return {Op};
      if(name==='express-async-handler')return fn=>fn;
      if(name==='crypto'||name==='node:crypto')return require(name);
      if(name==='../lib/personal-schedule-recurring')return recurring;
      if(name==='../lib/availability-calendar')return calendar;
      if(name==='../lib/flexible-agenda')return flexible;
      if(name==='./personalScheduleSharing.service'||name==='../services/personalScheduleSharing.service')return sharing;
      if(name==='../services/personalCalendarUndo.service')return require('../../services/personalCalendarUndo.service');
      if(name==='../services/appointmentCalendarMutation.service')return {sendCalendarMutationError:()=>false};
      if(name==='../lib/role-helpers')return {ADMIN_USER_IDS:[],STAFF_ROLES:['personaldeclinica'],ADMIN_ROLES:[],INVITABLE_ROLES:[],
        ROLES_CLINICA:[],SUBROLES_CLINICA:[],ESTADO_CUENTA:[],ESTADO_INVITACION:[],isGlobalAdmin:()=>false};
      if(name==='./clinicOpeningHours.service')return {DEFAULT_TIME_ZONE:'Europe/Madrid',resolveClinicTimeZone:calendar.resolveClinicTimezone};
      return {};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(root,relative),'utf8'),context,{filename:relative});
  return module.exports;
}
function fixture({staleMember=false,receiving=true}={}){
  const clinics=[101,102,103,104].map(id=>({id_clinica:id,nombre_clinica:'QA '+id,
    grupoClinicaId:id===104?30:29,configuracion:{timezone:'Europe/Madrid'},horarios:[{id:1,activo:true}]}));
  const links=clinics.map((clinic,index)=>({id:501+index,doctor_id:9001,clinica_id:clinic.id_clinica,
    activo:true,recibe_citas:clinic.id_clinica===102?receiving:true,agenda_flexible:false,
    shared_schedule_source_id:index<2?501:null,clinica:clinic,horarios:[]}));
  const schedule=(id,pivot,start,end)=>({id,doctor_clinica_id:pivot,dia_semana:1,activo:true,hora_inicio:start,hora_fin:end,
    rrule:null,fecha_inicio_vigencia:'2026-10-26',fecha_fin_vigencia:'2026-12-31',created_at:'2026-10-01T00:00:00Z'});
  const schedules=[schedule(7001,501,'09:00','12:00'),schedule(7003,503,'14:00','16:00'),schedule(7004,504,'08:00','09:00')];
  if(staleMember)schedules.push(schedule(7002,502,'15:00','16:00'));
  const exceptions=[{id:8001,doctor_horario_id:7001,fecha:'2026-10-26',cancelado:false,hora_inicio_override:'10:00',hora_fin_override:'11:00'},
    {id:8002,doctor_horario_id:7001,fecha:'2026-11-02',cancelado:true}];
  const calls=[];
  const match=(row,where={})=>Object.entries(where).every(([key,value])=>{
    if(value&&typeof value==='object'){
      if(value[Op.in])return value[Op.in].map(Number).includes(Number(row[key]));
      if(value[Op.between])return row[key]>=value[Op.between][0]&&row[key]<=value[Op.between][1];
      return true;
    }
    return row[key]===value;
  });
  const fields=(row,query)=>query.attributes?Object.fromEntries(query.attributes.filter(key=>typeof key==='string'&&key in row).map(key=>[key,row[key]])):plain(row);
  const full=()=>links.map(link=>({...plain(link),horarios:schedules.filter(s=>s.doctor_clinica_id===link.id)
    .map(s=>({...plain(s),excepciones:plain(exceptions.filter(e=>e.doctor_horario_id===s.id))}))}));
  const db={Sequelize:{Op,literal:value=>value},sequelize:{escape:JSON.stringify},Clinica:{},Usuario:{},
    DoctorClinica:{findAll:async query=>{
      calls.push({model:'DoctorClinica',query});
      if(query.skipSharedScheduleProjection)return full().filter(row=>match(row,query.where));
      let rows=full().filter(row=>match(row,query.where));
      if(query.raw)return rows.map(row=>fields(row,query));
      const include=query.include?.find(item=>item.as==='horarios');
      if(include?.required)rows=rows.filter(row=>row.horarios.some(h=>h.activo));
      // Model doubles do not run Sequelize hooks; replay the real projection
      // before the real controller consumes its query result.
      return sharing.projectDoctorClinicas({db,rows});
    },findByPk:async id=>links.find(row=>row.id===Number(id))||null,
      findOne:async query=>links.find(row=>match(row,query.where))||null},
    PersonalCalendarRevision:{findByPk:async()=>({revision:'0'})},
    DoctorHorario:{findAll:async query=>{calls.push({model:'DoctorHorario',query});return schedules.filter(row=>match(row,query.where)).map(row=>fields(row,query));}},
    DoctorHorarioExcepcion:{findAll:async query=>exceptions.filter(row=>match(row,query.where)).map(row=>fields(row,query))},
    UsuarioClinica:{findOne:async()=>null,findAll:async query=>[{toJSON:()=>({id_usuario:9001,id_clinica:query.where.id_clinica,
      rol_clinica:'personaldeclinica',subrol_clinica:'Doctores',Usuario:{id_usuario:9001,nombre:'QA',apellidos:'Ficticio'}})}],count:async()=>1},
    PersonalPresenceEvent:{findAll:async()=>[]},Instalacion:{count:async()=>0},Tratamiento:{count:async()=>0},CitaPaciente:{count:async()=>0}};
  return {db,links,schedules,exceptions,calls,clinics,full};
}
async function selector(f,agendaContext,clinicIds=[102]){
  const c=load('src/controllers/doctores.controller.js',f.db);let result;
  await c.list({query:{agenda_context:String(agendaContext)},authorizedDoctorClinicIds:clinicIds},{json:value=>{result=value;}});
  return plain(result);
}
function dashboard(f){return load('src/services/panelesDashboard.service.js',f.db).__testing;}
function weekArgs(f,ids=[102]){return {clinicIds:ids,clinicMap:new Map(f.clinics.map(c=>[c.id_clinica,c])),userId:9001,todayIso:'2026-10-26'};}
async function presence(f,date='2026-10-26'){
  return load('src/services/personalPresence.service.js',f.db).__testing.buildPresenceRowsForClinic({clinicId:102,
    clinic:f.clinics[1],businessDate:date,now:new Date(date+'T12:00:00Z')});
}

test('legacy selector preserves a shared member with no physical schedule rows before projecting source readiness',async()=>{
  const f=fixture();const before=plain(f.full()),rows=await selector(f,false);
  const query=f.calls.find(c=>c.model==='DoctorClinica'&&!c.query.skipSharedScheduleProjection).query;
  assert.equal(query.include.find(i=>i.as==='horarios').required,false,'SQL must not discard the member before projection');
  assert.deepEqual(rows.map(r=>[r.id,r.clinica_id,r.has_schedule]),[['9001','102',true]]);
  assert.deepEqual(f.full(),before,'projection never mirrors source rows into member storage');
});
test('legacy selector still excludes an independent member with no active schedule',async()=>{
  const f=fixture();f.schedules.splice(f.schedules.findIndex(h=>h.doctor_clinica_id===503),1);
  assert.deepEqual(await selector(f,false,[103]),[]);
  f.schedules[0].activo=false;
  assert.deepEqual(await selector(f,false),[],'inactive source rows cannot make a shared member ready');
});
test('agenda selector uses effective source rows but keeps the target receives-appointments flag',async()=>{
  const f=fixture({receiving:false}),rows=await selector(f,true);
  assert.deepEqual(rows.map(r=>[r.clinica_id,r.has_schedule,r.recibe_citas,r.agendable]),[['102',true,false,false]]);
});
test('presence uses source exceptions and ignores stale raw member hours without moving the target clinic',async()=>{
  const f=fixture({staleMember:true}),result=await presence(f);
  assert.deepEqual(plain(result.rows.map(r=>[r.id,r.clinicId,r.expected,r.expected_minutes])),[['9001',102,'10:00-11:00',60]]);
  const query=f.calls.find(c=>c.model==='DoctorClinica'&&c.query.raw).query;
  assert(query.attributes.includes('shared_schedule_source_id'));
  assert.equal(f.schedules.find(r=>r.id===7002).hora_inicio,'15:00','physical member rows are not overwritten');
});
test('a cancelled source occurrence removes presence expectation despite an obsolete member pattern',async()=>{
  const result=await presence(fixture({staleMember:true}),'2026-11-02');
  assert.deepEqual(plain(result.rows.map(r=>[r.expected,r.expected_minutes])),[['Sin horario',0]]);
});
test('weekly dashboard expands source occurrences against each requested target clinic and keeps independent clinics separate',async()=>{
  const f=fixture({staleMember:true}),reader=dashboard(f),rows=await reader.loadWeeklySchedule(weekArgs(f,[102,103,104]));
  assert.deepEqual(plain(rows.map(r=>[r.clinicId,r.date,r.start,r.end])),[[102,'2026-10-26','10:00','11:00'],[103,'2026-10-26','14:00','16:00'],[104,'2026-10-26','08:00','09:00']]);
  assert.equal(f.schedules.find(h=>h.id===7001).doctor_clinica_id,501,'canonical schedule ownership stays at its source pivot');
});
test('weekly dashboard reads a fresh effective source on each request rather than retaining a projected calendar cache',async()=>{
  const f=fixture(),reader=dashboard(f),args=weekArgs(f);
  assert.equal((await reader.loadWeeklySchedule(args))[0].end,'11:00');
  f.exceptions[0].hora_fin_override='10:30';
  assert.equal((await reader.loadWeeklySchedule(args))[0].end,'10:30');
});
test('setup schedule readiness counts the effective shared source rather than an empty or obsolete local table',async()=>{
  const f=fixture({staleMember:true}),reader=dashboard(f),args={clinicIds:[102],groupIds:[29],clinics:[f.clinics[1]],whatsappStatus:{}};
  let result=await reader.loadSetupStatus(args);assert.equal(result.items.find(r=>r.id==='schedules').completed,true);
  f.schedules[0].activo=false;
  result=await reader.loadSetupStatus(args);assert.equal(result.items.find(r=>r.id==='schedules').completed,false,'stale local hours cannot complete setup');
});
test('empty weekly scope does not consult any model or sharing metadata',async()=>{
  const f=fixture(),rows=await dashboard(f).loadWeeklySchedule(weekArgs(f,[]));
  assert.deepEqual(plain(rows),[]);assert.equal(f.calls.length,0);
});

function response(){return {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
test('legacy schedule aliases delegate one request to canonical Personal and retain only the successful array body',async()=>{
  const f=fixture();let calls=0;
  const canonical={getHorariosClinica:async(req,res)=>{calls++;assert.equal(req.params.id,'9001');assert.equal(req.params.clinicaId,'102');return res.json({horarios:[{id:7001}],recibe_citas:true});},
    updateHorariosClinica:async(req,res)=>{calls++;assert.equal(req.params.id,'9001');assert.equal(req.params.clinicaId,'102');assert.equal(req.body.horarios[0].hora_inicio,'10:00');return res.status(201).json({horarios:[{id:7001}],undo:{token:'not-persisted-test-value'}});}};
  const c=load('src/controllers/doctores.controller.js',f.db,{'./personal.controller':canonical});
  for(const [method,params,body]of [['getHorarios',{doctorClinicaId:'502'},undefined],['updateHorarios',{doctorClinicaId:'502'},[{hora_inicio:'10:00'}]],
    ['updateHorariosClinica',{doctorId:'9001',clinicaId:'102'},{horarios:[{hora_inicio:'10:00'}]}]]){
    const req={params,body,userData:{userId:77},authorizedDoctorId:9001},res=response(),originalJson=res.json;
    await c[method](req,res);assert.deepEqual(plain(res.body),[{id:7001}]);assert.equal(req.params,params);assert.equal(req.body,body);assert.equal(res.json,originalJson);
    assert.equal(res.statusCode,method==='getHorarios'?200:201);
  }
  assert.equal(calls,3);
});
test('real canonical denial through legacy aliases keeps HTTP403 and performs no mutation or second transaction',async()=>{
  const f=fixture(),before=plain(f.full());let transactions=0,writes=0;
  f.db.sequelize.transaction=async()=>{transactions++;throw Error('Unexpected transaction');};
  f.db.DoctorHorario.destroy=async()=>{writes++;throw Error('Unexpected shadow write');};
  const canonical=load('src/controllers/personal.controller.js',f.db,{'../lib/access-policy':{canUserAccessFeature:async()=>false}});
  const c=load('src/controllers/doctores.controller.js',f.db,{'./personal.controller':canonical});
  for(const [method,params,body]of [['updateHorarios',{doctorClinicaId:'502'},[]],['updateHorariosClinica',{doctorId:'9001',clinicaId:'102'},{horarios:[]}]]){
    const req={params,body,userData:{userId:77},authorizedDoctorId:9001},res=response(),originalJson=res.json;
    await c[method](req,res);assert.equal(res.statusCode,403);assert.deepEqual(plain(res.body),{message:'Forbidden'});
    assert.equal(req.params,params);assert.equal(req.body,body);assert.equal(res.json,originalJson);
  }
  assert.equal(transactions,0);assert.equal(writes,0);assert.deepEqual(f.full(),before);
});
test('a failing canonical handler restores request and response methods before propagating its error',async()=>{
  const f=fixture(),failure=new Error('Fictional handler failure');
  const c=load('src/controllers/doctores.controller.js',f.db,{'./personal.controller':{getHorariosClinica:async()=>{throw failure;}}});
  const params={doctorClinicaId:'502'},body={untouched:true},req={params,body},res=response(),originalJson=res.json;
  await assert.rejects(c.getHorarios(req,res),error=>error===failure);
  assert.equal(req.params,params);assert.equal(req.body,body);assert.equal(res.json,originalJson);
});

async function legacyAvailability(f,query){
  f.db.DoctorClinica.findOne=async options=>{
    const row=f.full().find(row=>String(row.doctor_id)===String(options.where.doctor_id)
      &&(!options.where.clinica_id||String(row.clinica_id)===String(options.where.clinica_id)));
    return row?(await sharing.projectDoctorClinicas({db:f.db,rows:[row]}))[0]:null;
  };
  f.db.DoctorBloqueo={findAll:async()=>[]};
  f.db.Instalacion={findByPk:async()=>({id:99,clinica_id:102,activo:true,horarios:[{id:70,dia_semana:1,activo:true,hora_inicio:'07:00',hora_fin:'22:00'}]})};
  const reads=[],deps={'../services/appointmentResourceCalendar.service':{resourceAppointments:async options=>{reads.push(options);return [];},resourceInstallationBlocks:async()=>[]},
    '../lib/installation-professionals':{installationAllowsStaff:()=>true}};
  const c=load('src/controllers/doctores.controller.js',f.db,deps),res=response();
  await c.disponibilidad({query:{doctor_id:'9001',clinica_id:'102',...query}},res);
  return {res,reads};
}
test('legacy slots honour a biweekly source rule instead of advertising its off-week or obsolete member hours',async()=>{
  const f=fixture({staleMember:true});f.exceptions.splice(0);f.schedules[0].rrule='FREQ=WEEKLY;INTERVAL=2;BYDAY=MO';
  let result=await legacyAvailability(f,{fecha:'2026-10-26',slots:'true',duracion_min:'60'});
  assert.equal(result.res.statusCode,200);assert.equal(result.res.body.slots.length,3);
  result=await legacyAvailability(f,{fecha:'2026-11-02',slots:'true'});
  assert.deepEqual(plain(result.res.body.slots),[]);
});
test('legacy source exceptions apply equally to slots with a room and concrete range validation',async()=>{
  const f=fixture({staleMember:true});
  let result=await legacyAvailability(f,{fecha:'2026-10-26',slots:'true',duracion_min:'60'});
  assert.deepEqual(plain(result.res.body.slots),[{start:'2026-10-26T09:00:00.000Z',end:'2026-10-26T10:00:00.000Z'}]);
  result=await legacyAvailability(f,{fecha:'2026-11-02',slots:'true',instalacion_id:'99'});
  assert.deepEqual(plain(result.res.body.slots),[],'an empty doctor day must not fall back to room hours');
  result=await legacyAvailability(f,{inicio:'2026-11-02T09:00:00Z',fin:'2026-11-02T10:00:00Z'});
  assert.equal(result.res.statusCode,409);assert.equal(result.res.body.available,false);
});
test('legacy availability uses the clinic civil day and timezone for slot boundaries and ISO range validation',async()=>{
  const f=fixture();f.exceptions.splice(0);
  let result=await legacyAvailability(f,{fecha:'2026-10-26',slots:'true',duracion_min:'60'});
  assert.equal(result.res.body.slots[0].start,'2026-10-26T08:00:00.000Z');
  assert.equal(result.reads[0].start.toISOString(),'2026-10-25T23:00:00.000Z');
  assert.equal(result.reads[0].end.toISOString(),'2026-10-26T23:00:00.000Z');
  result=await legacyAvailability(f,{inicio:'2026-10-26T09:00:00+01:00',fin:'2026-10-26T10:00:00+01:00'});
  assert.equal(result.res.statusCode,200);assert.equal(result.res.body.available,true);
});
