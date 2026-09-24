'use strict';
const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const templates = require('../../services/emailTemplates.service');
const delivery = require('../../services/emailDelivery.service');
const provider = require('../../services/emailProvider.service');
const dispatch = require('../../services/marketingEmailDispatch.service');
const marketingEmail = require('../../services/marketingEmail.service');
const migration = require('../../../migrations/20260923120000-create-marketing-email-system');
const catalogMigration = require('../../../migrations/20260924100000-marketing-email-template-catalog');

test('marketing email migration creates globally owned domains and expands the stored sender header', async () => {
  const calls = [];
  const queryInterface = {
    async createTable(name, columns) { calls.push(['createTable', name, columns]); },
    async addIndex(table, fields, options) { calls.push(['addIndex', table, fields, options]); },
    async addColumn(table, column, definition) { calls.push(['addColumn', table, column, definition]); },
    async changeColumn(table, column, definition) { calls.push(['changeColumn', table, column, definition]); },
  };
  await migration.up(queryInterface, Sequelize);
  const ownerIndex = calls.find(call => call[0] === 'addIndex' && call[3]?.name === 'uq_email_sending_domain_owner');
  assert.deepEqual(ownerIndex?.[2], ['domain']);
  assert.equal(ownerIndex?.[3]?.unique, true);
  const senderHeader = calls.find(call => call[0] === 'changeColumn' && call[1] === 'EmailMessages' && call[2] === 'from_email');
  assert.equal(senderHeader?.[3]?.type?.options?.length, 512);
});

test('email catalog migration seeds one system playbook for clinic and group scopes', async () => {
  const calls = [];
  const queryInterface = {
    async showAllTables() { return ['MarketingEmailTemplates']; },
    async describeTable() { return {}; },
    async showIndex() { return []; },
    async createTable(name, columns) { calls.push(['createTable', name, columns]); },
    async addIndex(table, fields, options) { calls.push(['addIndex', table, fields, options]); },
    async addColumn(table, column, definition) { calls.push(['addColumn', table, column, definition]); },
    async bulkInsert(table, rows) { calls.push(['bulkInsert', table, rows]); },
    sequelize: {
      async query(sql) {
        if (sql.includes('MarketingEmailTemplateCatalog')) return [{ id: 7 }];
        if (sql.includes('FROM Clinicas')) return [{ id_clinica: 21 }];
        if (sql.includes('FROM GruposClinicas')) return [{ id_grupo: 8 }];
        return [];
      },
    },
  };
  await catalogMigration.up(queryInterface, Sequelize);
  assert.ok(calls.some(call => call[0] === 'createTable' && call[1] === 'MarketingEmailTemplateCatalog'));
  const instances = calls.find(call => call[0] === 'bulkInsert' && call[1] === 'MarketingEmailTemplates')?.[2] || [];
  assert.deepEqual(instances.map(row => row.scope_key).sort(), ['clinic:21', 'group:8']);
  assert.ok(instances.every(row => row.origin === 'system' && row.catalog_template_id === 7));
});

test('email catalog migration resumes safely after its catalog table was created', async () => {
  const writes = [];
  const queryInterface = {
    async showAllTables() { return ['MarketingEmailTemplateCatalog', 'MarketingEmailTemplates']; },
    async describeTable() {
      return { catalog_template_id: {}, catalog_version: {}, origin: {} };
    },
    async showIndex() { return [{ name: 'uq_marketing_email_system_template_scope' }]; },
    async createTable() { writes.push('createTable'); },
    async addIndex() { writes.push('addIndex'); },
    async addColumn() { writes.push('addColumn'); },
    async bulkInsert() { writes.push('bulkInsert'); },
    sequelize: {
      async query(sql) {
        if (sql.includes('MarketingEmailTemplateCatalog')) return [{ id: 7 }];
        if (sql.includes('FROM Clinicas')) return [{ id_clinica: 21 }];
        if (sql.includes('FROM GruposClinicas')) return [{ id_grupo: 8 }];
        if (sql.includes('FROM MarketingEmailTemplates')) return [{ scope_key: 'clinic:21' }, { scope_key: 'group:8' }];
        return [];
      },
    },
  };

  await catalogMigration.up(queryInterface, Sequelize);

  assert.deepEqual(writes, []);
});

