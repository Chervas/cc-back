'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { attend } = require('../../services/leadAssistantTurn.service');
const { reserve } = require('../../services/leadAssistantReservation.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const f = await createOwnedBookingDurationFixture({
    sql,
    models: db,
    includePatientScope: true,
    nativePatientModel: true,
    nativeCatalogModel: true,
  });
  for (const name of [
    'JobRequest',
    'LeadIntake',
    'LeadAttributionAudit',
    'Conversation',
    'Message',
    'LeadAssistantSession',
    'LeadAssistantPublication',
    'LeadAssistantDraft',
  ]) {
    db[name] = require('../../../models/' + name.toLowerCase())(sql, DataTypes);
    await db[name].sync();
  }
  const treatment = await db.Tratamiento.create({
    id_tratamiento: 61,
    nombre: 'Valoración de prueba',
    codigo: 'VAL',
    disciplina: 'Ficticia',
    origen: 'clinica',
    activo: true,
    clinica_id: 100,
    clinical_config: {
      catalog_status: 'active',
      booking_profile: f.profile(1, [f.phase('visita', { duration_minutes: 30 })]),
    },
  });
  await db.LeadAssistantPublication.create({
    clinic_id: 100,
    version: 3,
    approved_by: 1,
    approved_at: new Date(),
    fields: {
      tone: 'Cercano',
      context: 'Información comercial',
      guardrails: 'Derivación al equipo',
      booking: 'Servicio de agenda: VAL',
      promotions: '',
    },
  });
  const reads = [];
  sql.options.logging = (stmt) => {
    if (/\bSELECT\b/i.test(stmt)) reads.push(stmt);
  };
  let sequence = 10;
  const questions = [];
  async function thread(channel, contact) {
    const lead = await db.LeadIntake.create({
      clinica_id: 100,
      nombre: 'Nombre de prueba',
      telefono: channel === 'whatsapp' ? contact : null,
      status_lead: 'nuevo',
    });
    return db.Conversation.create({
      clinic_id: 100,
      channel,
      contact_id: contact,
      last_inbound_at: new Date(),
      lead_id: lead.id,
      ...(channel === 'instagram' ? { social_account_id: 'qa-clinic' } : {}),
    });
  }
  async function enter(
    c,
    text,
    { open = true, send = true, canManage = true, audience = 'leads', version = 3, beforeCheck, expiresAt, ad, analyze, imageDelivery } = {}
  ) {
    const execution = { id: ++sequence, template_version_id: 51, group_id: 50, created_by: 1 };
    const initial = await db.Message.create({
      conversation_id: c.id,
      direction: 'inbound',
      content: text,
      status: 'sent',
      sent_at: new Date(),
      metadata: {
        [c.channel === 'whatsapp' ? 'assistantInbound' : 'socialLead']: { executionId: execution.id },
      },
    });
    const saved = { decision: { kind: 'interest' }, attemptId: randomUUID() };
    const payload = {
      db,
      execution,
      thread: c,
      entry: {
        messageId: initial.id,
        ...(ad ? {ad} : {}),
        senderId: c.contact_id,
        accountId: c.social_account_id,
        type: 'dm',
        channel: c.channel,
        expiresAt: expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
        text,
      },
      initial,
      saved,
      rule: { version, audience },
      analyze: analyze || (() => assert.fail('A booking turn must not send identities or calendar records to a model.')),
      recordHandoff: async (scope, prepareReply) => {
        const destination = { recorded: false, destination: 'unassigned' };
        const reply = prepareReply?.(destination);
        if (!reply) return destination;
        await db.LeadAssistantSession.update({ state: 'unassigned' }, { where: { conversation_id: scope.conversationId } });
        return { ...destination, reply: { ...reply, state: 'unassigned' } };
      },
      blockReason: async () => null,
      bookingOptions: {
        mayBook: async () => {
          if (beforeCheck) await beforeCheck();
          return canManage;
        },
        capabilities: f.capabilities,
        now: new Date('2030-01-06T12:00:00Z'),
        book: (args) =>
          reserve({
            ...args,
            visitManager: { prepareBirth: async () => null },
            enqueueSignals: async () => {},
          }),
      },
      social: {
        replyWithPromotionImage:imageDelivery,
        availability: async () => ({ dm: { available: open } }),
        reply: async (current, cmd) => {
          if (
            send &&
            !(await db.Message.count({
              where: { conversation_id: current.id, automation_delivery_key: cmd.attemptId },
            }))
          ) {
            await db.Message.create({
              conversation_id: current.id,
              automation_delivery_key: cmd.attemptId,
              direction: 'outbound',
              content: cmd.text,
              status: 'sent',
              metadata: { source: 'automations_v2', execution_id: execution.id },
            });
            questions.push(cmd.text);
          }
          return { outcome: send ? 'sent' : 'blocked' };
        },
      },
    };
    const run = () => attend(payload);
    const result = await run();
    return { result, initial, run, booking: async () => (await initial.reload()).metadata.assistantBooking };
  }
  const previewState = {};
  const balances = () => Promise.all([db.CitaPaciente, db.Paciente, db.LeadIntake, db.Conversation, db.Message, db.JobRequest].map(model => model.count()));
  const beforePreview = await balances();
  const previewFields = {booking:'Servicio de agenda: VAL\nPide el correo electrónico.', promotions:'', context:'Valoraciones', guardrails:'',tone:'Cercano'};
  async function previewBooking(text, messageId) {
    return require('../../services/leadAssistantBooking.service').processTurn({
      db,thread:{clinic_id:100,channel:'instagram'},scope:{originMessageId:1,messageId,version:3},entry:{type:'dm',text,messageId},
      fields:previewFields,offer:null,execution:{created_by:1},preview:previewState,availability:async()=>true,
      mayBook:async()=>true,blockReason:async()=>null,capabilities:f.capabilities,now:new Date('2030-01-06T12:00:00Z'),
      book:()=>assert.fail('preview must not enter reservation'),
    });
  }
  await previewBooking('Quiero reservar para el 2030-01-07',1);assert.equal(previewState.booking.stage,'offered');
  await previewBooking('La primera',2);assert.equal(previewState.booking.stage,'contact');
  await previewBooking('Ana Prueba, +34600000001, ana@example.invalid',3);assert.equal(previewState.booking.stage,'confirm');
  const simulated=await previewBooking('Confirmo',4);assert.match(simulated.reply,/Tu cita ha quedado reservada/);
  assert.equal(previewState.booking.stage,'booked');assert.deepEqual(await balances(),beforePreview);
  const a = await thread('whatsapp', '+34600123451'),
    b = await thread('whatsapp', '+34600123452');
  const first = await enter(a, 'Quiero reservar para el 2030-01-07');
  const start = await first.booking();
  assert.equal(start.stage, 'offered');
  assert.equal(start.slots.length, 3);
  assert.equal(await db.CitaPaciente.count(), 0);
  const same = await enter(b, '¿Tienes huecos el 2030-01-07?');
  assert.equal((await same.booking()).slots[0].start, start.slots[0].start);
  const pick = await enter(a, 'La primera');
  assert.equal((await pick.booking()).stage, 'confirm');
  assert.equal(await db.CitaPaciente.count(), 0);
  const yes = await enter(a, 'Sí, confirmo');
  const confirmed = await yes.booking();
  assert.equal(confirmed.stage, 'booked', JSON.stringify(yes.result));
  await yes.run();
  assert.equal((await a.reload()).patient_id, confirmed.patientId);
  const again = await enter(a, 'Confirmo la 1');
  assert.equal(again.result.reason, 'assistant_audience_excluded');
  const appointment = await db.CitaPaciente.findByPk(confirmed.appointmentId);
  assert.equal(appointment.source_system, 'quickchat_assistant');
  assert.equal(appointment.lead_intake_id, a.lead_id);
  assert.equal(+appointment.inicio, Date.parse(start.slots[0].start));
  assert.equal(appointment.tratamiento_id, treatment.id_tratamiento);
  assert.equal((await db.LeadIntake.findByPk(a.lead_id)).status_lead, 'citado');
  const late = await enter(b, 'Confirmo la 1');
  const alternatives = await late.booking();
  assert.equal(alternatives.stage, 'offered');
  assert.match(alternatives.reply, /ocupar/);
  assert(!alternatives.slots.some((s) => s.start === start.slots[0].start));
  assert.equal(await db.CitaPaciente.count(), 1);
  const c = await thread('instagram', 'qa-social-person');
  await enter(c, '¿Tenéis disponibilidad el 2030-01-08?');
  await enter(c, 'La segunda');
  const number = await enter(c, '+34 600123453');
  assert.equal((await number.booking()).stage, 'confirm');
  assert.equal(await db.CitaPaciente.count(), 1);
  const closed = await enter(c, 'Sí', { open: false });
  assert.equal(closed.result.reason, 'reply_unavailable');
  assert.equal(await db.CitaPaciente.count(), 1);
  const ig = await enter(c, 'Confirmo la 2');
  assert.equal((await ig.booking()).stage, 'booked');
  assert.equal(await db.CitaPaciente.count(), 2);
  assert.equal((await db.LeadIntake.findByPk(c.lead_id)).status_lead, 'citado');
  assert(questions.slice(0, 1)[0].includes('asistente de IA'));
  assert(questions.some((q) => q.includes('09:00')));
  const d = await thread('whatsapp', '+34600123454');
  const denied = await enter(await thread('whatsapp', '+34600200181'), '¿Me puedes dar una cita para el 2030-01-09?', {
    canManage: false,
    audience: 'all',
  });
  assert.match(denied.result.reason, /handoff/);
  const offered = await enter(d, 'Quiero reservar el 2030-01-09', { audience: 'all' });
  assert.equal((await offered.booking()).stage, 'offered');
  const expired = await enter(d, 'Confirmo la 1', { audience: 'all', expiresAt: 'invalido' });
  assert.equal(expired.result.reason, 'reply_unavailable');
  let arrivals = 0,
    release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const beforeCheck = async () => {
    if (++arrivals === 2) release();
    await ready;
  };
  const simultaneous = await Promise.all(
    ['Confirmo la 1', 'Confirmo la 2'].map((text) => enter(d, text, { audience: 'all', beforeCheck }))
  );
  const receipts = await Promise.all(simultaneous.map((x) => x.booking()));
  assert.equal(receipts[0].stage, 'booked');
  assert.equal(receipts[1].stage, 'booked');
  assert.equal(receipts[0].appointmentId, receipts[1].appointmentId);
  assert.equal(receipts[0].selected, receipts[1].selected);
  assert.equal(await db.CitaPaciente.count(), 3);
  assert.equal(await db.JobRequest.count({ where: { type: 'lead_assistant_appointment_created' } }), 3);
  // Both contacts see the exact same slot before either confirms.
  const contenders = await Promise.all(
    ['+34600123457', '+34600123458'].map(phone => thread('whatsapp', phone))
  );
  const proposals = await Promise.all(
    contenders.map(contact => enter(contact, 'Quiero reservar el 2030-01-10 a las 09:00'))
  );
  const [left, right] = await Promise.all(proposals.map(proposal => proposal.booking()));
  assert.equal(left.slots.length, 1);
  const chosen = left.slots[0];
  assert.equal(chosen.start, right.slots[0].start);
  let readyCount = 0;
  let bothReady;
  const confirming = new Promise(resolve => { bothReady = resolve; });
  const meet = async () => {
    if (++readyCount === 2) bothReady();
    await confirming;
  };
  const contest = await Promise.all(
    contenders.map(contact => enter(contact, 'Confirmo la primera', { beforeCheck: meet }))
  );
  const outcomes = await Promise.all(contest.map(item => item.booking()));
  assert.deepEqual(outcomes.map(item => item.stage).sort(), ['booked', 'offered']);
  const replacement = outcomes.find(item => item.stage === 'offered');
  assert.match(replacement.reply, /otro día|otros días/);
  assert(replacement.slots.length > 0);
  for (const slot of replacement.slots) {
    assert(slot.local.slice(0, 10) > '2030-01-10');
    assert.equal(slot.local.slice(11, 16), '09:00');
    assert.equal(slot.doctorId, chosen.doctorId);
  }
  assert.equal(await db.CitaPaciente.count(), 4);
  assert.equal(await db.CitaPaciente.count({
    where: { inicio: new Date(chosen.start), doctor_id: chosen.doctorId },
  }), 1);
  assert.equal(await db.JobRequest.count({ where: { type: 'lead_assistant_appointment_created' } }), 4);
  const hooks = [];
  const worker = require('../../services/leadAssistantAppointmentEvents.service');
  const event = (
    await db.JobRequest.findOne({
      where: { type: 'lead_assistant_appointment_created' },
      order: [['id', 'ASC']],
    })
  ).payload;
  const dependencies = {
    events: {
      emitAppointmentSocketEvent: () => hooks.push('agenda'),
      prepareConsent: () => hooks.push('consent'),
    },
    refresh: () => hooks.push('chat'),
    runtime: {
      enqueueExecutionForCita: (_, x) => hooks.push(x.event_name),
      syncScheduledTriggersForCita: () => hooks.push('scheduled'),
    },
    managed: { managedVisit: () => null },
    direction: { handleAppointmentChange: () => hooks.push('direction') },
  };
  assert.deepEqual(await worker.dispatch(db, { ...event, clinicId: 200 }, dependencies), {
    skipped: 'source_changed',
  });
  assert.equal(hooks.length, 0);
  assert.deepEqual(await worker.dispatch(db, event, dependencies), { processed: true });
  assert.deepEqual(hooks, ['agenda', 'chat', 'appointment_created', 'scheduled', 'consent', 'direction']);
  const impostor = await thread('instagram', 'test-other-social');
  await enter(impostor, 'Me gustaría una cita el 2030-01-10');
  await enter(impostor, 'La primera');
  await enter(impostor, '+34 600123451');
  const review = await enter(impostor, 'Sí');
  assert.match(review.result.reason, /handoff/);
  assert.equal((await impostor.reload()).patient_id, null);
  assert.equal(await db.CitaPaciente.count(), 4);
  const policy = 'Mucha gente falla, por lo que a los leads, los citamos doblandolso a la misma hora siempre y cuando no haya una cita ya agendada a esa que no sea un lead. (Doblando es 2 a la vez como mucho)';
  const { allowsLeadPair } = require('../../services/leadAssistantOverlap.service');
  assert(allowsLeadPair(policy));
  assert(allowsLeadPair('Se permite montar dos leads a la misma hora. Si hay una cita de paciente, se respeta.'));
  for (const text of ['', '¿Podemos doblar los leads?', 'Nunca se permite doblar leads.', 'No se puede montar otra cita con un lead.', 'Explica a los leads que buscaremos hora.']) assert.equal(allowsLeadPair(text), false, text);
  const originalPub = await db.LeadAssistantPublication.findOne({ where: { clinic_id: 100, version: 3 } });
  await db.LeadAssistantPublication.create({ clinic_id: 100, version: 4, approved_by: 1, approved_at: new Date(),
    fields: { ...originalPub.fields, booking: originalPub.fields.booking + '\n' + policy } });
  const withPair = (c, text, options) => enter(c, text, { version: 4, ...options });
  const extra = await Promise.all(Array.from({ length: 11 }, (_, i) => thread('whatsapp', '+3460012350' + i)));
  const ask = date => 'Quiero reservar el ' + date + ' a las 09:00';
  const save = c => withPair(c, 'Confirmo la primera');
  const pairDay = '2030-01-11';
  const freeProposals = await Promise.all(extra.slice(0, 2).map(c => withPair(c, ask(pairDay))));
  const freeSlot = (await freeProposals[0].booking()).slots[0];
  assert.equal((await freeProposals[1].booking()).slots[0].start, freeSlot.start);
  assert.equal((await (await save(extra[0])).booking()).stage, 'booked');
  assert.equal((await (await save(extra[1])).booking()).stage, 'booked', 'A second lead may confirm an initially free slot');
  assert.equal(await db.CitaPaciente.count({ where: { inicio: new Date(freeSlot.start) } }), 2);
  assert.equal((await (await withPair(extra[2], ask(pairDay))).booking()).stage, 'service');
  // A first visit scheduled outside Cleo is also a lead appointment.
  const testDate = '2030-01-14';
  const manualOffer = await (await withPair(extra[3], ask(testDate))).booking();
  const requested = manualOffer.slots[0];
  const leadAppointment = await db.CitaPaciente.create({
    clinica_id: 100, paciente_id: confirmed.patientId, tratamiento_id: treatment.id_tratamiento,
    doctor_id: requested.doctorId, instalacion_id: requested.roomId, inicio: new Date(requested.start),
    fin: new Date(requested.end), estado: 'pendiente', tipo_cita: 'primera_sin_trat', lead_intake_id: extra[4].lead_id,
  });
  await db.LeadIntake.update({ call_outcome_appointment_id: leadAppointment.id_cita }, { where: { id: extra[4].lead_id } });
  assert.equal((await (await withPair(extra[5], ask(testDate))).booking()).slots[0].start, requested.start,
    'An already occupied lead-only slot can be offered');
  const results = await Promise.all([extra[3], extra[5]].map(save));
  assert.deepEqual((await Promise.all(results.map(item => item.booking()))).map(item => item.stage).sort(), ['booked', 'offered']);
  assert.equal(await db.CitaPaciente.count({ where: { inicio: new Date(requested.start) } }), 2);
  // A subsequent non-lead appointment can block part of the requested visit.
  const patientDate = '2030-01-15';
  const before = (await (await withPair(extra[6], ask(patientDate))).booking()).slots[0];
  const normal = await db.CitaPaciente.create({
    clinica_id: 100, paciente_id: confirmed.patientId, tratamiento_id: treatment.id_tratamiento,
    doctor_id: before.doctorId, instalacion_id: before.roomId, inicio: new Date(+new Date(before.start) + 15 * 60000),
    fin: new Date(before.end), estado: 'pendiente', tipo_cita: 'continuacion', lead_intake_id: extra[4].lead_id,
  });
  assert.equal((await (await save(extra[6])).booking()).stage, 'offered');
  await normal.update({ inicio: new Date(before.start), tipo_cita: 'primera_con_trat', lead_intake_id: null });
  assert.equal((await (await withPair(extra[7], ask(patientDate))).booking()).stage, 'service');
  const blockedDate = '2030-01-16';
  const availableBeforeBlock = (await (await withPair(extra[8], ask(blockedDate))).booking()).slots[0];
  const manualValues = { clinica_id: 100, paciente_id: confirmed.patientId, tratamiento_id: treatment.id_tratamiento,
    doctor_id: availableBeforeBlock.doctorId, instalacion_id: availableBeforeBlock.roomId,
    inicio: new Date(availableBeforeBlock.start), fin: new Date(availableBeforeBlock.end), estado: 'pendiente',
    tipo_cita: 'primera_sin_trat', lead_intake_id: extra[9].lead_id };
  const manualLead = await db.CitaPaciente.create(manualValues);
  const roomBlock = await db.InstalacionBloqueo.create({ instalacion_id: manualValues.instalacion_id,
    fecha_inicio: manualValues.inicio, fecha_fin: manualValues.fin, motivo: 'Bloqueo de prueba' });
  assert.equal((await (await withPair(extra[10], ask(blockedDate))).booking()).stage, 'service');
  await roomBlock.destroy();
  const conflictingPatient = await db.CitaPaciente.create({ ...manualValues, lead_intake_id: null,
    inicio: new Date(+manualValues.inicio + 15 * 60000), tipo_cita: 'continuacion' });
  assert.equal((await (await save(extra[8])).booking()).stage, 'offered');
  await conflictingPatient.destroy();
  await db.LeadAttributionAudit.create({ lead_intake_id: extra[9].lead_id, attribution_steps: {
    type: 'lead_patient_context_v1', lead_patient_context_v1: { relationship: 'existing_patient' } } });
  assert.equal((await (await withPair(extra[10], ask(blockedDate))).booking()).stage, 'service');
  await manualLead.update({ estado: 'cancelada' });
  assert.equal((await (await withPair(extra[10], ask(blockedDate))).booking()).stage, 'offered');
  const secondInPair = await db.CitaPaciente.findOne({ where: { lead_intake_id: extra[1].lead_id } });
  assert.equal(secondInPair.import_metadata.source_quickchat_assistant.shared_lead_slot, true);
  assert(
    !reads.some((s) =>
      /\b(?:HistoriasClinicas|DocumentsPaciente|DocumentosPaciente|ClinicalDocuments|ClinicalHistoryEntries)\b/i.test(
        s
      )
    )
  );
  const patientReads = reads.filter((s) => /FROM\s+`Pacientes`/i.test(s));
  assert(patientReads.length > 0);
  for (const s of patientReads)
    assert(
      !/\b(?:dni|fecha_nacimiento|foto_perfil|historia_clinica|observaciones|peso|email)\b/i.test(
        s.split(/\bFROM\s/i)[0]
      ),
      'La comprobación de identidad debe leer únicamente los identificadores administrativos permitidos.'
    );
  await db.LeadAssistantPublication.create({clinic_id:100,version:6,approved_by:1,approved_at:new Date(),
    fields:{...originalPub.fields,booking:'Servicio de agenda: VAL\nPide correo electrónico para el recordatorio.'}});
  const known = await thread('instagram','contacto-qa-con-datos');
  await db.LeadIntake.update({email:'anterior@example.org',telefono:'+34600223995'},{where:{id:known.lead_id}});
  const oneOption = await enter(known,'Quiero reservar el 2030-01-18 a las 09:00',{version:6});
  assert.equal((await oneOption.booking()).slots.length,1);
  assert.match(questions.at(-1),/¿Te viene bien/);
  const acceptedTime = await enter(known,'Sí',{version:6});
  const knownDetails = await acceptedTime.booking();
  assert.equal(knownDetails.stage,'confirm');
  assert.equal(knownDetails.contact.email,'anterior@example.org');
  assert.doesNotMatch(questions.at(-1),/correo|móvil|Valoración de prueba/);
  const expiredCatalogue = [
    '## Vigencia', 'Ficha revisada el **01/02/2001**.',
    '- **Bono de ejemplo.** La compra promocional termina el **28/02/2001**. Los bonos comprados se pueden canjear hasta el **31/12/2099** con valoración previa.',
    '### Bonos', '| Tratamiento | Precio | Imagen |','|---|---|---|',
    '| Bono de ejemplo | 29 € | [Foto](https://media.example.com/vieja.jpg) |',
  ].join('\n');
  await db.LeadAssistantPublication.create({ clinic_id:100,version:5,approved_by:1,approved_at:new Date(),
    fields:{...originalPub.fields,promotions:expiredCatalogue} });
  const saleThread=await thread('whatsapp','+34600223993');
  const beforeSale=await db.CitaPaciente.count();
  const expiredReply=await enter(saleThread,'Quiero reservar el Bono de ejemplo',{version:5});
  assert.equal(expiredReply.result.reason,'sale_ended');
  assert.match(questions.at(-1),/28 de febrero de 2001/);
  assert.doesNotMatch(questions.at(-1),/29 €|https:/);
  assert.equal(await expiredReply.booking(),undefined);
  const redeemReply=await enter(await thread('whatsapp','+34600223994'),'Ya compré el Bono de ejemplo, ¿puedo canjearlo?',{version:5});
  assert.equal(redeemReply.result.reason,'sale_ended');
  assert.match(questions.at(-1),/31\/12\/2099.*valoración previa/);
  assert.equal(await db.CitaPaciente.count(),beforeSale);
  // Exercise the public simulation service and the actual QuickChat worker entry point.
  // They see the same configuration, appointment catalogue, free slots and contact facts.
  const fields = {...originalPub.fields, booking:'Servicio de agenda: VAL\nOfrece dos alternativas. Pide correo electrónico para el recordatorio.',
    promotions:'C01-01 · Cuidado de rostro y cuello\nPrecio: 35 €.\nImagen: https://media.example.com/rostro.jpg'};
  await db.LeadAssistantPublication.create({clinic_id:100,version:7,approved_by:1,approved_at:new Date(),fields});
  await db.LeadAssistantDraft.create({clinic_id:100,version:7,updated_by:1,updated_at:new Date(),fields});
  const liveInputs = [], trialInputs = [];
  function model(inputs) {
    return async request => {
      const data = JSON.parse(request.inputText);
      inputs.push({data,prompt:request.prompt,systemPrompt:request.systemPrompt,group:request.groupId,clinic:request.clinicId});
      if (data.userText === 'INFO') return {reply:'La promoción cuesta 35 €.',imageId:data.promotion.images[0].id};
      if (/contestando/i.test(data.userText)) return {reply:'La promoción no describe una reducción del cuello. ¿Quieres que te mire horarios?'};
      return {reply:'La información de la promoción no indica que reduzca el volumen del cuello.'};
    };
  }
  const simulator = require('../../services/leadAssistantSimulator.service').create({
    db,analyze:model(trialInputs),recipients:async () => ({destination:'unassigned'}),
    booking:args => require('../../services/leadAssistantBooking.service').processTurn({...args,mayBook:async () => true,
      now:new Date('2030-01-06T12:00:00Z'),capabilities:f.capabilities,book:() => assert.fail('simulation attempted a write')}),
  });
  const sample = await simulator.start(100,1);
  assert.equal(sample.approved,true);
  const promotion = sample.promotions[0].key;
  const steps = ['INFO','me va bien para reducir cuello?','no me estás contestando','Sí, por favor','La segunda',
    'Ana Prueba, +34600223996, ana@example.invalid','Confirmo'];
  const inspect = () => Promise.all([db.CitaPaciente,db.Paciente,db.LeadIntake,db.Conversation,db.Message,
    db.JobRequest,db.LeadAssistantSession].map(m=>m.count()));
  const beforeTrial = await inspect();
  const trial = [];
  for (const message of steps) trial.push(await simulator.turn(100,1,sample.id,{
    id:randomUUID(),channel:'instagram',calendar:'clinic',message,promotion,
  }));
  assert.equal(trial.at(-1).event,'booked');
  assert.deepEqual(await inspect(),beforeTrial,'simulation wrote to business data');
  const liveThread = await thread('instagram','qa-parity-instagram');
  await db.LeadIntake.update({external_source:'quickchat_social',nombre:'qa-parity-instagram'},{where:{id:liveThread.lead_id}});
  await liveThread.update({social_alias:'qa-parity-instagram'});
  const photos = [];
  const parityModel = model(liveInputs);
  for (const [index, message] of steps.entries()) {
    const delivered = await enter(liveThread,message,{version:7,analyze:parityModel,ad:index === 0 ? {title:promotion} : null,
      imageDelivery:async (_,command) => {photos.push(command.selection);return {outcome:'sent'};}});
    assert.equal(delivered.result.outcome,'sent',message);
    assert.equal(questions.at(-1),trial[index].reply,'QuickChat differs from the simulator at: ' + message);
    if (index === 3) assert.equal(trial[index].slots.length,(await delivered.booking()).slots.length);
  }
  assert.deepEqual(liveInputs,trialInputs,'model instructions, offer and conversational memory must be identical');
  assert.equal(photos.length,1);assert.equal(trial[0].image.url,'https://media.example.com/rostro.jpg');
  assert(trial.slice(1).every(r=>!r.image));
  assert.equal(await db.CitaPaciente.count(),beforeTrial[0]+1);
  const handoffTrial = await simulator.start(100,1);
  const handoffText = 'Quiero hablar con una persona';
  const route = await simulator.turn(100,1,handoffTrial.id,{id:randomUUID(),message:handoffText,promotion:''});
  await enter(await thread('instagram','qa-parity-handoff'),handoffText,{version:7});
  assert.equal(route.event,'handoff');assert.equal(route.reply,questions.at(-1));
  const statusThread = await thread('instagram','qa-no-booking-yet');
  const beforeStatus = await db.CitaPaciente.count();
  const noDate = await enter(statusThread,'¿Cuándo has dicho que era mi cita?',{version:7});
  assert.match(questions.at(-1),/todavía no hemos confirmado/);
  assert.equal((await noDate.booking()).stage,'status');
  const choicesAfterStatus = await enter(statusThread,'Sí, por favor',{version:7});
  assert.equal((await choicesAfterStatus.booking()).stage,'offered');
  const repeat = await enter(statusThread,'vale dímelos',{version:7});
  assert.deepEqual((await repeat.booking()).slots,(await choicesAfterStatus.booking()).slots);
  assert.equal(await db.CitaPaciente.count(),beforeStatus);
  report.assertions = [
    'El simulador y el worker de QuickChat ofrecen los mismos mensajes, imagen, huecos, recogida de contacto, confirmación y traspaso para el mismo lead ficticio.',
    'Una compra fuera de promoción no ofrece la tarifa, la foto ni la cita. El canje de un bono ya adquirido conserva sus propias condiciones.',
    'Dos leads por hora solo con autorización publicada, incluidas citas manuales y confirmaciones concurrentes. Un paciente bloquea todo el intervalo.',
    'Oferta sin escritura y confirmación local con profesional, sala y recibo del plan real',
    'Mismo mensaje repetido y segundo mensaje de aceptación conservan la misma cita',
    'Hueco ocupado por otro lead devuelve alternativas vigentes sin otra cita',
    'Dos leads que confirman a la vez el último hueco de una hora concreta reciben una reserva y alternativas a la misma hora en otros días.',
    'Instagram solicita el contacto necesario en el DM, espera confirmación y respeta el cierre de ventana',
    'Dos confirmaciones simultáneas que eligen horarios distintos consumen una sola oferta y generan un único evento de agenda.',
    'Un número de teléfono escrito en Instagram no permite enlazar a otro paciente. Permisos y plazos inválidos bloquean la reserva.',
    'Ambos leads se vinculan a la cita y pasan a citado. Cero invocaciones al modelo o proveedores externos.',
  ];
});
