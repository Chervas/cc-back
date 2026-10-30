'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createService } = require('../../services/reviewOverview.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
    configuracion: D.JSON, url_ficha_local: D.STRING, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  await db.Clinica.sync();
  const definitions = [
    'Pacientes (id_paciente INT PRIMARY KEY,clinica_id INT,nombre VARCHAR(80),apellidos VARCHAR(80),telefono_movil VARCHAR(40),fecha_baja DATETIME NULL)',
    'PacienteClinicas (paciente_id INT,clinica_id INT)',
    'CitasPacientes (id_cita INT PRIMARY KEY,paciente_id INT,clinica_id INT,estado VARCHAR(40),inicio DATETIME, INDEX(paciente_id,clinica_id))',
    'PatientCustomFields (paciente_id INT,clinica_id INT,field_key VARCHAR(80),value JSON)',
    'MarketingPatientLists (id INT PRIMARY KEY,clinica_id INT,objective_id VARCHAR(40),status VARCHAR(40),criteria JSON)',
    'MarketingPatientListItems (id INT PRIMARY KEY,list_id INT,clinica_id INT,paciente_id INT,name VARCHAR(80),phone VARCHAR(40),email VARCHAR(80),status VARCHAR(40),selected BOOL,dispatch_status VARCHAR(40),sent_at DATETIME,provider_message_id VARCHAR(80),app_message_id INT, INDEX(list_id))',
    'MarketingPatientContactEvents (id INT PRIMARY KEY AUTO_INCREMENT,list_id INT,item_id INT,paciente_id INT,event_type VARCHAR(80),payload JSON,occurred_at DATETIME,created_at DATETIME,INDEX(list_id,item_id))',
    'MarketingContactOptOuts (clinica_id INT,paciente_id INT,phone_digits VARCHAR(40),status VARCHAR(32),channel VARCHAR(32))',
    'Conversations (id INT PRIMARY KEY,clinic_id INT,channel VARCHAR(32),patient_id INT,contact_id VARCHAR(40))',
    'Messages (id INT PRIMARY KEY,conversation_id INT,status VARCHAR(40),metadata JSON,content TEXT,direction VARCHAR(20),message_type VARCHAR(20))',
    'WhatsappTemplates (id INT PRIMARY KEY,catalog_template_id INT,name VARCHAR(100))',
    'BusinessProfileReviews (id INT PRIMARY KEY AUTO_INCREMENT,clinica_id INT,business_location_id INT,review_name VARCHAR(200),star_rating INT,google_missing_at DATETIME,last_seen_at DATETIME,created_at DATETIME,first_seen_at DATETIME)',
  ];
  for (const definition of definitions) await sql.query('CREATE TABLE ' + definition);
  await db.Clinica.bulkCreate([{ id_clinica: 31, nombre_clinica: 'Clinic A', configuracion: {}, grupoClinicaId: 5 },
    { id_clinica: 32, nombre_clinica: 'Clinic B', configuracion: {}, grupoClinicaId: 5 },
    { id_clinica: 99, nombre_clinica: 'Outside', configuracion: {} }]);
  const query = (q, replacements = {}) => sql.query(q, { replacements, type: D.QueryTypes.SELECT });
  const insert = (table, values) => sql.getQueryInterface().bulkInsert(table, values);
  const patients = Array.from({ length: 10020 }, (_, n) => ({ id_paciente: n + 1, clinica_id: 31,
    nombre: 'Fictitious ' + n, apellidos: 'QA', telefono_movil: '34' + (610000000 + n), fecha_baja: null }));
  patients.push({ ...patients[0], id_paciente: 20001, clinica_id: 32 }, { ...patients[1], id_paciente: 20002, clinica_id: 99 },
    { ...patients[6], id_paciente: 20003, clinica_id: 31 });
  await insert('Pacientes', patients);
  await insert('CitasPacientes', patients.map(p => ({ id_cita: p.id_paciente, paciente_id: p.id_paciente, clinica_id: p.clinica_id,
    estado: 'completada', inicio: new Date('2026-01-01T10:00:00Z') })));
  await insert('MarketingPatientLists', [
    { id: 1, clinica_id: 31, objective_id: 'mass_sends', status: 'paused', criteria: JSON.stringify({ review_request: true }) },
    { id: 2, clinica_id: 31, objective_id: 'mass_sends', status: 'scheduled', criteria: JSON.stringify({}) },
    { id: 3, clinica_id: 32, objective_id: 'mass_sends', status: 'sending', criteria: JSON.stringify({ review_request: true }) },
  ]);
  const item = (id, patient, list_id, extra = {}) => ({ id, list_id, clinica_id: list_id === 3 ? 32 : 31, paciente_id: patient,
    name: 'Fictitious request ' + id, phone: patients.find(p => p.id_paciente === patient).telefono_movil, email: null,
    selected: true, status: 'ready', dispatch_status: 'pending', sent_at: null, ...extra });
  await insert('MarketingPatientListItems', [item(1, 1, 1), item(2, 2, 2), item(3, 3, 1, { dispatch_status: 'sent', sent_at: new Date('2026-10-29T10:00:00Z') }),
    item(4, 4, 1, { dispatch_status: 'failed', sent_at: new Date('2026-10-29T10:00:00Z') }),
    item(5, 20001, 3, { dispatch_status: 'sent', sent_at: new Date('2026-10-29T10:00:00Z') })]);
  await insert('MarketingContactOptOuts', [{ clinica_id: 31, paciente_id: 5, phone_digits: patients[4].telefono_movil, status: 'active', channel: 'whatsapp' }]);
  const event = (event_type, item_id, list_id, payload) => insert('MarketingPatientContactEvents', [{ item_id, list_id, event_type,
    payload: JSON.stringify(payload), occurred_at: new Date('2026-10-29T11:00:00Z'), created_at: new Date('2026-10-29T11:00:00Z') }]);
  await event('mass_campaign_test_sent', 4, 1, {});
  await event('review_rating_received', 3, 1, { rating: 5 });
  await event('review_rating_received', 5, 3, { rating: 4 });
  await event('review_private_feedback_received', 5, 3, { content: 'Fictitious feedback' });
  await event('google_review_matched', 3, 1, { review_name: 'qa-review', business_location_id: 22, confidence: .9 });
  await insert('BusinessProfileReviews', [
    { clinica_id: 31, business_location_id: 22, review_name: 'qa-review', star_rating: 5, last_seen_at: new Date('2026-10-29T12:00:00Z') },
    { clinica_id: 31, business_location_id: 22, review_name: 'accounts/qa/reviews/qa-review', star_rating: 5,
      google_missing_at: new Date('2026-10-28T12:00:00Z'), last_seen_at: new Date('2026-10-28T12:00:00Z') },
  ]);
  const source = fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'), 'utf8');
  const math = vm.runInNewContext(source.slice(source.indexOf('function buildGoogleRatingSummary('), source.indexOf('\nfunction isReviewRequestList('))
    + '\nbuildGoogleRatingSummary', {});
  const model = createService({ db, now: () => new Date('2026-10-30T12:00:00Z'),
    resolveProfile: async clinic => ({ clinic, links: { business_location_id: 22, location_name: 'Shared fictional profile' } }),
    queues: async () => [{ id: 'marketing:1', pending: 1 }], ratingSummary: math,
    automation: async () => ({ automation_enabled: false }) });
  const potentials = await model.potentialByClinic([31, 32]);
  // 10020 unique phones less pending review, pending ordinary campaign,
  // actual previous review and explicit opt-out. A failed test is not a send.
  assert.equal(potentials.find(r => r.clinic_id === 31).count, 10016);
  assert.equal(potentials.find(r => r.clinic_id === 32).count, 0, 'the B request blocks B, independently of A');
  report.checks.push('counter exceeds 10,000 without preview caps; every queue, paused review, prior send and opt-out excluded; duplicate patient phone counted once; tests remain isolated');
  await sql.query('DELETE FROM MarketingPatientListItems WHERE id=5');
  const second = await model.potentialByClinic([31, 32]);
  assert.equal(second.find(r => r.clinic_id === 32).count, 1, 'A queue must not consume B eligibility');
  await insert('MarketingPatientListItems', [item(5, 20001, 3, { dispatch_status: 'sent', sent_at: new Date('2026-10-29T10:00:00Z') })]);
  const ratings = await model.privateRatings({ clinicIds: [31, 32] }, { period: '30d', limit: 1 });
  assert.equal(ratings.total, 2); assert.equal(ratings.items.length, 1);
  const page2 = await model.privateRatings({ clinicIds: [31, 32] }, { period: '30d', limit: 1, offset: 1 });
  assert.notEqual(ratings.items[0].id, page2.items[0].id);
  const outside = await model.privateRatings({ clinicIds: [99] }, { period: '30d' }); assert.equal(outside.total, 0);
  assert.equal((await model.privateRatings({ clinicIds: [31, 32] }, { period: '30d', rating: 4 })).items[0].comment, 'Fictitious feedback');
  report.checks.push('native SQL private ratings scoped by clinic, with server pagination, filters, total count and feedback');
  const before = (await query('SELECT COUNT(*) total FROM MarketingPatientContactEvents'))[0].total;
  const overview = await model.overview({ scope: 'group', groupId: 5, clinicIds: [31, 32] }, { userId: 1, scopeRaw: 'group:5' });
  assert.equal(overview.potential_patients.excludes_queued, true);
  assert.equal(overview.google_profiles.length, 2);
  assert.equal(overview.google_profiles[0].rating.total_reviews, 1, 'missing alias copy cannot duplicate the public review');
  assert.equal(overview.google_profiles[0].shared_with.length, 2);
  assert.equal(overview.historical.attributed_reviews, 1);
  assert.equal(overview.historical.requests_sent, 2, 'failed test is excluded');
  assert.equal(overview.ratings_in_period, 2);
  assert.equal(overview.automation, null, 'group read does not activate or select a clinic automation');
  assert.equal((await query('SELECT COUNT(*) total FROM MarketingPatientContactEvents'))[0].total, before);
  report.checks.push('group read model has per-clinic tiers, canonical review de-duplication and historical attribution; no weighted group rating or writes');
  await sql.query(`ALTER TABLE MarketingPatientLists ADD grupo_clinica_id INT NULL, ADD name VARCHAR(80),
    ADD channel VARCHAR(32) DEFAULT 'whatsapp',ADD counters JSON,ADD email_dispatch JSON,ADD template_snapshot JSON,
    ADD safety_gates JSON,ADD created_at DATETIME,ADD updated_at DATETIME,ADD last_sent_at DATETIME`);
  await sql.query('ALTER TABLE MarketingPatientListItems ADD channel_status JSON,ADD failed_at DATETIME');
  db.MarketingPatientList = sql.define('MarketingPatientList', { id: {type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,grupo_clinica_id:D.INTEGER,
    name:D.STRING,channel:D.STRING,objective_id:D.STRING,status:D.STRING,criteria:D.JSON,counters:D.JSON,email_dispatch:D.JSON,
    template_snapshot:D.JSON,safety_gates:D.JSON,created_at:D.DATE,updated_at:D.DATE,last_sent_at:D.DATE }, {tableName:'MarketingPatientLists',timestamps:false});
  db.GrupoClinica = { findByPk: async id => Number(id) === 5 ? {clinicas:[{id_clinica:31},{id_clinica:32}]} : null };
  await sql.query('UPDATE MarketingPatientLists SET grupo_clinica_id=5,updated_at=UTC_TIMESTAMP()');
  await db.MarketingPatientList.create({id:4,grupo_clinica_id:5,objective_id:'mass_sends',status:'paused',criteria:{review_request:true},updated_at:new Date()});
  await insert('MarketingPatientListItems',[{...item(6,6,1),list_id:4,clinica_id:31},
    {...item(7,20001,3),list_id:4,clinica_id:32},{...item(8,20002,3),list_id:4,clinica_id:99}]);
  const nativeQueues = require('../../services/sendQueues.service').listReviewQueues;
  const clinicQueues = await nativeQueues({userId:1,scopeRaw:'31'});
  assert(!clinicQueues.some(r=>r.source_id===3),'sibling clinic list must not leak through its group membership');
  assert.equal(clinicQueues.find(r=>r.source_id===4).pending,1,'shared list counts only items inside the requested clinic');
  const groupQueues = await nativeQueues({userId:1,scopeRaw:'group:5'});
  assert.equal(groupQueues.find(r=>r.source_id===4).pending,2,'group list excludes an unrelated clinic item');
  assert(!groupQueues.some(r=>r.source_id===2),'ordinary mass sends are not review queues');
  report.checks.push('native queue SQL: group and clinic scope, no sibling leakage or unrelated items, paused review included and ordinary mass send excluded');
  report.coverage = { providerRequests: 0, realPatients: 0, dataWrittenOnlyToOwnedFixture: true };
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
