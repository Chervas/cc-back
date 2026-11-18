'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectFirstInteraction, selectLatestInteraction, enrichHumanInteraction } = require('../../services/leadHumanInteraction.service');
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

function fixture({ attempts = [], messages = [], appointments = [], actions = [], users = [{ id_usuario: 44, nombre: 'Directora', apellidos: 'Ficticia' }], settings = [] } = {}) {
  const calls = [];
  return { calls, models: {
    sequelize: { query: async (sql, options) => { calls.push({sql,options});return sql.includes('LeadContactAttempts a') ? attempts : sql.includes('CitasPacientes a') ? appointments : sql.includes('LeadAttributionAudits a') ? actions : messages; } },
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
  assert.equal(result[1].last_human_interaction,null);assert.equal(result[1].first_human_interaction,null);
  assert.equal(f.calls.filter(call=>call.sql).length,4);
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
  assert.equal(result.last_human_interaction,null);assert.equal(result.first_human_interaction,null);assert.equal(f.calls.length,0);
});

test('accessory summary failures stay visibly unknown without discarding principal lead data or logging patient content', async () => {
  const f=fixture(), logs=[];f.models.sequelize.query=async()=>{throw Object.assign(Error('secret patient details'),{code:'ER_NO_SUCH_TABLE'});};
  const [result]=await enrichHumanInteraction({models:f.models,leads:[lead],now,logger:{warn:(...args)=>logs.push(args)}});
  assert.equal(result.id,lead.id);assert.equal(result.human_interaction_status,'unavailable');assert.equal(result.last_human_interaction,null);assert.equal(result.first_human_interaction,null);
  assert(!JSON.stringify(logs).includes('secret'));assert.equal(logs[0][1].code,'ER_NO_SUCH_TABLE');
});


test('the first actor remains the manager who started the request while the last actor can change', async () => {
  const f=fixture({attempts:[candidate()],messages:[candidate({user_id:12,kind:'message',channel:'whatsapp',reason:'',outcome:'sent',occurred_at:'2026-11-18T11:00:00Z'})],
    users:[{id_usuario:44,nombre:'Graci'},{id_usuario:12,nombre:'Lidia'}]});
  const [row]=await enrichHumanInteraction({models:f.models,leads:[lead],now});
  assert.equal(row.first_human_interaction.user_name,'Graci');assert.equal(row.first_human_interaction.outcome,'no_answer');
  assert.equal(row.last_human_interaction.user_name,'Lidia');assert.equal(row.last_human_interaction.outcome,'sent');
  assert.equal(row.first_human_interaction.is_patient_director,true);assert.equal(row.last_human_interaction.is_patient_director,false);
});
test('a manually booked appointment counts at creation, not its later automated confirmation', async () => {
  const f=fixture({appointments:[candidate({kind:'appointment',channel:'agenda',reason:'',outcome:'scheduled',occurred_at:'2026-11-18T09:28:33Z'})]});
  const [row]=await enrichHumanInteraction({models:f.models,leads:[lead],now});
  assert.equal(row.first_human_interaction.kind,'appointment');assert.equal(row.first_human_interaction.outcome,'scheduled');
  assert.equal(row.last_human_interaction.occurred_at,'2026-11-18T09:28:33.000Z');
  const sql=f.calls.find(x=>x.sql?.includes('FROM CitasPacientes a')).sql;
  assert.match(sql,/a\.created_by AS user_id/);assert.match(sql,/a\.created_at AS occurred_at/);assert(!/updated_by|updated_at/.test(sql));
  for(const value of ['source_system','import_metadata','is_automated','flow_execution_id','cliniccloud'])assert(sql.includes(value));
});
test('authenticated discard and take decisions are human management, not automatic assignment', async () => {
  const f=fixture({actions:[candidate({kind:'lead_action',channel:'gestion',reason:'',outcome:'claimed',occurred_at:'2026-11-18T09:00:00Z'}),
    candidate({kind:'lead_action',channel:'gestion',reason:'',outcome:'discarded',occurred_at:'2026-11-18T10:00:00Z'})]});
  const [row]=await enrichHumanInteraction({models:f.models,leads:[{...lead,asignado_a:99}],now});
  assert.equal(row.first_human_interaction.outcome,'claimed');assert.equal(row.last_human_interaction.outcome,'discarded');
  const sql=f.calls.find(x=>x.sql?.includes('FROM LeadAttributionAudits a')).sql;
  for(const value of ['status_update','raw_payload','previous_status','actor_user_id','clinic_id','lead_patient_attention_v1'])assert(sql.includes(value));
  assert(!/asignado_a|updated_by/.test(sql));
});
test('every source returns both chronological ends and page size does not add queries', async () => {
  const f=fixture();await enrichHumanInteraction({models:f.models,leads:Array.from({length:50},(_,i)=>({...lead,id:i+1})),now});
  const queries=f.calls.filter(x=>x.sql);assert.equal(queries.length,4);
  for(const {sql}of queries){assert.match(sql,/ORDER BY occurred_at ASC, source_id ASC/);assert.match(sql,/ORDER BY occurred_at DESC, source_id DESC/);assert.match(sql,/first_position = 1 OR last_position = 1/);}
});
test('first and last selectors reject missing actors, automatic activity, other requests and dates outside the request',()=>{
  for(const row of[candidate({user_id:null}),candidate({lead_id:8}),candidate({reason:'automation_v2'}),candidate({occurred_at:'2026-11-16T00:00:00Z'}),candidate({occurred_at:'2026-11-19T00:00:00Z'})]){
    assert.equal(selectFirstInteraction(lead,[row],now),null);assert.equal(selectLatestInteraction(lead,[row],now),null);
  }
  assert.equal(selectFirstInteraction({...lead,privacy_redacted:true},[candidate()],now),null);
  assert.equal(selectLatestInteraction({...lead,privacy_redacted:true},[candidate()],now),null);
});

test('a canonical chat retaining request A never attributes the explicit ad-sharing request B to A', async () => {
  const requestB={...lead,id:8};
  const f=fixture({attempts:[candidate({lead_id:8,user_id:12,kind:'contact_attempt',reason:'whatsapp_template_sent'})],
    users:[{id_usuario:12,nombre:'Synthetic B actor'}]});
  const [a,b]=await enrichHumanInteraction({models:f.models,leads:[lead,requestB],now});
  assert.equal(a.first_human_interaction,null);assert.equal(a.last_human_interaction,null);
  assert.equal(b.first_human_interaction.user_id,12);assert.equal(b.first_human_interaction.kind,'contact_attempt');
  assert.equal(b.last_human_interaction.kind,'contact_attempt','B is supported by its own persisted attempt, never a contact join');
  const sql=f.calls.find(call=>call.sql?.includes('JOIN Conversations c')).sql;
  assert.match(sql,/JSON_EXTRACT\(m\.metadata, '\$\.ad_sharing\.lead_id'\)/);
  assert.match(sql,/c\.lead_id = l\.id AND c\.clinic_id = l\.clinica_id/);
  assert(!/JOIN[^\n]*(?:telefono|phone)/i.test(sql));
});
