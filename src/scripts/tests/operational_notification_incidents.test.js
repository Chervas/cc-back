'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentNotifier, identity, notificationDecision } = require('../../lib/operationalNotificationIncidents');
const migration = require('../../../migrations/20261003090000-operational-notification-incidents');
const start = Date.parse('2026-10-03T10:00:00Z');
const alert = (scope = 'clinic:72', severity = 'critical') => ({ eventKey: 'whatsapp.reception_attention',
  payload: { severity, title: 'Ficticia: eventos retenidos', detail: '4 mensajes entrantes; 6 ecos del movil.',
    action: 'Revision tecnica.', occurredAt: new Date(start - 86400000).toISOString() },
  metadata: { incident_scope: scope, incident_impact: ['inbox_reception_delayed', 'incoming_messages', 'mobile_echoes'] } });
function fixture() {
  let time = start, tail = Promise.resolve(), fail = false, enabled = ['panel', 'email'];
  const rows = new Map(), deliveries = [];
  const row = key => { const value = rows.get(key); return value && { ...value,
    update: async patch => rows.set(key, { ...rows.get(key), ...structuredClone(patch) }) }; };
  const sequelize = { query: async (sql,{replacements:p}) => {
    assert.match(sql,/ON DUPLICATE KEY UPDATE incident_key=incident_key/);
    if (!rows.has(p.key)) rows.set(p.key,{incident_key:p.key,namespace:p.namespace,event_key:p.eventKey,
      scope_key:p.scope,state:'new',severity:p.severity,opened_at:p.opened,observed_at:p.observed,
      snapshot:JSON.parse(p.snapshot),channel_state:{}});
  }, transaction: async (options, action) => {
    assert.equal(options.isolationLevel,'READ COMMITTED');
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    const before = structuredClone(rows), count = deliveries.length;
    try { return await action({ LOCK: { UPDATE: 'UPDATE' } }); }
    catch (error) { rows.clear(); for (const [key,value] of before) rows.set(key,value); deliveries.length = count; throw error; }
    finally { release(); }
  } };
  const Incident = { findByPk: async key => row(key), findAll: async ({ where }) => [...rows.keys()].map(row)
    .filter(value => value.namespace === where.namespace && value.state === where.state) };
  const create = namespace => createIncidentNotifier({ sequelize, Incident, namespace,
    now: () => time, channels: () => enabled, queue: async request => {
      assert(request.transaction); assert.equal(request.force,true);
      const created = Object.entries(request.channelsOverride).filter(([,value])=>value).map(([channel])=>({channel}));
      deliveries.push(...created.map(value=>({ ...value, metadata: request.metadata, payload: request.payload })));
      if (fail) throw Error('synthetic_outbox_failure');
      return { created, skipped: [] };
    } });
  return { create, rows, deliveries, advance: ms => { time += ms; }, fail: value => { fail=value; }, channels: value => { enabled=value; } };
}
test('identities are per clinic, account, event and runtime, never patient content', () => {
  assert.notEqual(identity(alert(),'dev'),identity(alert(),'staging'));
  assert.notEqual(identity(alert(),'staging'),identity(alert('clinic:66'),'staging'));
  assert.throws(()=>identity({...alert(),metadata:{}},'staging'));
  const a=alert(), previous=notificationDecision(null,a,'open',start);
  assert.equal(notificationDecision({...previous,at:start},{...a,payload:{...a.payload,detail:'Changed count'}},'open',start+3600000).notify,false);
});
test('restart and concurrent sweeps cannot repeat hourly; critical reminder is six hours', async () => {
  const f=fixture(); await Promise.all([f.create('staging').sync([alert()]),f.create('staging').sync([alert()])]);
  assert.equal(f.deliveries.length,2); f.advance(65*60000); await f.create('staging').sync([alert()]);
  assert.equal(f.deliveries.length,2); f.advance(295*60000); await f.create('staging').sync([alert()]);
  assert.equal(f.deliveries.length,4);
  assert.equal(f.deliveries[2].payload.occurredAt,new Date(start-86400000).toISOString());
});
test('warnings remind daily, material escalation immediately, another clinic independently', async () => {
  const f=fixture(), n=f.create('staging'); await n.sync([alert('clinic:72','warning')]);
  f.advance(6*3600000); await n.sync([alert('clinic:72','warning')]); assert.equal(f.deliveries.length,2);
  await n.sync([alert()]); assert.equal(f.deliveries.length,4);
  await n.sync([alert(),alert('clinic:66')]); assert.equal(f.deliveries.length,6);
  const w=fixture(); await w.create('dev').sync([alert('clinic:72','warning')]);
  w.advance(24*3600000); await w.create('dev').sync([alert('clinic:72','warning')]); assert.equal(w.deliveries.length,4);
});
test('failed enqueue rolls back incident and jobs so a later sweep can retry', async () => {
  const f=fixture();f.fail(true); await assert.rejects(f.create('staging').sync([alert()]),/synthetic_outbox/);
  assert.equal(f.rows.size,0);assert.equal(f.deliveries.length,0);f.fail(false);
  await f.create('staging').sync([alert()]);assert.equal(f.deliveries.length,2);
});
test('no recovery from mere absence or a failed check; confirmed closure once and reopening once', async () => {
  const f=fixture(),n=f.create('staging');await n.sync([alert()]);
  await n.sync([]);await n.sync([],{resolution:async()=>null});assert.equal(f.deliveries.length,2);
  const resolution=async()=>({severity:'info',title:'Comprobacion restablecida',detail:'No requiere accion.',action:'Sin reproduccion.'});
  f.advance(1000);await n.sync([],{resolution});await n.sync([],{resolution});assert.equal(f.deliveries.length,4);
  assert.equal(f.deliveries[3].metadata.incident_phase,'closed');
  assert.equal(f.deliveries[3].metadata.operational_summary,'No requiere accion.');
  await n.sync([alert()]);assert.equal(f.deliveries.length,6);
});
test('disabled channels do not consume the enabled-channel delivery clock',async()=>{
  const f=fixture();f.channels(['panel']);await f.create('staging').sync([alert()]);assert.equal(f.deliveries.length,1);
  f.channels(['panel','email']);await f.create('staging').sync([alert()]);assert.equal(f.deliveries.length,2);
  assert.equal(f.deliveries[1].channel,'email');
});
test('migration can resume after a partial application and never destroys historical evidence',async()=>{
  const tables=[],indexes=[],columns={};let changes=0;
  const qi={showAllTables:async()=>tables,createTable:async name=>{tables.push(name);changes++;},
    showIndex:async()=>indexes,addIndex:async(_,__,options)=>{indexes.push(options);changes++;},
    describeTable:async()=>columns,addColumn:async(_,name)=>{columns[name]={};changes++;}};
  await migration.up(qi);assert.equal(changes,4);await migration.up(qi);assert.equal(changes,4);
  await assert.rejects(migration.down(),/Preserve/);
});