test('marketing renderer always adds one visible unsubscribe action and Clinicaclick attribution', () => {
  const rendered = templates.renderMarketingCampaign({
    subject: 'Novedades de la clínica',
    body_html: '<!doctype html><html><body><p>Hola {{nombre}}</p></body></html>',
    body_text: 'Hola {{nombre}}',
    unsubscribe_url: 'https://crm.example.test/email/baja?token=fictitious',
  });
  assert.equal((rendered.html.match(/Dejar de recibir estas comunicaciones/g) || []).length, 1);
  assert.equal((rendered.html.match(/Enviado con Clinicaclick/g) || []).length, 1);
  assert.match(rendered.text, /https:\/\/crm\.example\.test\/email\/baja/);
  assert.deepEqual(templates.missingTemplateVariables({ nombre: 'Ana' }, rendered.subject, rendered.html), []);
  assert.deepEqual(templates.missingTemplateVariables({}, rendered.html), ['nombre']);
});

test('contact variables are HTML-escaped while plain text remains readable', () => {
  const context = { nombre: '<img src=x onerror=alert(1)> Ana' };
  assert.equal(templates.replaceVars('<p>{{nombre}}</p>', context, { html: true }), '<p>&lt;img src=x onerror=alert(1)&gt; Ana</p>');
  assert.equal(templates.replaceVars('Hola {{nombre}}', context), 'Hola <img src=x onerror=alert(1)> Ana');
});

test('marketing outbox refuses a message without explicit consent or unsubscribe URL before touching storage', async () => {
  await assert.rejects(delivery.queueEmail({
    stream: 'marketing',
    templateKey: 'marketing.campaign',
    recipientEmail: 'qa@example.test',
    marketingConsent: true,
    templateContext: { body_html: '<p>QA</p>' },
  }), { code: 'email_marketing_consent_and_unsubscribe_required' });
});

test('real SES marketing cannot bypass the broker with local AWS credentials', async () => {
  await assert.rejects(provider.sendEmail({ stream: 'marketing' }, { env: {
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
    EMAIL_MARKETING_ENABLED: 'true',
    EMAIL_BROKER_ENABLED: 'false',
    EMAIL_AWS_ACCESS_KEY_ID: 'AKIAFICTITIOUS1234567',
    EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_EMAIL_SECRET_0123456789',
  } }), { code: 'email_marketing_broker_required', retryable: false });
});

test('campaign dispatch fails closed before reading recipients when the marketing provider is unavailable', async t => {
  t.mock.method(provider, 'publicConfig', () => ({
    provider: 'ses',
    enabled: true,
    marketingEnabled: true,
    brokerEnabled: false,
    brokerConfigured: false,
  }));
  t.mock.method(db.MarketingPatientListItem, 'count', async () => {
    assert.fail('recipient storage must not be read while the provider is unavailable');
  });
  await assert.rejects(dispatch.assertReady({
    id: 12,
    scope_type: 'clinic',
    clinica_id: 21,
  }), { code: 'marketing_email_provider_not_ready', status: 503 });
});

test('email suppression lookup includes the owning group as well as clinic and global scope', async t => {
  let capturedWhere = null;
  t.mock.method(db.EmailSuppression, 'findOne', async options => {
    capturedWhere = options.where;
    return null;
  });
  await delivery.findActiveSuppression({
    emailHash: 'a'.repeat(64),
    stream: 'marketing',
    clinicaId: 21,
    groupId: 8,
  });
  assert.deepEqual(capturedWhere.scope[Object.getOwnPropertySymbols(capturedWhere.scope)[0]], [
    'global',
    'clinic:21',
    'group:8',
  ]);
});

test('a SES domain already owned by another scope is rejected before provider access', async t => {
  t.mock.method(db.EmailSendingDomain, 'findOne', async () => ({ domain: 'clinic.example', scope_key: 'clinic:22' }));
  await assert.rejects(marketingEmail.addDomain({ scope: 'clinic', clinicIds: [21] }, {
    domain: 'clinic.example',
  }, 1), { code: 'email_domain_owned_by_another_scope', status: 409 });
});

