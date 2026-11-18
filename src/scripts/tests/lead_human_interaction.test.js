'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectLatestInteraction, enrichHumanInteraction } = require('../../services/leadHumanInteraction.service');
const lead = { id: 7, clinica_id: 66, created_at: '2026-11-17T00:00:00Z' };
const now = new Date('2026-11-18T12:00:00Z');
const candidate = patch => ({ lead_id: 7, user_id: 44, occurred_at: '2026-11-18T10:00:00Z', kind: 'contact_attempt',
  channel: 'llamada', reason: 'no_contesta', ...patch });
test('latest actual work, not assignment, wins; a missed call remains a missed-call attempt', () => {
  assert.equal(selectLatestInteraction({ ...lead, asignado_a: 44, created_by: 44 }, [], now), null);
  assert.equal(selectLatestInteraction(lead, [candidate({ user_id: 12, occurred_at: '2026-11-18T11:00:00Z' }), candidate()], now).user_id, 12);
});
for (const [name, patch] of Object.entries({ no_actor: { user_id: null }, other_request: { lead_id: 8 },
  before_request: { occurred_at: '2026-11-16T00:00:00Z' }, future: { occurred_at: '2026-11-19T00:00:00Z' },
  auto_reply: { reason: 'lead_auto_reply:welcome' }, automation: { reason: 'automation_flow' },
  invalid_date: { occurred_at: 'invalid' } })) test(`rejects ${name}`, () => assert.equal(selectLatestInteraction(lead, [candidate(patch)], now), null));

function fixture({ attempts = [], messages = [], users = [{ id_usuario: 44, nombre: 'Directora', apellidos: 'Ficticia' }], settings = [] } = {}) {
  const calls = [];
  return { calls, models: {
    sequelize: { query: async (sql, options) => { calls.push({sql,options});return sql.includes('LeadContactAttempts a') ? attempts : messages; } },
    Usuario: { findAll: async options => { calls.push({users:options});return users; } },
    PatientDirectionSetting: { findAll: async () => settings },
    Clinica: { findAll: async () => [{id_clinica:66,configuracion:{timezone:'Europe/Madrid'}}] },
  } };
}
test('one bulk summary per page exposes name/time/meaning, with a rocket only for the actual director actor', async () => {
  const f = fixture({ attempts: [candidate()] });
  const result = await enrichHumanInteraction({ models:f.models, leads:[lead,{...lead,id:8}], now });
  assert.equal(result[0].last_human_interaction.user_name,'Directora Ficticia');
  assert.equal(result[0].last_human_interaction.outcome,'no_answer');
  assert.equal(result[0].last_human_interaction.is_patient_director,true);
  assert.equal(result[0].last_human_interaction.time_zone,'Europe/Madrid');
  assert.equal(result[1].last_human_interaction,null);
  assert.equal(f.calls.filter(call=>call.sql).length,2);
  assert.equal(f.calls.filter(call=>call.users).length,1);
  assert(!Object.hasOwn(lead,'last_human_interaction'));
});
test('a later manually-sent message wins, legacy-only contacts remain visible, and redacted records stay empty', async () => {
  const f=fixture({attempts:[candidate()],messages:[candidate({user_id:12,kind:'message',channel:'whatsapp',reason:'',occurred_at:'2026-11-18T11:00:00Z'})],
    users:[{id_usuario:12,nombre:'Persona',apellidos:'Prueba'},{id_usuario:13,nombre:'Legacy'}]});
  const rows=await enrichHumanInteraction({models:f.models,now,leads:[lead,{...lead,id:8,historial_contactos:[{usuario_id:13,fecha:'2026-11-18T11:10:00Z',motivo:'otro',canal:'email'}]},
    {...lead,id:9,privacy_redacted:true}]});
  assert.equal(rows[0].last_human_interaction.outcome,'sent');assert.equal(rows[0].last_human_interaction.is_patient_director,false);
  assert.equal(rows[1].last_human_interaction.user_name,'Legacy');assert.equal(rows[2].last_human_interaction,null);
});
test('ranking queries bind request and clinic, exclude automation/failures and never fetch patient content', async () => {
  const f=fixture();await enrichHumanInteraction({models:f.models,leads:[lead],now});
  const sql=f.calls.filter(call=>call.sql).map(call=>call.sql);
  for(const query of sql) { assert.match(query,/ROW_NUMBER\(\) OVER/);assert.match(query,/l\.clinica_id IN \(:clinicIds\)/);assert.match(query,/position = 1/); }
  assert.match(sql[1],/c\.lead_id = l\.id AND c\.clinic_id = l\.clinica_id/);
  assert.match(sql[1],/m\.status IN \('sent','delivered','read'\)/);
  for(const key of ['automation_delivery_key','execution_id','flow_execution_id','bulk_send_job_id','hide_from_quickchat']) assert(sql[1].includes(key));
  assert(!/m\.content|a\.notas|contact_id|telefono/.test(sql.join(' ')));
});
test('redacted-only or empty pages perform no activity queries', async () => {
  const f=fixture();assert.deepEqual(await enrichHumanInteraction({models:f.models,leads:[],now}),[]);
  const [result]=await enrichHumanInteraction({models:f.models,leads:[{...lead,privacy_redacted:true}],now});
  assert.equal(result.last_human_interaction,null);assert.equal(f.calls.length,0);
});

test('accessory summary failures stay visibly unknown without discarding principal lead data or logging patient content', async () => {
  const f=fixture(), logs=[];f.models.sequelize.query=async()=>{throw Object.assign(Error('secret patient details'),{code:'ER_NO_SUCH_TABLE'});};
  const [result]=await enrichHumanInteraction({models:f.models,leads:[lead],now,logger:{warn:(...args)=>logs.push(args)}});
  assert.equal(result.id,lead.id);assert.equal(result.human_interaction_status,'unavailable');assert.equal(result.last_human_interaction,null);
  assert(!JSON.stringify(logs).includes('secret'));assert.equal(logs[0][1].code,'ER_NO_SUCH_TABLE');
});
