'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharing = require('../../services/personalScheduleSharing.service');
const clone = value => JSON.parse(JSON.stringify(value));
const Op = { in: Symbol('in') };
const checkAll = async () => true;
function fixture() {
  let state = { links: [10,20,30].map((clinica_id, i) => ({ id: 201 + i, doctor_id: 7, clinica_id, activo: true,
    recibe_citas: i !== 2, shared_schedule_source_id: null, agenda_flexible: false,
    clinica: { id_clinica: clinica_id, nombre_clinica: 'Clinic' + clinica_id, grupoClinicaId: 50, configuracion: { timezone: 'Europe/Madrid' } } })),
    schedules: [{ id: 101, doctor_clinica_id: 201, dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '12:00',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4', fecha_inicio_vigencia: '2027-01-04', fecha_fin_vigencia: '2027-02-22', created_at: '2026-09-01T00:00:00.000Z' },
    { id: 102, doctor_clinica_id: 202, dia_semana: 1, activo: true, hora_inicio: '15:00', hora_fin: '18:00', rrule: null }],
    exceptions: [{ id: 901, doctor_horario_id: 101, fecha: '2027-01-18', cancelado: true, hora_inicio_override: null, hora_fin_override: null },
      { id: 902, doctor_horario_id: 101, fecha: '2027-02-01', cancelado: false, hora_inicio_override: '10:00', hora_fin_override: '11:30' }],
    revision: '0', nextId: 2000 };
  const calls = { writes: 0, lookups: 0, permissionScopes: [], reads: [] };
  const transaction = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' } };
  const matches = (row, where) => Reflect.ownKeys(where || {}).every(key => {
    const expected = where[key]; return expected && typeof expected === 'object' && expected[Op.in]
      ? expected[Op.in].map(Number).includes(Number(row[key])) : (row[key] ?? null) === expected;
  });
  const schedules = id => state.schedules.filter(row => row.doctor_clinica_id === id).map(row => ({ ...clone(row),
    excepciones: clone(state.exceptions.filter(item => item.doctor_horario_id === row.id)) }));
  const write = options => { assert.equal(options.transaction, transaction); calls.writes++; };
  const db = { Sequelize: { Op }, Clinica: {}, DoctorHorarioExcepcion: {
    destroy: async options => { write(options); state.exceptions = state.exceptions.filter(row => !matches(row, options.where)); },
    bulkCreate: async (rows, options) => { write(options); state.exceptions.push(...rows.map(row => ({ id: state.nextId++, ...clone(row) }))); },
  }, DoctorClinica: {
    findAll: async options => {
      assert.equal(options.skipSharedScheduleProjection, true); calls.lookups++; calls.reads.push(options);
      return state.links.filter(row => matches(row, options.where)).map(row => ({ ...clone(row), horarios: schedules(row.id) }));
    },
    update: async (fields, options) => { write(options); let count = 0;
      state.links.filter(row => matches(row, options.where)).forEach(row => { Object.assign(row, clone(fields)); count++; }); return [count]; },
  }, DoctorHorario: {
    findAll: async options => state.schedules.filter(row => matches(row, options.where)).map(clone),
    destroy: async options => { write(options); state.schedules = state.schedules.filter(row => !matches(row, options.where)); },
    create: async (fields, options) => { write(options); const row = { id: state.nextId++, ...clone(fields) }; state.schedules.push(row); return clone(row); },
  }, PersonalCalendarRevision: { findByPk: async () => ({ revision: state.revision }) } };
  const base = { db, doctorId: 7, checkAll: async scope => { calls.permissionScopes.push(scope.clinicIds); return true; } };
  const input = patch => ({ operation: 'link', source_clinica_id: 10, clinic_ids: [10,20], expected_revision: state.revision, same_site_confirmed: true, ...patch });
  const preview = value => sharing.previewScheduleSharing({ ...base, input: value || input() });
  const apply = async (value, overrides = {}) => {
    const before = clone(state);
    try { return await sharing.applyScheduleSharing({ ...base, transaction, input: value, ...overrides }); }
    catch (error) { state = before; throw error; }
  };
  const link = async patch => { const value = input(patch), reviewed = await preview(value); return apply({ ...value, preview_hash: reviewed.preview_hash }); };
  return { db, calls, transaction, base, input, preview, apply, link, state: () => state, schedules };
}
test('preview reports actual recurrence, dates and exceptions; link archives target rows and projects one source', async () => {
  const f = fixture(), before = clone(f.state()), plan = await f.preview();
  assert.equal(plan.differences.find(row => row.clinica_id === 20).has_differences, true);
  assert.equal(plan.differences[0].source_horarios[0].rrule, before.schedules[0].rrule);
  assert.equal(plan.differences[0].source_horarios[0].excepciones[1].hora_inicio_override, '10:00');
  await f.apply({ ...f.input(), preview_hash: plan.preview_hash });
  assert.deepEqual(f.state().schedules, before.schedules); assert.deepEqual(f.state().exceptions, before.exceptions);
  assert.deepEqual(f.state().links.slice(0,2).map(row => row.shared_schedule_source_id), [201,201]);
  const rows = f.state().links.map(row => ({ ...row, horarios: f.schedules(row.id) }));
  const projected = await sharing.projectDoctorClinicas({ db: f.db, rows });
  assert.equal(projected[1].id, 202); assert.equal(projected[1].horarios[0].id, 101);
  assert.equal(projected[1].horarios[0].excepciones.length, 2);
  assert.deepEqual(projected[1].shared_schedule.clinic_ids, [10,20]);
  assert.equal(f.state().revision, '0', 'Only the outer calendar mutation bumps revision');
});
test('unlinked rows with an explicit null skip source lookups; omitted metadata is fetched instead of silently falling back', async () => {
  const f = fixture();
  await sharing.projectDoctorClinicas({ db: f.db, rows: [f.state().links[0]] }); assert.equal(f.calls.lookups, 0);
  await f.link();
  const projected = await sharing.projectDoctorClinicas({ db: f.db, rows: [{ id: 202, doctor_id: 7, horarios: [] }] });
  assert.equal(projected[0].horarios[0].hora_inicio, '09:00'); assert.equal(projected[0].shared_schedule_source_id, 201);
  const withoutDoctor = await sharing.projectDoctorClinicas({ db: f.db, rows: [{ id: 202, horarios: [] }] });
  assert.equal(withoutDoctor[0].horarios[0].id, 101);
});
test('a batch of32 doctors with two member clinics each uses one lookup; the31-member cap is per group', async () => {
  const rows=Array.from({length:32},(_,index)=>{
    const doctor_id=100+index,source=1000+index*2;
    return [10,20].map((clinica_id,member)=>({id:source+member,doctor_id,clinica_id,activo:true,shared_schedule_source_id:source,
      clinica:{id_clinica:clinica_id,nombre_clinica:'Owned clinic'+clinica_id,grupoClinicaId:50,configuracion:{timezone:'Europe/Madrid'}},
      horarios:member?[]:[{id:5000+index,doctor_clinica_id:source,dia_semana:1,activo:true,hora_inicio:'09:00',hora_fin:'10:00',excepciones:[]}]}));
  }).flat();
  let lookups=0;
  const db={Sequelize:{Op},Clinica:{},DoctorHorario:{},DoctorHorarioExcepcion:{},DoctorClinica:{findAll:async query=>{
    lookups++;assert.equal(query.skipSharedScheduleProjection,true);assert.equal(query.where.doctor_id[Op.in].length,32);return clone(rows);
  }}};
  const projected=await sharing.projectDoctorClinicas({db,rows:rows.filter((_,index)=>index%2)});
  assert.equal(lookups,1);assert.equal(projected.length,32);
  assert(projected.every((row,index)=>row.horarios[0].id===5000+index&&row.shared_schedule.clinic_ids.length===2));
});
test('stale revision, changed archived state, missing preview and missing outer transaction fail before writes', async () => {
  for (const kind of ['revision', 'raw_change', 'preview', 'transaction']) {
    const f = fixture(), value = f.input(), plan = await f.preview(value);
    let input = { ...value, preview_hash: plan.preview_hash };
    if (kind === 'revision') f.state().revision = '1';
    if (kind === 'raw_change') f.state().schedules[1].hora_fin = '19:00';
    if (kind === 'preview') delete input.preview_hash;
    await assert.rejects(f.apply(input, kind === 'transaction' ? { transaction: null } : {}),
      { code: 'personal_schedule_sharing_' + ({ revision: 'revision_conflict', raw_change: 'preview_changed', preview: 'preview_required', transaction: 'transaction_required' }[kind]) });
    assert.equal(f.calls.writes, 0);
  }
});
test('permissions are rechecked for every affected clinic before any write', async () => {
  const f = fixture(), input = f.input(), plan = await f.preview(input);
  await assert.rejects(f.apply({ ...input, preview_hash: plan.preview_hash }, { checkAll: async scope => {
    assert.deepEqual(scope.clinicIds, [10,20]); return false;
  } }), { code: 'personal_schedule_sharing_forbidden' }); assert.equal(f.calls.writes, 0);
});
test('apply locks only bare membership IDs, never the Clinic association join after the doctor mutex', async () => {
  const f=fixture(), input=f.input(), plan=await f.preview(input);f.calls.reads=[];
  await f.apply({...input,preview_hash:plan.preview_hash});
  const locking=f.calls.reads.filter(query=>query.lock);
  assert.equal(locking.length,1);assert.equal(locking[0].include,undefined);
  assert.deepEqual(locking[0].attributes,['id']);assert.equal(locking[0].transaction,f.transaction);
  assert(f.calls.reads.filter(query=>query.include).every(query=>query.lock===undefined));
});
test('link rejects inactive, cross-group, cross-timezone and unconfirmed sites without altering flags', async () => {
  for (const kind of ['inactive','group','timezone','site']) {
    const f = fixture(), input = f.input();
    if (kind === 'inactive') f.state().links[1].activo = false;
    if (kind === 'group') f.state().links[1].clinica.grupoClinicaId = 99;
    if (kind === 'timezone') f.state().links[1].clinica.configuracion.timezone = 'Atlantic/Canary';
    if (kind === 'site') input.same_site_confirmed = false;
    await assert.rejects(f.preview(input), { code: 'personal_schedule_sharing_' + ({ inactive:'inactive',group:'group_mismatch',timezone:'timezone_mismatch',site:'same_site_required' }[kind]) });
    assert.equal(f.calls.writes, 0);
  }
});
test('chains, missing/cross-doctor sources, singleton sources and corrupt group metadata fail closed', async () => {
  for (const kind of ['chain','missing','doctor','singleton','group']) {
    const f = fixture(), rows = f.state().links;
    rows[0].shared_schedule_source_id = 201; rows[1].shared_schedule_source_id = 201;
    if (kind === 'chain') rows[0].shared_schedule_source_id = 203;
    if (kind === 'missing') rows[0].shared_schedule_source_id = 999;
    if (kind === 'doctor') rows[0].doctor_id = 8;
    if (kind === 'singleton') rows[1].shared_schedule_source_id = null;
    if (kind === 'group') rows[1].clinica.grupoClinicaId = 99;
    await assert.rejects(sharing.getScheduleSharing(f.base), { code: 'personal_schedule_sharing_invalid' });
  }
});
test('unlink member replaces obsolete raw schedule with complete effective recurrence and exceptions', async () => {
  const f = fixture(); await f.link(); const original = clone(f.schedules(201));
  const input = f.input({ operation:'unlink',source_clinica_id:10,clinic_ids:[20],same_site_confirmed:false });
  const plan = await f.preview(input); await f.apply({ ...input, preview_hash: plan.preview_hash });
  assert.deepEqual(f.state().links.slice(0,2).map(row => row.shared_schedule_source_id), [null,null]);
  assert.equal(sharing.calendarSignature(f.schedules(202)), sharing.calendarSignature(original));
  assert.equal(f.schedules(202)[0].hora_inicio, '09:00'); assert.equal(f.schedules(202)[0].created_at, original[0].created_at);
  assert.equal(f.schedules(202)[0].excepciones.length, 2); assert.equal(f.state().schedules.some(row => row.id === 102), false);
  assert.equal(f.state().links[1].recibe_citas, true); assert.equal(f.state().links[2].recibe_citas, false);
});
test('unlink source reanchors remaining members preserving their effective calendar', async () => {
  const f = fixture(); await f.link({ clinic_ids:[10,20,30] });
  const input=f.input({operation:'unlink',clinic_ids:[10],same_site_confirmed:false}), plan=await f.preview(input);
  await f.apply({...input,preview_hash:plan.preview_hash});
  assert.deepEqual(f.state().links.map(row=>row.shared_schedule_source_id),[null,202,202]);
  const rows=await sharing.projectDoctorClinicas({db:f.db,rows:f.state().links});
  assert.equal(rows[2].horarios[0].hora_inicio,'09:00'); assert.equal(rows[2].horarios[0].excepciones.length,2);
});
test('unlink all materializes calendars; changing source within a group never revives archived raw hours', async () => {
  const f = fixture(); await f.link(); await f.link({source_clinica_id:20});
  assert.deepEqual(f.state().links.slice(0,2).map(row=>row.shared_schedule_source_id),[202,202]);
  assert.equal(f.schedules(202)[0].hora_inicio,'09:00');
  const input=f.input({operation:'unlink',source_clinica_id:20,clinic_ids:[10,20],same_site_confirmed:false}), plan=await f.preview(input);
  await f.apply({...input,preview_hash:plan.preview_hash});
  assert.deepEqual(f.state().links.slice(0,2).map(row=>row.shared_schedule_source_id),[null,null]);
  assert.equal(sharing.calendarSignature(f.schedules(201)),sharing.calendarSignature(f.schedules(202)));
});
test('partial groups, empty unlink, unsafe revisions and excessive groups are rejected', async () => {
  const f=fixture();await f.link({clinic_ids:[10,20,30]});
  await assert.rejects(f.preview(f.input()),{code:'personal_schedule_sharing_partial_group'});
  for(const patch of [{operation:'unlink',clinic_ids:[]},{expected_revision:0},{expected_revision:'01'},{clinic_ids:Array.from({length:32},(_,i)=>i+1)}])
    await assert.rejects(f.preview(f.input(patch)),{code:'personal_schedule_sharing_request_invalid'});
});
test('IDs reject booleans, arrays, null and whitespace before any write', async () => {
  for (const invalid of [true, [], [1], null, ' ']) {
    const f=fixture();
    await assert.rejects(f.preview(f.input({source_clinica_id:invalid})),{code:'personal_schedule_sharing_request_invalid'});
    await assert.rejects(f.preview(f.input({clinic_ids:[10,invalid]})),{code:'personal_schedule_sharing_request_invalid'});
    assert.equal(f.calls.writes,0);
  }
});
test('preview rejects a replicated response larger than one MiB without changing calendars', async () => {
  const f=fixture(), base=clone(f.state().links[0]);
  f.state().links=Array.from({length:31},(_,i)=>({...clone(base),id:201+i,clinica_id:10+i,
    clinica:{...clone(base.clinica),id_clinica:10+i,nombre_clinica:'Owned clinic'+i}}));
  const source=clone(f.state().schedules[0]);
  f.state().schedules=Array.from({length:200},(_,i)=>({...clone(source),id:10000+i,rrule:'FREQ=WEEKLY;INTERVAL=2;COUNT=4'}));
  f.state().exceptions=[];
  await assert.rejects(f.preview(f.input({clinic_ids:f.state().links.map(row=>row.clinica_id)})),{code:'personal_schedule_sharing_review_required'});
  assert.equal(f.calls.writes,0);
});
test('a materialization failure rolls back rows and pointers inside the caller transaction', async () => {
  const f=fixture();await f.link();const input=f.input({operation:'unlink',clinic_ids:[20],same_site_confirmed:false}), plan=await f.preview(input), before=clone(f.state());
  f.db.DoctorHorarioExcepcion.bulkCreate=async()=>{throw Error('owned clone failure');};
  await assert.rejects(f.apply({...input,preview_hash:plan.preview_hash}),/owned clone failure/);
  assert.deepEqual(f.state(),before);
});
test('additive migration defaults to null and refuses down while any calendar remains linked', async () => {
  const migration=require('../../../migrations/20261026150000-add-personal-shared-calendar');
  const calls=[],D={INTEGER:Symbol('INTEGER')};
  await migration.up({addColumn:async(...args)=>calls.push(args)},D);
  assert.deepEqual(calls[0],['DoctorClinicas','shared_schedule_source_id',{type:D.INTEGER,allowNull:true,defaultValue:null}]);
  let removed=false;
  await assert.rejects(migration.down({sequelize:{query:async()=>[[{n:1}]]},removeColumn:async()=>{removed=true;}}),/requires_unlinked/);
  assert.equal(removed,false);
  await migration.down({sequelize:{query:async()=>[[{n:0}]]},removeColumn:async()=>{removed=true;}});assert.equal(removed,true);
});
test('availability comparison ignores audit timestamps while exact plan CAS still binds the stored state', () => {
  const f=fixture(), original=f.schedules(201), changed=clone(original);
  changed[0].created_at='2020-01-01T00:00:00Z';changed[0].updated_at='2021-01-01T00:00:00Z';
  assert.equal(sharing.calendarSignature(original),sharing.calendarSignature(changed));
  changed[0].excepciones[0].cancelado=false;
  assert.notEqual(sharing.calendarSignature(original),sharing.calendarSignature(changed));
});
test('afterFind projects instances without recursion and keeps Sequelize hasMany serialization valid', async () => {
  const S=require('sequelize'),sql=new S({dialect:'mysql',logging:false});
  const Clinic=sql.define('Clinica',{id_clinica:{type:S.INTEGER,primaryKey:true},nombre_clinica:S.STRING,grupoClinicaId:S.INTEGER,configuracion:S.JSON},{timestamps:false});
  const DC=require('../../../models/doctorclinica')(sql,S.DataTypes),H=require('../../../models/doctorhorario')(sql,S.DataTypes),E=require('../../../models/doctorhorarioexcepcion')(sql,S.DataTypes);
  DC.belongsTo(Clinic,{as:'clinica',foreignKey:'clinica_id',targetKey:'id_clinica'});DC.hasMany(H,{as:'horarios',foreignKey:'doctor_clinica_id'});H.hasMany(E,{as:'excepciones',foreignKey:'doctor_horario_id'});
  const f=fixture();await f.link();
  const include=[{model:Clinic,as:'clinica'},{model:H,as:'horarios',include:[{model:E,as:'excepciones'}]}];
  const buildRows=()=>f.state().links.map(row=>DC.build({...row,horarios:f.schedules(row.id)},{isNewRecord:false,include}));
  const rows=buildRows();
  const transaction={LOCK:{UPDATE:'UPDATE'}};
  let lookups=0;DC.findAll=async options=>{assert.equal(options.skipSharedScheduleProjection,true);assert.equal(options.transaction,transaction);lookups++;return buildRows();};
  const target=rows[1];delete target.dataValues.shared_schedule_source_id;
  await DC.runHooks('afterFind',[target],{transaction});
  assert.equal(lookups,1);assert.equal(target.id,202);assert.equal(target.horarios[0].id,101);
  assert.equal(target.shared_schedule_source_id,201);
  assert.equal(target.toJSON().horarios[0].excepciones.length,2);assert.equal(target.toJSON().shared_schedule.source_clinica_id,10);
  await DC.runHooks('afterFind',[target],{skipSharedScheduleProjection:true});assert.equal(lookups,1);
  target.activo=false;
  const code={code:'personal_schedule_sharing_unlink_required'};
  await assert.rejects(DC.runHooks('beforeUpdate',target,{}),code);
  await assert.rejects(DC.runHooks('beforeDestroy',target,{}),code);
  DC.findOne=async options=>{assert.equal(options.skipSharedScheduleProjection,true);return target;};
  await assert.rejects(DC.runHooks('beforeBulkUpdate',{attributes:{activo:false},where:{doctor_id:7}}),code);
  await assert.rejects(DC.runHooks('beforeBulkUpdate',{attributes:{activo:null},where:{doctor_id:7}}),code);
  await assert.rejects(DC.runHooks('beforeBulkDestroy',{where:{doctor_id:7}}),code);
  await DC.runHooks('beforeBulkUpdate',{attributes:{shared_schedule_source_id:null},where:{doctor_id:7}});
  DC.findOne=async()=>null;
  const independent=rows[2];independent.activo=false;
  await DC.runHooks('beforeUpdate',independent,{});await DC.runHooks('beforeDestroy',independent,{});
  await sql.close();
});
