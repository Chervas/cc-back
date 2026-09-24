'use strict';

const db = require('../../models');

function dnsRecords(domain) {
  return [
    { type: 'CNAME', name: `qa1._domainkey.${domain}`, value: 'qa1.dkim.amazonses.com', purpose: 'DKIM' },
    { type: 'CNAME', name: `qa2._domainkey.${domain}`, value: 'qa2.dkim.amazonses.com', purpose: 'DKIM' },
    { type: 'MX', name: `bounce.${domain}`, value: '10 feedback-smtp.eu-west-3.amazonses.com', purpose: 'MAIL FROM' },
    { type: 'TXT', name: `bounce.${domain}`, value: 'v=spf1 include:amazonses.com ~all', purpose: 'SPF' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`, purpose: 'DMARC' },
  ];
}

async function upsertDomain(fixture, scope, transaction) {
  const domain = `qa-email-${fixture.key}-clinic-${scope.clinica_id}.test`;
  const [row] = await db.EmailSendingDomain.findOrCreate({
    where: { domain },
    defaults: {
      public_id: `ed_dev_qa_${fixture.key}_${scope.clinica_id}`,
      ...scope,
      domain,
      identity_name: domain,
      created_by: null,
    },
    transaction,
  });
  if (row.scope_key !== scope.scope_key) throw new Error(`Fixture domain ${domain} belongs to another scope.`);
  await row.update({
    ...scope,
    identity_name: domain,
    status: fixture.status,
    verification_status: fixture.verification_status,
    dkim_status: fixture.dkim_status,
    spf_status: fixture.spf_status,
    dmarc_status: fixture.dmarc_status,
    mail_from_domain: `bounce.${domain}`,
    mail_from_status: fixture.mail_from_status,
    dns_records: dnsRecords(domain),
    provider_snapshot: { mock: true, source: 'isolated_dev_fixture', state: fixture.key },
    last_error_code: fixture.error ? 'DEV_QA_PROVIDER_ERROR' : null,
    last_error_message: fixture.error ? 'Incidencia ficticia para comprobar el estado visual de error.' : null,
    checked_at: new Date(),
  }, { transaction });
  return row;
}

async function upsertSender(fixture, domain, scope, transaction) {
  const email = `${fixture.sender}@${domain.domain}`;
  const [row] = await db.EmailSenderIdentity.findOrCreate({
    where: { scope_key: scope.scope_key, email },
    defaults: {
      public_id: `es_dev_qa_${fixture.key}_${scope.clinica_id}`,
      ...scope,
      domain_id: domain.id,
      email,
      display_name: fixture.display_name,
      reply_to: `recepcion@${domain.domain}`,
      status: 'active',
      verification_status: fixture.verification_status,
      is_default: fixture.is_default === true,
      created_by: null,
    },
    transaction,
  });
  await row.update({
    ...scope,
    domain_id: domain.id,
    display_name: fixture.display_name,
    reply_to: `recepcion@${domain.domain}`,
    status: 'active',
    verification_status: fixture.verification_status,
    is_default: fixture.is_default === true,
  }, { transaction });
  return row;
}

async function upsertEmailTemplate(scope, transaction) {
  const publicId = `et_dev_qa_welcome_${scope.clinica_id}`;
  const design = {
    header_color: '#2563eb',
    footer_color: '#0f172a',
    background_color: '#f1f5f9',
    content_color: '#ffffff',
    text_color: '#1e293b',
    logo_url: null,
    show_clinicaclick_branding: true,
    blocks: [
      { type: 'heading', text: 'Hola {{nombre}}' },
      { type: 'text', text: 'Este es un contenido ficticio de DEV para comprobar el editor y el recorrido completo de una campaña.' },
      { type: 'button', text: 'Conocer novedades', url: 'https://clinicaclick.com' },
    ],
  };
  const renderedHtml = '<!doctype html><html><body><h1>Hola {{nombre}}</h1><p>Este es un contenido ficticio de DEV para comprobar el editor y el recorrido completo de una campaña.</p></body></html>';
  const [template] = await db.MarketingEmailTemplate.findOrCreate({
    where: { public_id: publicId },
    defaults: {
      public_id: publicId,
      ...scope,
      name: 'Novedades DEV · contenido de prueba',
      status: 'ready',
      subject: 'Novedades de {{clinica}}',
      preheader: 'Contenido ficticio para validar el asistente',
      layout_key: 'classic',
      design,
      rendered_html: renderedHtml,
      rendered_text: 'Hola {{nombre}}\n\nEste es un contenido ficticio de DEV para comprobar el editor y el recorrido completo de una campaña.',
      version: 1,
      origin: 'custom',
    },
    transaction,
  });
  await template.update({
    ...scope,
    name: 'Novedades DEV · contenido de prueba',
    status: 'ready',
    subject: 'Novedades de {{clinica}}',
    preheader: 'Contenido ficticio para validar el asistente',
    layout_key: 'classic',
    design,
    rendered_html: renderedHtml,
    rendered_text: 'Hola {{nombre}}\n\nEste es un contenido ficticio de DEV para comprobar el editor y el recorrido completo de una campaña.',
  }, { transaction });
  return template;
}

async function upsertMassSendFixture(fixture, scope, transaction) {
  const listScope = {
    scope_type: scope.scope_type,
    clinica_id: scope.clinica_id,
    grupo_clinica_id: scope.grupo_clinica_id,
  };
  const [list] = await db.MarketingPatientList.findOrCreate({
    where: { clinica_id: scope.clinica_id, name: fixture.name, source: 'dev_fixture' },
    defaults: {
      name: fixture.name,
      objective_id: 'mass_sends',
      source: 'dev_fixture',
      status: fixture.status,
      ...listScope,
    },
    transaction,
  });
  const total = fixture.items.length;
  const sent = fixture.items.filter(item => item.dispatch_status === 'sent' || item.dispatch_status === 'read').length;
  const read = fixture.items.filter(item => item.dispatch_status === 'read').length;
  await list.update({
    status: fixture.status,
    action_mode: 'whatsapp',
    channel: 'whatsapp',
    condition_summary: 'Datos ficticios exclusivos de DEV para revisar el flujo visual.',
    exclusion_summary: 'Sin exclusiones en esta muestra.',
    criteria: {
      dev_fixture: true,
      dev_fixture_key: fixture.key,
      record_kind: fixture.recordKind,
      source_list_id: null,
      campaign_name: fixture.name,
      list_name: fixture.name,
      channels: ['whatsapp'],
      template_usage: 'promocion',
      template_commercial: true,
      consent_acknowledged: true,
      list_source: 'manual_list',
      sender_snapshot: { label: 'WhatsApp secundario DEV', role: 'secondary' },
      dispatch: fixture.dispatch || null,
    },
    counters: { total, ready: Math.max(0, total - sent), selected: total, sent, delivered: sent, read, replied: 0, excluded: 0 },
    metrics: { total_cost: 0, estimated_revenue: 0 },
    safety_gates: fixture.recordKind === 'campaign'
      ? { frozen_audience: true, opt_out: true, approved_template: true, audit: true, capping: true, cancelable_queue: true }
      : { frozen_audience: true, opt_out: true, approved_template: false, audit: true, capping: false, cancelable_queue: false },
    template_snapshot: fixture.recordKind === 'campaign'
      ? { id: 900000 + scope.clinica_id, name: 'clinicaclick_dev_promocion', status: 'APPROVED', language: 'es' }
      : null,
    prepared_at: fixture.recordKind === 'campaign' ? new Date(Date.now() - 60 * 60 * 1000) : null,
    last_sent_at: sent ? new Date(Date.now() - 20 * 60 * 1000) : null,
  }, { transaction });
  await db.MarketingPatientListItem.destroy({ where: { list_id: list.id }, transaction });
  await db.MarketingPatientListItem.bulkCreate(fixture.items.map((item, index) => ({
    list_id: list.id,
    clinica_id: scope.clinica_id,
    name: item.name,
    phone: `+34610000${String(scope.clinica_id).padStart(2, '0')}${index}`,
    email: `qa.mass.${scope.clinica_id}.${index}@example.test`,
    status: 'ready',
    selected: true,
    custom_fields: { ciudad: index % 2 ? 'Barcelona' : 'Madrid', dev_fixture: true },
    missing_variables: [],
    dispatch_status: item.dispatch_status || null,
    sent_at: item.dispatch_status ? new Date(Date.now() - (index + 1) * 10 * 60 * 1000) : null,
    delivered_at: item.dispatch_status ? new Date(Date.now() - (index + 1) * 9 * 60 * 1000) : null,
    read_at: item.dispatch_status === 'read' ? new Date(Date.now() - (index + 1) * 8 * 60 * 1000) : null,
  })), { transaction });
  return list;
}

async function main() {
  if (process.env.RUNTIME_NAMESPACE !== 'dev') {
    throw new Error('This fixture is restricted to RUNTIME_NAMESPACE=dev.');
  }
  const requestedClinicId = Number(process.argv.find(arg => arg.startsWith('--clinic-id='))?.split('=')[1] || 0);
  const clinic = requestedClinicId
    ? await db.Clinica.findByPk(requestedClinicId, { attributes: ['id_clinica', 'nombre_clinica'], raw: true })
    : await db.Clinica.findOne({ attributes: ['id_clinica', 'nombre_clinica'], order: [['id_clinica', 'ASC']], raw: true });
  if (!clinic) throw new Error('No DEV clinic is available for the email settings fixture.');

  const scope = {
    scope_type: 'clinic',
    scope_key: `clinic:${Number(clinic.id_clinica)}`,
    clinica_id: Number(clinic.id_clinica),
    grupo_clinica_id: null,
  };
  const fixtures = [
    { key: 'ready', sender: 'hola', display_name: 'Clínica ficticia DEV', is_default: true, status: 'active', verification_status: 'verified', dkim_status: 'verified', spf_status: 'verified', dmarc_status: 'verified', mail_from_status: 'success' },
    { key: 'pending', sender: 'citas', display_name: 'Citas DEV · pendiente', status: 'pending', verification_status: 'pending', dkim_status: 'pending', spf_status: 'pending', dmarc_status: 'pending', mail_from_status: 'pending' },
    { key: 'failed', sender: 'incidencias', display_name: 'Remitente DEV · error', status: 'failed', verification_status: 'failed', dkim_status: 'failed', spf_status: 'failed', dmarc_status: 'failed', mail_from_status: 'failed', error: true },
  ];

  await db.sequelize.transaction(async transaction => {
    await db.EmailSenderIdentity.update({ is_default: false }, { where: { scope_key: scope.scope_key }, transaction });
    let readyDomain = null;
    for (const fixture of fixtures) {
      const domain = await upsertDomain(fixture, scope, transaction);
      await upsertSender(fixture, domain, scope, transaction);
      if (fixture.key === 'ready') readyDomain = domain;
    }
    await upsertSender({
      key: 'ready_alt',
      sender: 'marketing',
      display_name: 'Marketing DEV',
      verification_status: 'verified',
      is_default: false,
    }, readyDomain, scope, transaction);
    await upsertEmailTemplate(scope, transaction);
    await upsertMassSendFixture({
      key: 'recipients',
      name: 'DEV · Lista pacientes septiembre',
      status: 'draft',
      recordKind: 'recipient_list',
      items: [{ name: 'Ana Prueba' }, { name: 'Luis Prueba' }, { name: 'Marta Prueba' }],
    }, scope, transaction);
    await upsertMassSendFixture({
      key: 'draft',
      name: 'DEV · Campaña WhatsApp en borrador',
      status: 'draft',
      recordKind: 'campaign',
      items: [{ name: 'Elena Demo' }, { name: 'Álvaro Demo' }, { name: 'Sofía Demo' }],
    }, scope, transaction);
    await upsertMassSendFixture({
      key: 'sending',
      name: 'DEV · Campaña WhatsApp en curso',
      status: 'sending',
      recordKind: 'campaign',
      dispatch: { status: 'waiting_next_batch', label: 'Envío regulado DEV', next_allowed_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
      items: [{ name: 'Carlos Demo', dispatch_status: 'read' }, { name: 'Noa Demo', dispatch_status: 'sent' }, { name: 'Pablo Demo' }, { name: 'Irene Demo' }],
    }, scope, transaction);
    await upsertMassSendFixture({
      key: 'completed',
      name: 'DEV · Campaña WhatsApp completada',
      status: 'completed',
      recordKind: 'campaign',
      dispatch: { status: 'completed', label: 'Envío completado DEV', completed_at: new Date().toISOString() },
      items: [{ name: 'Lucía Demo', dispatch_status: 'read' }, { name: 'Mario Demo', dispatch_status: 'read' }, { name: 'Raquel Demo', dispatch_status: 'sent' }],
    }, scope, transaction);
  });
  console.log(JSON.stringify({
    ok: true,
    runtime: process.env.RUNTIME_NAMESPACE,
    clinic: { id: scope.clinica_id, name: clinic.nombre_clinica },
    domains: fixtures.length,
    senders: fixtures.length + 1,
    email_templates: 1,
    mass_send_fixtures: 4,
  }));
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
