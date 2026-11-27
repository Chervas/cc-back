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
    { open = true, send = true, canManage = true, audience = 'leads', beforeCheck, expiresAt } = {}
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
        senderId: c.contact_id,
        accountId: c.social_account_id,
        type: 'dm',
        channel: c.channel,
        expiresAt: expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
        text,
      },
      initial,
      saved,
      rule: { version: 3, audience },
      analyze: () => assert.fail('A booking turn must not send identities or calendar records to a model.'),
      recordHandoff: async () => ({ recorded: false }),
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
  const denied = await enter(d, '¿Me puedes dar una cita para el 2030-01-09?', {
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
  assert.equal(await db.CitaPaciente.count(), 3);
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
  report.assertions = [
    'Oferta sin escritura y confirmación local con profesional, sala y recibo del plan real',
    'Mismo mensaje repetido y segundo mensaje de aceptación conservan la misma cita',
    'Hueco ocupado por otro lead devuelve alternativas vigentes sin otra cita',
    'Instagram solicita el contacto necesario en el DM, espera confirmación y respeta el cierre de ventana',
    'Dos confirmaciones simultáneas que eligen horarios distintos consumen una sola oferta y generan un único evento de agenda.',
    'Un número de teléfono escrito en Instagram no permite enlazar a otro paciente. Permisos y plazos inválidos bloquean la reserva.',
    'Ambos leads se vinculan a la cita y pasan a citado. Cero invocaciones al modelo o proveedores externos.',
  ];
});