test('refreshing a DEV mock domain never contacts the email provider', async t => {
  const previousRuntime = process.env.RUNTIME_NAMESPACE;
  process.env.RUNTIME_NAMESPACE = 'dev';
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.RUNTIME_NAMESPACE;
    else process.env.RUNTIME_NAMESPACE = previousRuntime;
  });
  const row = {
    id: 31,
    public_id: 'ed_dev_qa_ready_21',
    scope_key: 'clinic:21',
    domain: 'qa-email-ready-clinic-21.test',
    status: 'active',
    verification_status: 'verified',
    dkim_status: 'verified',
    spf_status: 'verified',
    dmarc_status: 'verified',
    mail_from_domain: 'bounce.qa-email-ready-clinic-21.test',
    mail_from_status: 'success',
    dns_records: [],
    provider_snapshot: { mock: true },
    checked_at: new Date(0),
    get(argument) { return argument === 'provider_snapshot' ? this.provider_snapshot : { ...this }; },
    async update(values) { Object.assign(this, values); return this; },
    async reload() { return this; },
  };
  t.mock.method(db.EmailSendingDomain, 'findOne', async () => row);

  const refreshed = await marketingEmail.refreshDomain({ scope: 'clinic', clinicIds: [21] }, row.public_id);

  assert.equal(refreshed.status, 'active');
  assert.ok(row.checked_at.getTime() > 0);
});

test('DEV domain setup builds a pending identity without provider credentials', () => {
  const identity = marketingEmail.buildDevMockIdentity('clinic.example');
  assert.equal(identity.mock, true);
  assert.equal(identity.verifiedForSending, false);
  assert.equal(identity.verificationStatus, 'pending');
  assert.equal(identity.dkimStatus, 'pending');
  assert.equal(identity.mailFromDomain, 'bounce.clinic.example');
  assert.equal(identity.dkimTokens.length, 3);
});

test('SES DNS setup keeps the clinic root SPF untouched and gates senders on custom MAIL FROM', () => {
  const records = marketingEmail.dnsRecords('clinic.example', {
    dkimTokens: ['token_one'],
    mailFromDomain: 'bounce.clinic.example',
  });
  assert.deepEqual(records.filter(record => record.purpose === 'SPF'), [{
    type: 'TXT',
    name: 'bounce.clinic.example',
    value: 'v=spf1 include:amazonses.com ~all',
    purpose: 'SPF',
  }]);
  assert.deepEqual(records.filter(record => record.purpose === 'MAIL FROM'), [{
    type: 'MX',
    name: 'bounce.clinic.example',
    value: '10 feedback-smtp.eu-west-3.amazonses.com',
    purpose: 'MAIL FROM',
  }]);
  assert.equal(marketingEmail.serializeSender({
    status: 'active',
    verification_status: 'verified',
    domain: {
      verification_status: 'verified',
      dkim_status: 'verified',
      spf_status: 'verified',
      mail_from_status: 'pending',
    },
  }).ready, false);
});

test('system email templates are read-only and expose their catalog ownership', async t => {
  const systemTemplate = {
    id: 11,
    public_id: 'et_system',
    scope_key: 'clinic:21',
    name: 'Sistema',
    subject: 'Hola',
    layout_key: 'classic',
    design: marketingEmail.DEFAULT_DESIGN,
    version: 4,
    origin: 'system',
    catalog_template_id: 7,
    catalog_version: 4,
  };
  const serialized = marketingEmail.serializeTemplate(systemTemplate);
  assert.equal(serialized.is_system, true);
  assert.equal(serialized.editable, false);
  assert.equal(serialized.catalog_version, 4);
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => systemTemplate);
  await assert.rejects(marketingEmail.saveTemplate({ scope: 'clinic', clinicIds: [21] }, {
    name: 'Cambio indebido',
    subject: 'Cambio indebido',
    design: marketingEmail.DEFAULT_DESIGN,
  }, 1, 'et_system'), { code: 'email_system_template_read_only', status: 409 });
});

test('duplicating a system email template creates an independent custom copy', async t => {
  const source = {
    id: 11,
    public_id: 'et_system',
    scope_key: 'clinic:21',
    name: 'Sistema',
    subject: 'Hola {{nombre}}',
    preheader: 'Prueba',
    layout_key: 'classic',
    design: marketingEmail.DEFAULT_DESIGN,
    rendered_html: '<html></html>',
    rendered_text: 'Hola',
    version: 3,
    origin: 'system',
    catalog_template_id: 7,
  };
  let created = null;
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => source);
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => {
    created = values;
    return { id: 12, ...values };
  });
  const duplicated = await marketingEmail.duplicateTemplate(
    { scope: 'clinic', clinicIds: [21] },
    'et_system',
    {},
    1
  );
  assert.equal(created.origin, 'custom');
  assert.equal(created.catalog_template_id, null);
  assert.equal(created.catalog_version, null);
  assert.equal(duplicated.editable, true);
  assert.match(duplicated.name, /^Copia de /);
});

