'use strict';
// Real production services/models and native SQL on an owned socket-only MySQL.
// No provider, runtime database or real documents are admitted by this fixture.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module'), { DataTypes: D } = require('sequelize'), { randomUUID, createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { accountingService } = require('./helpers/accounting-cash-test-loader');
function load(file, overrides) {
  const local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, Date, Map, Set, Object,
    process: { env: {} }, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename: file });
  return module.exports;
}
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  db.GrupoClinica = sql.define('GrupoClinica', { id_grupo: { type: D.INTEGER, primaryKey: true }, nombre_grupo: D.STRING }, { timestamps: false });
  db.Usuario = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, nombre: D.STRING, apellidos: D.STRING,
    email_usuario: D.STRING, emails_alternativos: D.JSON, email_factura: D.STRING, email_notificacion: D.STRING, password_usuario: D.STRING,
    cargo_usuario: D.STRING, estado_cuenta: D.STRING, es_provisional: D.BOOLEAN, creado_por: D.INTEGER, ultimo_login: D.DATE }, { tableName: 'Usuarios', timestamps: false });
  sql.define('ClinicMetaAsset', { id: { type: D.INTEGER, primaryKey: true } }, { tableName: 'ClinicMetaAssets', timestamps: false });
  for (const file of ['accountingfirm', 'accountingfirmclinicassignment', 'accountingfirmuser', 'usuarioclinica', 'synclog',
    'accountingingestionjob', 'clinicalprivateasset', 'accountingexpensedocument']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  // Auth proof storage columns are real SQL; proof issuance/verification is
  // already covered by the canonical auth suite, not replaced with a bypass.
  for (const name of ['AuthSession', 'AuthEmailChallenge', 'AuthTrustedDevice', 'PasswordResetToken']) db[name] = sql.define(name, {
    id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, user_id: D.INTEGER, state: D.STRING,
    status: D.STRING, ended_at: D.DATE, revoked_at: D.DATE }, { timestamps: false });
  await sql.sync(); await db.Clinica.bulkCreate([{ id_clinica: 72, nombre_clinica: 'Ficticia A' }, { id_clinica: 73, nombre_clinica: 'Ficticia B' }]);
  const accounting = accountingService(db);
  const storage = { storeClinicalPrivateAsset: async input => db.ClinicalPrivateAsset.create({ public_id: randomUUID(), clinic_id: input.clinicId,
    purpose: input.purpose, owner_type: input.ownerType, bucket: 'owned-test-only', object_key: randomUUID(), original_filename: input.originalFilename,
    content_type: input.contentType, size_bytes: input.buffer.length, sha256: createHash('sha256').update(input.buffer).digest('hex') }) };
  const ingestion = load(require.resolve('../../services/accountingIngestion.service'), { '../../models': db, './accounting.service': accounting,
    './clinicalPrivateStorage.service': storage, './aiBroker.service': { enabled: () => false } });
  const input = { clinicId: 72, actorId: 5, attachment: { filename: 'synthetic.pdf', content_type: 'application/pdf', base64: Buffer.from('%PDF-1.4\nsynthetic-only').toString('base64') } };
  const admitted = await Promise.all([ingestion.enqueue(input), ingestion.enqueue(input)]);
  assert.equal(await db.ClinicalPrivateAsset.count(), 1); assert.equal(await db.AccountingIngestionJob.count(), 1);
  assert.equal(admitted[0].id, admitted[1].id); assert.equal(admitted.filter(value => value.duplicate).length, 1);
  report.checks.push('Two concurrent production enqueue commands use native GET_LOCK and create exactly one asset/job; duplicate returns the same canonical public ID.');
  await ingestion.enqueue({ ...input, clinicId: 73 }); assert.equal(await db.AccountingIngestionJob.count(), 2);
  let interrupted = false;
  db.AccountingIngestionJob.addHook('beforeCreate', 'owned-interruption', () => { if (!interrupted) { interrupted = true; throw Error('OWNED_INSERT_FAILURE'); } });
  const retryInput = { ...input, attachment: { ...input.attachment, base64: Buffer.from('%PDF-1.4\nsynthetic-retry').toString('base64') } };
  await assert.rejects(ingestion.enqueue(retryInput), /OWNED_INSERT_FAILURE/); db.AccountingIngestionJob.removeHook('beforeCreate', 'owned-interruption');
  await ingestion.enqueue(retryInput); assert.equal(await db.ClinicalPrivateAsset.count(), 3); assert.equal(await db.AccountingIngestionJob.count(), 3);
  report.checks.push('Foreign clinic admission remains independent; interrupted job insert recovers the same stored original on retry without a second asset.');
  const job = await db.AccountingIngestionJob.findOne({ where: { public_id: admitted[0].id } }); await job.update({ status: 'review' });
  const payload = { currency: 'EUR', supplier_name: 'Synthetic supplier', document_number: 'SYNTHETIC-001', issue_date: '2026-10-21', category: 'Otros',
    status: 'pending', payment_method: 'transfer', taxable_base: 10, tax_amount: 2.1, withholding_amount: 0, total: 12.1 };
  db.AccountingIngestionJob.addHook('beforeUpdate', 'owned-accept-failure', value => { if (value.status === 'accepted') throw Error('OWNED_ACCEPT_FAILURE'); });
  await assert.rejects(ingestion.accept({ publicId: job.public_id, clinicId: 72, actorId: 5, payload }), /OWNED_ACCEPT_FAILURE/);
  db.AccountingIngestionJob.removeHook('beforeUpdate', 'owned-accept-failure');
  assert.equal(await db.AccountingExpenseDocument.count(), 0); assert.equal((await job.reload()).status, 'review');
  const accepted = await Promise.all([ingestion.accept({ publicId: job.public_id, clinicId: 72, actorId: 5, payload }), ingestion.accept({ publicId: job.public_id, clinicId: 72, actorId: 5, payload })]);
  assert.equal(await db.AccountingExpenseDocument.count(), 1); assert.equal(accepted.filter(value => value.already_accepted).length, 1);
  report.checks.push('Injected failure after real expense INSERT rolls back both ledger and accepted state. Concurrent human accepts serialize under FOR UPDATE and return one expense plus an idempotent replay acknowledgment.');
  const firms = load(require.resolve('../../services/accountingFirms.service'), { '../../models': db,
    '../lib/access-policy': { canUserAccessFeature: async ({ actorId, clinicId, featureKey }) => actorId === 5 && clinicId === 72 && featureKey === 'accounting.firm.manage' } });
  const first = await firms.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' });
  const user = await db.Usuario.findOne({ where: { email_usuario: 'gestor@example.test' } }), previousHash = user.password_usuario;
  assert(await bcrypt.compare(first.credentials.password, previousHash));
  for (const name of ['AuthSession', 'AuthEmailChallenge', 'AuthTrustedDevice', 'PasswordResetToken']) await db[name].create({ user_id: user.id_usuario, state: 'active', status: 'pending', revoked_at: null });
  db.SyncLog.addHook('beforeCreate', 'owned-reset-failure', value => { if (value.job_type === 'accounting_firm_access') throw Error('OWNED_ACCESS_FAILURE'); });
  await assert.rejects(firms.issueCredentials({ clinicId: 72, actorId: 5, email: 'gestor@example.test' }), /OWNED_ACCESS_FAILURE/);
  db.SyncLog.removeHook('beforeCreate', 'owned-reset-failure');
  assert.equal((await user.reload()).password_usuario, previousHash); assert.equal((await db.AuthSession.findOne()).state, 'active');
  await firms.revokeAccess({ clinicId: 72, actorId: 5 }); assert.equal((await user.reload()).estado_cuenta, 'inactivo');
  assert.equal((await db.AuthSession.findOne()).state, 'revoked'); assert((await db.AuthTrustedDevice.findOne()).revoked_at);
  assert.equal((await db.PasswordResetToken.findOne()).status, 'revoked');
  assert.equal(await firms.isPortalUser({ actorId: user.id_usuario }), true);
  await assert.rejects(firms.portalScope({ actorId: user.id_usuario }), { code: 'accounting_portal_forbidden' });
  report.checks.push('Native credential reset failure rolls back hash and session revocation together. Explicit revoke closes account/session/device/reset proof while retaining restricted portal identity. Synthetic mailbox only; no email, login bypass, provider or runtime write.');
}).catch(error => { console.error(error); process.exitCode = 1; });
