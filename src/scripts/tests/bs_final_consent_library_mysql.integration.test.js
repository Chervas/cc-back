'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const op = require('../bs-final-consent-library');
const legacy = require('../bs-consent-catalog-withdrawal');
const { hash } = require('../../lib/cliniccloud-import/adapter');

test('final library publisher actual SQL dry-run, apply and zero-DML replay on exact fictitious 86/155 baseline', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = Sequelize;
  for (const name of ['ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'TreatmentConsentRequirement',
    'PatientConsentDocument', 'ConsentSignaturePackage', 'ConsentTemplateCatalog', 'ConsentTemplateCatalogVersion']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(sql, D);
  }
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER },
    { tableName: 'Clinicas', timestamps: false });
  db.Usuario = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, estado_cuenta: D.STRING(30), es_provisional: D.BOOLEAN },
    { tableName: 'Usuarios', timestamps: false });
  db.UsuarioClinica = sql.define('UsuarioClinica', { id: { type: D.INTEGER, primaryKey: true }, id_usuario: D.INTEGER,
    id_clinica: D.INTEGER, rol_clinica: D.STRING(40), estado_invitacion: D.STRING(40) }, { tableName: 'UsuarioClinica', timestamps: false });
  db.Tratamiento = sql.define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    nombre: D.STRING(100), clinical_config: D.JSON }, { tableName: 'Tratamientos', timestamps: false });
  await sql.sync(); // Empty DB owned/proved by fixture; never the live model index.
  await db.Clinica.bulkCreate([{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]);
  await db.Usuario.create({ id_usuario: 1, estado_cuenta: 'activo', es_provisional: false });
  const stamp = '2026-01-01T10:00:00Z';
  await db.ClinicConsentTemplate.bulkCreate(legacy.EXPECTED_IDS.map(id => ({ id, public_id: `qa-old-${id}`,
    clinic_id: id === 2 || id === 73 ? 66 : 72, catalog_key: `qa-old-${id}`, name: `Modelo ficticio ${id}`,
    purpose: legacy.DATA_PROTECTION_IDS.includes(id) ? 'data_protection' : 'clinical',
    status: legacy.DATA_PROTECTION_IDS.includes(id) ? 'active' : 'archived',
    is_default: legacy.DATA_PROTECTION_IDS.includes(id), blocking_policy: 'hard', validity_mode: 'manual',
    created_by: 1, createdAt: stamp, updatedAt: stamp })));
  await db.ClinicConsentTemplateVersion.bulkCreate(Array.from({ length: 155 }, (_, i) => ({ id: i + 1,
    clinic_template_id: legacy.EXPECTED_IDS[i % 86], version: i < 86 ? 1 : 2, locale: 'es', title: `Anterior ficticio ${i}`,
    body_json: { qa: true, text: 'Conservar anterior', nested: { z: 1, a: 2 } }, body_html: '<p>Original anterior ficticio</p>',
    status: 'published', published_at: stamp, created_by: 1, createdAt: stamp, updatedAt: stamp })));
  const oldPackage = await db.ConsentSignaturePackage.create({ public_id: 'qa-preserved-pack', paciente_id: 999,
    clinica_id: 72, status: 'signed', required_count: 1, signed_count: 1 });
  await db.PatientConsentDocument.create({ public_id: 'qa-preserved-signature', paciente_id: 999, clinica_id: 72,
    package_id: oldPackage.id, clinic_template_id: 90, clinic_template_version_id: 14, title: 'Evidencia ficticia',
    status: 'signed', signed_at: stamp, snapshot_json: { preserve: 'signature proof', nested: { z: true, a: false } },
    snapshot_html: '<p>Firma anterior ficticia inmutable</p>', snapshot_hash: 'qa-old-snapshot-hash' });
  await db.Tratamiento.create({ id_tratamiento: 999, clinica_id: 72, nombre: 'Tratamiento ficticio sin asociación', clinical_config: { preserve: true } });
  const body = '<section><h1>Documento editable ficticio</h1><p>' + 'Texto específico para una prueba aislada, no clínico real. '.repeat(1500) + '</p></section>';
  const bytes = Buffer.from(body);
  assert(bytes.length > 65535, 'Exercise actual MEDIUMTEXT and large JSON/HTML SQL binds');
  const sourcePackage = op.compilePackage({ zip_sha256: op.ZIP_SHA256, items: Array.from({ length: 44 }, (_, i) => ({
    source_sha256: i === 0 ? op.LOPD_SHA256 : hash(`owned-source-${i}`), filename: `ficticio-${i}.docx`, title: `Documento ficticio ${i}`,
    body_html_path: `/owned-fixture/body-${i}.html`, body_html_sha256: hash(bytes), body_json: { format: 'test-text', nested: { z: true, a: false } },
    review_approved: true,
  })) }, hash('owned-reviewed-fixture-manifest'), () => bytes);
  const configuration = { database: report.database, owned_fixture: true };
  const info = { commit: 'a'.repeat(40), pins: { fixture: hash('no application source mutation') } };
  const nativeOptions = { socketPath: sql.options.dialectOptions.socketPath, user: 'root', password: '',
    database: report.database, dateStrings: true, timezone: 'Z', multipleStatements: false };
  const native = await require('mysql2/promise').createConnection(nativeOptions);
  const independent = await require('mysql2/promise').createConnection(nativeOptions);
  const dml = [];
  const c = { query: async (query, values) => {
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(query)) dml.push(query.split(/\s+/).slice(0, 3).join(' '));
    return native.query(query, values);
  }, beginTransaction: () => native.beginTransaction(), commit: () => native.commit(), rollback: () => native.rollback() };
  const readIndependent = async () => {
    await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try { return await op.capture(independent, configuration, { actorId: 1 }); }
    finally { await independent.rollback(); }
  };
  try {
    const before = await readIndependent();
    assert.equal(before.templates.length, 86); assert.equal(before.versions.length, 155);
    assert.equal(before.protected.documents.statuses.signed, 1);
    const plan = op.makePlan({ before, info, sourcePackage, actorId: 1 });
    const journal = { append: async event => fs.appendFileSync(path.join(report.root, 'publisher-journal.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }) };
    const args = mode => ({ connection: c, plan, info, sourcePackage, configuration, actorId: 1,
      dryRun: mode === 'dry-run', journal, backupPath: path.join(report.root, `publisher-${mode}-backup.json`),
      readIndependent, checkSource: () => info, checkPackage: () => sourcePackage,
      saveBackup: (filename, backup) => fs.writeFileSync(filename, JSON.stringify(backup), { mode: 0o600, flag: 'wx' }) });
    const dry = await op.execute(args('dry-run'));
    assert.equal(dry.status, 'rolled_back_and_verified');
    assert.equal(dml.length, 181); assert.equal(hash(await readIndependent()), hash(before));
    report.checks.push('actual dry-run 88 inserts headers +88 versions +5 archives, exact rollback independent readback');
    dml.length = 0;
    const applied = await op.execute(args('apply'));
    assert.equal(applied.status, 'committed_and_verified'); assert.equal(dml.length, 181);
    assert.equal(applied.after.templates.length, 174); assert.equal(applied.after.versions.length, 243);
    assert.equal(op.verifyAfter(plan, await readIndependent(), applied.mutation_at).length, 88);
    assert.deepEqual(applied.after.protected, before.protected);
    assert.equal(applied.after.templates.filter(row => row.purpose === 'data_protection' && row.status === 'active' && row.is_default).length, 2);
    report.checks.push('actual apply 88+88+5 committed and independently verified; old versions/signed evidence/packages/treatments/catalog hashes untouched');
    dml.length = 0;
    const replay = await op.execute(args('replay'));
    assert.equal(replay.status, 'replay_preserved'); assert.equal(dml.length, 0);
    assert.equal(hash(replay.after), hash(applied.after));
    assert(!fs.existsSync(path.join(report.root, 'publisher-replay-backup.json')));
    report.checks.push('actual replay 0 DML, same complete after-image, no extra package/requirement/version/default');
  } finally { await native.end(); await independent.end(); }
}));