test('catalog propagation updates linked instances in place and creates only missing scopes', async t => {
  const catalog = {
    id: 7,
    public_id: 'etc_system',
    name: 'Sistema actualizado',
    status: 'ready',
    subject: 'Hola {{nombre}}',
    preheader: 'Prueba',
    layout_key: 'classic',
    design: marketingEmail.DEFAULT_DESIGN,
    rendered_html: '<html></html>',
    rendered_text: 'Hola',
    version: 5,
    is_active: true,
    async update(values) { Object.assign(this, values); },
  };
  const existing = {
    id: 41,
    public_id: 'et_existing',
    scope_key: 'clinic:21',
    async update(values) { Object.assign(this, values); },
  };
  const created = [];
  t.mock.method(db.MarketingEmailTemplateCatalog, 'findOne', async () => catalog);
  t.mock.method(db.Clinica, 'findAll', async () => [{ id_clinica: 21 }]);
  t.mock.method(db.GrupoClinica, 'findAll', async () => [{ id_grupo: 8 }]);
  t.mock.method(db.sequelize, 'transaction', async callback => callback({ id: 'test-transaction' }));
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async ({ where }) => (
    where.scope_key === 'clinic:21' ? existing : null
  ));
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => {
    created.push(values);
    return values;
  });

  const result = await marketingEmail.propagateCatalogTemplate('etc_system', 1);

  assert.deepEqual({ scopes: result.scopes, created: result.created, updated: result.updated }, {
    scopes: 2,
    created: 1,
    updated: 1,
  });
  assert.equal(existing.id, 41);
  assert.equal(existing.catalog_version, 5);
  assert.equal(existing.origin, 'system');
  assert.equal(created[0].scope_key, 'group:8');
  assert.equal(created[0].catalog_template_id, 7);
  assert.equal(catalog.propagation_state, 'complete');
  assert.ok(catalog.last_propagated_at instanceof Date);
});

test('a paused campaign holds already queued email jobs before rendering or provider access', async t => {
  const message = {
    id: 91,
    status: 'queued',
    related_type: 'marketing_bulk_send',
    metadata: { list_id: 12 },
  };
  t.mock.method(db.EmailMessage, 'findByPk', async () => message);
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => ({ id: 12, email_dispatch: { status: 'paused' } }));
  const result = await delivery.runEmailSendJob({ email_message_id: 91 }, { attempts: 1 });
  assert.equal(result.status, 'waiting');
  assert.equal(result.result.paused, true);
  assert.ok(result.nextRunAt instanceof Date);
});

test('email delivery materialization is idempotent and closes an email-only campaign once', async t => {
  let eventCount = 0;
  const state = { status: 'queued', email_message_id: 71, provider_message_id: null };
  const item = {
    id: 7,
    list_id: 3,
    paciente_id: 5,
    email: 'qa@example.test',
    status: 'ready',
    selected: true,
    channel_status: { email: state },
    get() { return { ...this, channel_status: this.channel_status }; },
    async update(patch) { Object.assign(this, patch); },
  };
  const list = {
    id: 3,
    criteria: { channels: ['email'] },
    email_dispatch: { status: 'awaiting_delivery' },
    async update(patch) { Object.assign(this, patch); },
  };
  t.mock.method(db.MarketingPatientListItem, 'findOne', async () => item);
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => [item]);
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientContactEvent, 'create', async () => { eventCount += 1; });
  const message = { id: 71, status: 'sent', related_type: 'marketing_bulk_send', metadata: { list_id: 3, item_id: 7 }, provider_message_id: 'provider-71', sent_at: new Date() };
  assert.equal((await dispatch.materializeEmailMessage(message)).applied, true);
  assert.equal((await dispatch.materializeEmailMessage(message)).applied, false);
  assert.equal(eventCount, 1);
  assert.equal(list.status, 'completed');
  assert.equal(list.email_dispatch.status, 'completed');
});
