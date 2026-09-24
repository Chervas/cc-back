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
  });
  console.log(JSON.stringify({
    ok: true,
    runtime: process.env.RUNTIME_NAMESPACE,
    clinic: { id: scope.clinica_id, name: clinic.nombre_clinica },
    domains: fixtures.length,
    senders: fixtures.length + 1,
  }));
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
