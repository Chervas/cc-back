'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { handoff, recipients } = require('../../services/leadAssistantHandoff.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const db = { sequelize: sql, Sequelize: D };
  for (const [name, file] of Object.entries({
    Usuario: 'usuario', UsuarioClinica: 'usuarioclinica', PatientDirectionSetting: 'PatientDirectionSetting',
    PatientDirectionProfile: 'PatientDirectionProfile', Notification: 'notification', LeadAssistantSession: 'leadassistantsession', LeadAssistantPublication: 'leadassistantpublication',
  })) db[name] = require('../../../models/' + file)(sql, D.DataTypes);
  db.PatientDirectionSetting.belongsTo(db.Usuario, { as: 'director', foreignKey: 'director_user_id' });
  db.UsuarioClinica.belongsTo(db.Usuario, { as: 'Usuario', foreignKey: 'id_usuario' });
  db.Conversation = sql.define('Conversation', { clinic_id: D.INTEGER, channel: D.STRING, patient_id: D.INTEGER, contact_id: D.STRING, social_account_id: D.STRING }, { timestamps: false });
  db.Message = sql.define('Message', { conversation_id: D.INTEGER, direction: D.STRING, status: D.STRING, metadata: D.JSON }, { timestamps: false });
  db.Clinica = sql.define('Clinica', { id_clinica: { type:D.INTEGER,primaryKey:true }, nombre_clinica:D.STRING, configuracion:D.JSON }, { timestamps:false });
  await sql.sync();
  await db.Clinica.bulkCreate([7,8,9,10].map(id => ({id_clinica:id, configuracion:id===9 ? {} : {leadAssistantHandoffUserId:id===10 ? 5 : 6}})));

  const routeFor = clinicId => recipients(db, clinicId, undefined, {canAccess:async () => true});
  const accounts = Array.from({length: 9}, (_, n) => ({ id_usuario: n + 1, nombre: 'Cuenta de prueba',
    estado_cuenta: n === 4 ? 'suspendido' : 'activo' }));
  await db.Usuario.bulkCreate(accounts);
  async function member(id, clinic, overrides = {}) {
    await db.UsuarioClinica.create({id_usuario: id, id_clinica: clinic, rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas', estado_invitacion: 'aceptada', ...overrides});
  }
  await member(2, 7); await member(3, 7);
  await member(4, 7, {estado_invitacion:'pendiente'}); await member(5, 7);
  await member(6, 7, {subrol_clinica:'Doctores'}); await member(7, 8);
  await member(8, 7, {rol_clinica:'propietario', subrol_clinica:null});
  await member(9, 7, {subrol_clinica:'Administrativos'});
  const assignment = await db.PatientDirectionSetting.create({clinic_id:7, director_user_id:1, is_enabled:false});
  const profile = await db.PatientDirectionProfile.create({user_id:1, is_active:true});
  assert.deepEqual(await routeFor(7), { destination:'patient_director', ids:[1] });

  async function turn(clinicId) {
    const conversation = await db.Conversation.create({clinic_id:clinicId,channel:'instagram'});
    const message = await db.Message.create({conversation_id:conversation.id, direction:'inbound', metadata:{keep:true}});
    await db.LeadAssistantSession.create({conversation_id:conversation.id, clinic_id:clinicId, template_id:11,
      publication_version:2, origin_message_id:message.id, origin_input:'instagram_dm', state:'active', updated_at:new Date()});
    return { clinicId, conversationId: conversation.id, messageId:message.id, templateId:11, version:2 };
  }
  const emitted = [];
  const options = { emitCreated: row => emitted.push(row.userId), canAccess: async () => true };
  const record = data => handoff(db, data, options);
  const directorTurn = await turn(7);
  for (const invalid of [{clinicId:8}, {messageId:999}, {version:3}, {templateId:12}]) {
    await assert.rejects(record({...directorTurn, ...invalid}), /assistant_handoff_scope/);
  }
  const twice = await Promise.all([record(directorTurn), record(directorTurn)]);
  assert.deepEqual(twice, Array(2).fill({recorded:true, destination:'patient_director'}));
  assert.deepEqual(emitted, [1]);
  const marker = await db.Message.findByPk(directorTurn.messageId);
  assert.equal(marker.metadata.keep, true);
  assert.deepEqual(marker.metadata.assistantHandoff, twice[0]);

  await profile.update({is_active:false});
  assert.deepEqual(await routeFor(7), { destination:'reception', ids:[2,3] });
  await assignment.destroy();
  assert.deepEqual(await record(await turn(7)), {recorded:true, destination:'reception'});
  assert.deepEqual(emitted, [1,2,3]);

  const pending = await turn(9);
  const unassigned = {recorded:false, destination:'unassigned'};
  assert.deepEqual(await record(pending), unassigned);
  assert.deepEqual(await record(pending), unassigned);
  assert.equal((await db.LeadAssistantSession.findByPk(pending.conversationId)).state, 'unassigned');
  assert.equal(await db.Notification.count(), 3);
  await member(7, 9);
  assert.deepEqual(await record(pending), {recorded:true, destination:'reception'});
  assert.equal((await db.LeadAssistantSession.findByPk(pending.conversationId)).state, 'human');
  assert.deepEqual(emitted, [1,2,3,7]);
  const restrictedTurn = await turn(7);
  await db.Conversation.update({patient_id:21}, {where:{id:restrictedTurn.conversationId}});
  const checked = [];
  assert.deepEqual(await handoff(db, restrictedTurn, { ...options, canAccess: async ({actorId, featureKey}) => {
    checked.push([actorId, featureKey]); return false;
  } }), unassigned);
  assert.deepEqual(checked, [[2,'quickchat.read_patients'], [3,'quickchat.read_patients'], [6,'quickchat.read_patients']]);
  assert.equal(await db.Notification.count(), 4);
  const manualTurn = await turn(7);
  const take = require('../../services/leadAssistantHandoff.service').takeConversation;
  const thread = await db.Conversation.findByPk(manualTurn.conversationId);
  const socket = require('../../services/socket.service');
  const packets = [];
  const original = socket.getIO;
  socket.getIO = () => ({ to: room => ({ emit: (event,body) => packets.push({room,event,body}) }) });
  let claimed;
  try { claimed = await Promise.all([take(db,thread,2),take(db,thread,3)]); }
  finally { socket.getIO = original; }
  assert.deepEqual(packets, [{room:'clinic:7',event:'message:updated',
    body:{id:manualTurn.messageId,conversation_id:thread.id}}]);
  assert.deepEqual(claimed, ['operator','operator']);
  assert([2,3].includes((await db.Message.findByPk(manualTurn.messageId)).metadata.assistantOperator.actorId));
  assert.equal((await db.LeadAssistantSession.findByPk(thread.id)).state, 'operator');
  assert.deepEqual(await record(manualTurn), { recorded:false, destination:null });
  assert.equal(await take(db,{id:thread.id,clinic_id:999},3),null);
  await db.Clinica.update({configuracion:{leadAssistantHandoffUserId:8}}, {where:{id_clinica:9}});
  assert.deepEqual(await routeFor(9), {destination:'reception',ids:[7]});
  await db.UsuarioClinica.destroy({where:{id_clinica:9}});
  assert.deepEqual(await routeFor(10), {destination:'unassigned',ids:[]});
  const fallbackTurn = await turn(9);
  const denied = await handoff(db, fallbackTurn, {...options, canAccess: async ({actorId,clinicId,featureKey}) => {
    assert.deepEqual([actorId,clinicId,featureKey], [8,9,'quickchat.read_leads']); return false;
  }});
  assert.deepEqual(denied, unassigned);
  const previousCount = await db.Notification.count();
  const fallback = await Promise.all([record(fallbackTurn),record(fallbackTurn)]);
  assert.deepEqual(fallback,Array(2).fill({recorded:true,destination:'designated_staff'}));
  assert.equal(await db.Notification.count(),previousCount+1);
  const note=await db.Notification.findOne({where:{userId:8,clinicaId:9}});
  assert.equal(note.data.quickChatConversationId,fallbackTurn.conversationId);
  assert.equal((await db.LeadAssistantSession.findByPk(fallbackTurn.conversationId)).state,'human');
  await profile.update({is_active:true});
  await db.PatientDirectionSetting.create({clinic_id:7,director_user_id:1,is_enabled:false});
  const routeTest=async (allowed, patientId=null) => {
    const scope=await turn(7);
    if(patientId) await db.Conversation.update({patient_id:patientId}, {where:{id:scope.conversationId}});
    const result=await handoff(db,scope,{...options,canAccess:async ({actorId,clinicId,featureKey})=>{
      assert.equal(clinicId,7);
      assert.equal(featureKey, patientId ? 'quickchat.read_patients' : 'quickchat.read_leads');
      return allowed.includes(actorId);
    }});
    const notifications=await db.Notification.findAll({where:{clinicaId:7,'data.quickChatResponseMessageId':scope.messageId},raw:true});
    return {destination:result.destination,notified:notifications.map(n=>n.userId).sort()};
  };
  assert.deepEqual(await routeTest([3,6]),{destination:'reception',notified:[3]});
  assert.deepEqual(await routeTest([6],88),{destination:'designated_staff',notified:[6]});
  assert.deepEqual(await routeTest([]),{destination:'unassigned',notified:[]});
  const { attend } = require('../../services/leadAssistantTurn.service');
  const { randomUUID } = require('node:crypto');
  const fields = {tone:'Breve', booking:'', context:'', guardrails:'', promotions:[
    '## Vigencia', 'Ficha revisada el **01/02/2001**.',
    '- **Bono de ejemplo.** La compra promocional termina el **28/02/2001**. Los bonos comprados se pueden canjear hasta el **31/12/2099** con valoración previa.',
    '### Bonos', '| Tratamiento | Precio | Imagen |','|---|---|---|',
    '| Bono de ejemplo | 29 € | [Foto](https://media.example.com/ejemplo.jpg) |',
  ].join('\n')};
  await db.Clinica.update({nombre_clinica:'Clínica de prueba'}, {where:{id_clinica:7}});
  await db.LeadAssistantPublication.create({clinic_id:7,version:2,fields,approved_by:6,approved_at:new Date()});
  async function conversationAttempt({channel, text, type='dm', allowed=[6]}) {
    const scope=await turn(7);
    const current=await db.Conversation.findByPk(scope.conversationId);
    await current.update({channel,contact_id:'contacto-qa',social_account_id:'cuenta-qa'});
    const inbound=await db.Message.findByPk(scope.messageId);
    const execution={id:scope.messageId,template_version_id:11,created_by:6};
    const saved={attemptId:randomUUID(),decision:{kind:'interest',privateRequested:true}};
    await inbound.update({metadata:{[channel==='whatsapp'?'assistantInbound':'socialLead']:{executionId:execution.id}}});
    const monitor={published:new Map(),attempts:[],beforeDelivery:null,blocked:null};
    const payload={db,execution,saved,thread:current,initial:inbound,rule:{version:2,audience:'leads'},
      entry:{messageId:scope.messageId,channel,type,senderId:current.contact_id,accountId:current.social_account_id,text},
      blockReason:async()=>monitor.blocked,analyze:()=>assert.fail('unexpected model request'),
      recordHandoff:(scope,prepareReply)=>handoff(db,scope,{...options,prepareReply,canAccess:async ({actorId})=>allowed.includes(actorId)}),
      social:{availability:async()=>({dm:{available:true},comments:{[scope.messageId]:{available:true}}}),
        reply:async (_,command,guard)=>{
          monitor.attempts.push(command);
          if(monitor.beforeDelivery) await monitor.beforeDelivery();
          const reason=await guard.blockReason();
          if(reason) return {outcome:'blocked',reason};
          monitor.published.set(command.attemptId,command.text);
          return {outcome:'sent'};
        }}};
    return {scope,monitor,payload,run:()=>attend(payload),take:()=>take(db,current,6)};
  }
  const sale = await conversationAttempt({channel:'instagram',type:'comment',text:'Quiero comprar el Bono de ejemplo'});
  sale.monitor.beforeDelivery=async()=>{throw Error('simulated_worker_restart')};
  await assert.rejects(sale.run(),/simulated_worker_restart/);
  const notifications = () => db.Notification.findAll({where:{'data.quickChatResponseMessageId':sale.scope.messageId},raw:true});
  assert.deepEqual((await notifications()).map(x=>x.userId),[6]);
  assert.equal((await db.LeadAssistantSession.findByPk(sale.scope.conversationId)).state,'human');
  assert.equal(sale.monitor.published.size,0);
  sale.monitor.beforeDelivery=null;
  const attemptId=sale.payload.saved.attemptId;
  sale.payload.saved.attemptId=randomUUID();
  assert.equal((await sale.run()).reason,'assistant_turn_unavailable');
  sale.payload.saved.attemptId=attemptId;
  sale.monitor.blocked='marketing_opt_out';
  assert.equal((await sale.run()).reason,'marketing_opt_out');
  sale.monitor.blocked=null;
  assert.equal((await sale.run()).outcome,'sent');
  assert.equal((await sale.run()).outcome,'sent');
  assert.equal(sale.monitor.published.size,1);
  assert.equal((await notifications()).length,1);
  const command=sale.monitor.attempts[0];
  assert.equal(command.commentMessageId,sale.scope.messageId);
  assert(sale.monitor.attempts.every(c=>c.attemptId===attemptId && c.text===command.text));
  assert.match(command.text,/28 de febrero de 2001/);
  assert.match(command.text,/persona responsable del equipo/);
  assert.doesNotMatch(command.text,/29 €|http/);
  for(const channel of ['whatsapp','messenger']) {
    const manual = await conversationAttempt({channel,text:'Quiero hablar con una persona'});
    manual.monitor.beforeDelivery=manual.take;
    assert.equal((await manual.run()).reason,'assistant_turn_unavailable');
    assert.equal((await manual.run()).reason,'assistant_turn_unavailable');
    assert.equal(manual.monitor.published.size,0);
  }
  const nobody = await conversationAttempt({channel:'instagram',text:'Quiero hablar con una persona',allowed:[]});
  assert.equal((await nobody.run()).reason,'assistant_handoff_unassigned');
  assert.equal((await nobody.run()).outcome,'sent');
  assert.equal(nobody.monitor.published.size,1);
  assert.doesNotMatch(nobody.monitor.attempts[0].text,/he pasado|he avisado/i);
  report.checks.push('Un traspaso y su respuesta sobreviven al reinicio. El operador, la baja y el identificador de envío protegen el reintento.');
  report.checks.push('El destinatario se elige por el permiso del hilo. Si dirección o recepción carecen de acceso, se avisa al siguiente equipo autorizado.');
  report.checks.push('Responsable de respaldo de la clínica: cuenta activa, permiso del hilo, aviso único, prioridad de dirección y recepción.');
  report.checks.push('Intervención manual en el mismo hilo, idempotente y aislada por clínica.');
  report.checks.push('Dirección asignada y activa, recepción de la clínica, ausencia de destinatario y recuperación del pendiente.');
  report.checks.push('Turno aislado por clínica y versión, bloqueo concurrente, avisos únicos y conservación del mensaje.');
});
