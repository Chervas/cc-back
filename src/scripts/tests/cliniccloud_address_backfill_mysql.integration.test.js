'use strict';

const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const core = require('../../lib/cliniccloud-import/address-backfill');
const store = require('../../lib/cliniccloud-import/address-backfill-store');
const STORE_SHA256 = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(require.resolve('../../lib/cliniccloud-import/address-backfill-store'))).digest('hex');

// The shared fixture creates its own mysqld with --skip-networking and denies
// every socket except its owned test socket. All rows below are fictional.
const ADDRESS = { direccion: 'Calle Ficticia 10', codigo_postal: '08001', poblacion: 'Ciudad Ficticia', provincia: 'Provincia Ficticia', pais: 'España' };
const GENERATED_AT = '2026-10-14T00:00:00.000Z';

function contact(id = 123, number = 7) {
  return { idContacto: String(id), idEmpresa: '5880', num: String(number), domicilio: ADDRESS.direccion, cp: ADDRESS.codigo_postal,
    pobla: ADDRESS.poblacion, provi: ADDRESS.provincia, pais: ADDRESS.pais,
    nombre: 'Origen ficticio no copiable', email: 'origen@example.invalid', notas: 'No copiar', whatsapp: 'Sí', rgpd: 'Sí' };
}
function sourceValue(id = 123, number = 7, overrides = {}) {
  return JSON.stringify({ contact: { ...contact(id, number), ...overrides } });
}

function intercepted(connection, onQuery) {
  return {
    async query(sql, values) { const result = await connection.query(sql, values); await onQuery(sql, values, result); return result; },
    async execute(sql, values) { const result = await connection.execute(sql, values); await onQuery(sql, values, result); return result; },
    beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection), rollback: connection.rollback.bind(connection),
  };
}

withIsolatedCampaignMysql(async ({ report }) => {
  report.store_sha256 = STORE_SHA256;
  const c = await require('mysql2/promise').createConnection({ socketPath: report.root + '/mysql.sock', user: 'root', password: '',
    database: report.database, dateStrings: true, timezone: 'Z' });
  const concurrent = await require('mysql2/promise').createConnection({ socketPath: report.root + '/mysql.sock', user: 'root', password: '',
    database: report.database, dateStrings: true, timezone: 'Z' });
  try {
    await concurrent.query('SET SESSION innodb_lock_wait_timeout=1');
    await c.query('CREATE TABLE Clinicas (id_clinica INT PRIMARY KEY,grupoClinicaId INT NOT NULL) ENGINE=InnoDB');
    await c.query('INSERT INTO Clinicas VALUES (66,29),(72,29),(74,30)');
    await c.query('CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY,numero_historia VARCHAR(32),clinica_id INT NOT NULL,updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,direccion TEXT NULL,codigo_postal VARCHAR(32) NULL,poblacion VARCHAR(255) NULL,provincia VARCHAR(255) NULL,pais VARCHAR(255) NULL,nombre VARCHAR(255),email VARCHAR(255),telefono_movil VARCHAR(255),notas_paciente TEXT,notas_medicas TEXT,whatsapp_opt_in TINYINT DEFAULT 0,KEY clinica_id (clinica_id)) ENGINE=InnoDB');
    await c.query("INSERT INTO Pacientes (id_paciente,numero_historia,clinica_id,updatedAt,nombre,email,telefono_movil,notas_paciente,notas_medicas) VALUES (101,'0007',66,'2026-10-14 00:00:00','Persona Ficticia','persona@example.invalid','600000001','Nota local ficticia','Texto médico ficticio'),(900,'00900',74,'2026-10-14 00:00:00','Fuera del ámbito','otro@example.invalid','600000900','Nota ajena','Texto ajeno')");
    await c.query('CREATE TABLE PacienteClinicas (id INT AUTO_INCREMENT PRIMARY KEY,paciente_id INT NOT NULL,clinica_id INT NOT NULL,UNIQUE KEY paciente_clinica (paciente_id,clinica_id)) ENGINE=InnoDB');
    await c.query('INSERT INTO PacienteClinicas (paciente_id,clinica_id) VALUES (101,66),(101,72),(900,74)');
    await c.query('CREATE TABLE PatientCustomFields (id INT AUTO_INCREMENT PRIMARY KEY,paciente_id INT NOT NULL,clinica_id INT NOT NULL,source VARCHAR(64),source_column VARCHAR(255),field_key VARCHAR(120),value LONGTEXT,last_imported_at DATETIME,UNIQUE KEY paciente_clinica_campo (paciente_id,clinica_id,field_key)) ENGINE=InnoDB');
    await c.query('INSERT INTO PatientCustomFields (id,paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES (501,101,66,?,?,?,?,?),(900,900,74,?,?,?,?,?)',
      ['cliniccloud', 'contacto_1.csv', 'cliniccloud_raw_contact:123', sourceValue(), '2026-10-03 10:00:00',
        'cliniccloud', 'contacto_1.csv', 'cliniccloud_raw_contact:900', sourceValue(900, 900), '2026-10-03 10:00:00']);

    const wholeSnapshot = async () => {
      const rows = {};
      for (const table of ['Pacientes', 'PatientCustomFields', 'PacienteClinicas', 'Clinicas']) rows[table] = (await c.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
      return rows;
    };
    const prepare = async () => core.buildAddressBackfillPlan({ target: 'dev', scope: { clinicIds: [66, 72], groupId: 29 }, generatedAt: GENERATED_AT,
      ...await store.captureAddressSnapshot(c, { lock: false }) });
    const apply = (approved, options = {}, connection = c) => store.applyAddressBackfillPlan(connection, approved, options);
    const restoreEmpties = async () => c.query('UPDATE Pacientes SET direccion=NULL,codigo_postal=NULL,poblacion=NULL,provincia=NULL,pais=NULL,updatedAt=? WHERE id_paciente=101', ['2026-10-14 00:00:00']);

    await c.query("INSERT INTO Pacientes (id_paciente,numero_historia,clinica_id,updatedAt,nombre,email) VALUES (902,'00902',74,'2026-10-14 00:00:00','Persona compartida ficticia','compartida@example.invalid')");
    await c.query('INSERT INTO PacienteClinicas (paciente_id,clinica_id) VALUES (902,66)');
    await c.query('INSERT INTO PatientCustomFields (id,paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES (902,902,66,?,?,?,?,?)',
      ['cliniccloud', 'contacto_1.csv', 'cliniccloud_raw_contact:902', sourceValue(902, 902), '2026-10-03 10:00:00']);
    const sharedOwner = await prepare();
    assert.equal(sharedOwner.operations.length, 2);
    assert(sharedOwner.operations.some(item => item.patient_id === 902 && item.expected.clinica_id === 74));
    await c.query('UPDATE Pacientes SET direccion=?,codigo_postal=?,poblacion=?,provincia=?,pais=?,updatedAt=updatedAt WHERE id_paciente=902', core.ADDRESS_FIELDS.map(field => ADDRESS[field]));
    report.checks.push('Indexed scope capture includes a clinic-74 primary patient with a real clinic-66 membership');

    await store.preflightAddressDatabase(c, { target: 'dev' });
    let approved = await prepare();
    assert.equal(approved.operations.length, 1);
    assert.equal(approved.operations[0].patient_id, 101);
    const initial = await wholeSnapshot(), initialHash = hash(initial);

    await c.query('ALTER TABLE Pacientes MODIFY codigo_postal VARCHAR(31) NULL');
    await assert.rejects(() => store.preflightAddressDatabase(c), /SCHEMA_MISMATCH/);
    await c.query('ALTER TABLE Pacientes MODIFY codigo_postal VARCHAR(32) NULL');
    report.checks.push('SQL preflight rejects an address column whose length does not match the canonical schema');

    await c.query('CREATE TRIGGER FictitiousAddressTrigger BEFORE UPDATE ON Pacientes FOR EACH ROW SET NEW.whatsapp_opt_in=1');
    await assert.rejects(() => apply(approved, { beforeWrite: async () => {} }), /TRIGGERS_UNSAFE/);
    assert.equal(hash(await wholeSnapshot()), initialHash);
    await c.query('DROP TRIGGER FictitiousAddressTrigger');
    report.checks.push('A patient UPDATE trigger blocks the transaction before it can alter opt-in or other protected data');

    await assert.rejects(() => apply(approved), /BEFORE|BACKUP|CALLBACK|REQUIRED/);
    assert.equal(hash(await wholeSnapshot()), initialHash);
    report.checks.push('The SQL writer rejects an absent durable-backup callback before changing any row');

    let called = 0;
    let groupChanged = false;
    const changeGroupAfterPreflight = intercepted(c, async sql => {
      if (!groupChanged && sql.includes('information_schema.COLUMNS')) {
        groupChanged = true;
        await concurrent.query('UPDATE Clinicas SET grupoClinicaId=30 WHERE id_clinica=72');
      }
    });
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }, changeGroupAfterPreflight), /SCOPE_CHANGED/);
    assert.equal(groupChanged, true); assert.equal(called, 0);
    const changedGroupExpected = structuredClone(initial); changedGroupExpected.Clinicas.find(row => row.id_clinica === 72).grupoClinicaId = 30;
    assert.deepEqual(await wholeSnapshot(), changedGroupExpected);
    await concurrent.query('UPDATE Clinicas SET grupoClinicaId=29 WHERE id_clinica=72');
    report.checks.push('A real group edit between preflight and the current-read lock aborts before address DML');

    let sourceChanged = false;
    const refreshedSource = sourceValue(123, 7, { domicilio: 'Origen concurrente después del preflight' });
    const changeSourceAfterPreflight = intercepted(c, async sql => {
      if (!sourceChanged && sql.includes('information_schema.COLUMNS')) {
        sourceChanged = true;
        await concurrent.query('UPDATE PatientCustomFields SET value=? WHERE id=501', [refreshedSource]);
      }
    });
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }, changeSourceAfterPreflight), /PLAN_STALE/);
    assert.equal(sourceChanged, true); assert.equal(called, 0);
    const changedSourceExpected = structuredClone(initial); changedSourceExpected.PatientCustomFields.find(row => row.id === 501).value = refreshedSource;
    assert.deepEqual(await wholeSnapshot(), changedSourceExpected);
    await concurrent.query('UPDATE PatientCustomFields SET value=? WHERE id=501', [sourceValue()]);
    report.checks.push('A source refreshed between preflight and capture is read under current locks and invalidates the old plan');

    await assert.rejects(() => apply(approved, { beforeWrite: async ({ snapshot, operations }) => {
      called++; assert(snapshot); assert.equal(operations.length, 1); throw Error('OWNED_BACKUP_FAILURE');
    } }), /OWNED_BACKUP_FAILURE/);
    assert.equal(called, 1);
    assert.equal(hash(await wholeSnapshot()), initialHash);
    report.checks.push('Backup or intent failure rolls back without patient, membership or source changes');

    let dml = 0;
    const failing = intercepted(c, async sql => {
      if (/^UPDATE\s+`?Pacientes`?\b/i.test(sql.trim())) { dml++; throw Error('OWNED_POST_WRITE_FAILURE'); }
    });
    await assert.rejects(() => apply(approved, { beforeWrite: async () => {} }, failing), /OWNED_POST_WRITE_FAILURE/);
    assert.equal(dml, 1);
    assert.equal(hash(await wholeSnapshot()), initialHash);
    report.checks.push('A real UPDATE followed by an injected failure is rolled back atomically');

    const corruptReadback = intercepted(c, async sql => {
      if (/^UPDATE\s+`?Pacientes`?\b/i.test(sql.trim())) {
        await c.query("UPDATE Pacientes SET direccion='Inyección ficticia no aprobada',updatedAt=updatedAt WHERE id_paciente=101");
      }
    });
    await assert.rejects(() => apply(approved, { beforeWrite: async () => {} }, corruptReadback), /AFTER_IMAGE_MISMATCH/);
    assert.equal(hash(await wholeSnapshot()), initialHash);
    report.checks.push('An unexpected SQL after-image triggers rollback of all real updates');

    await c.query("UPDATE Pacientes SET direccion='Edición local concurrente',updatedAt=updatedAt WHERE id_paciente=101");
    const afterLocalEdit = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }), /DRIFT|CHANGED|MISMATCH|STALE/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterLocalEdit);
    report.checks.push('A canonical address edit after prepare prevents writes before backup or intent');
    await restoreEmpties();

    approved = await prepare();
    await c.query('UPDATE PatientCustomFields SET value=? WHERE id=501', [sourceValue(123, 7, { domicilio: 'Cambio concurrente del origen' })]);
    const afterSourceEdit = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }), /DRIFT|CHANGED|MISMATCH|STALE/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterSourceEdit);
    report.checks.push('Source fingerprint drift prevents writes and does not modify source evidence');
    await c.query('UPDATE PatientCustomFields SET value=? WHERE id=501', [sourceValue()]);

    approved = await prepare();
    await c.query('INSERT INTO PatientCustomFields (id,paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES (901,900,74,?,?,?,?,?)',
      ['cliniccloud', 'contacto_1.csv', 'cliniccloud_raw_contact:123', JSON.stringify({ source_account: 'cliniccloud-9999', contact: contact(123, 900) }), '2026-10-03 10:00:00']);
    assert.equal((await prepare()).operations.length, 1, 'A different source account must not claim account 5880 identity');
    await c.query('UPDATE PatientCustomFields SET value=? WHERE id=901', [JSON.stringify({ source_account: 'cliniccloud-5880', contact: contact(123, 900) })]);
    const duplicateOwner = await prepare();
    assert.equal(duplicateOwner.operations.length, 0);
    assert(duplicateOwner.reviews.some(item => item.patient_id === 101 && item.reasons.includes('AMBIGUOUS_SOURCE_CONTACT_ID')));
    const afterDuplicateOwner = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }), /STALE|DRIFT|MISMATCH/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterDuplicateOwner);
    await c.query('DELETE FROM PatientCustomFields WHERE id=901');
    report.checks.push('An account-5880 source owner outside the clinics blocks a duplicate identity while another account is ignored');

    approved = await prepare();
    await c.query('INSERT INTO PatientCustomFields (id,paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES (701,101,66,?,?,?,?,?)',
      ['cliniccloud', 'idContacto', 'cliniccloud_source_contact_id', '123', '2026-10-03 10:00:00']);
    const withIdentityLink = await prepare();
    assert.equal(withIdentityLink.operations.length, 1);
    assert.match(withIdentityLink.identity_links_sha256, /^[a-f0-9]{64}$/);
    const afterLinkAdded = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }), /STALE|DRIFT|MISMATCH/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterLinkAdded);
    await c.query('INSERT INTO PatientCustomFields (id,paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES (702,101,66,?,?,?,?,?)',
      ['cliniccloud', 'idContacto', 'cliniccloud_contact_alias_124', '124', '2026-10-03 10:00:00']);
    const conflictingAlias = await prepare();
    assert.equal(conflictingAlias.operations.length, 0);
    assert(conflictingAlias.reviews.some(item => item.patient_id === 101 && item.reasons.includes('IDENTITY_LINK_CONFLICT')));
    const afterAliasAdded = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(withIdentityLink, { beforeWrite: async () => { called++; } }), /STALE|DRIFT|MISMATCH/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterAliasAdded);
    await c.query('DELETE FROM PatientCustomFields WHERE id IN (701,702)');
    report.checks.push('Identity links are hashed even without address changes, and a different canonical source alias holds the whole address');

    approved = await prepare();
    await c.query('DELETE FROM PacienteClinicas WHERE paciente_id=101 AND clinica_id=72');
    // The plan uses clinic 66; removing a required 66 source membership is the
    // meaningful membership drift when the canonical patient clinic changes too.
    await c.query('UPDATE Pacientes SET clinica_id=72,updatedAt=updatedAt WHERE id_paciente=101');
    await c.query('DELETE FROM PacienteClinicas WHERE paciente_id=101 AND clinica_id=66');
    const afterMembershipEdit = hash(await wholeSnapshot()); called = 0;
    await assert.rejects(() => apply(approved, { beforeWrite: async () => { called++; } }), /DRIFT|CHANGED|MISMATCH|STALE/);
    assert.equal(called, 0);
    assert.equal(hash(await wholeSnapshot()), afterMembershipEdit);
    report.checks.push('Clinic and membership drift prevent applying the earlier approved plan');
    await c.query('UPDATE Pacientes SET clinica_id=66,updatedAt=updatedAt WHERE id_paciente=101');
    await c.query('INSERT INTO PacienteClinicas (paciente_id,clinica_id) VALUES (101,66),(101,72)');

    approved = await prepare();
    const forged = structuredClone(approved); forged.operations[0].updates.nombre = 'No autorizado';
    forged.plan_sha256 = core.planHash(forged);
    const beforeForged = hash(await wholeSnapshot());
    await assert.rejects(() => apply(forged, { beforeWrite: async () => {} }), /ALLOWLIST|PROOF|INVALID|MISMATCH/);
    assert.equal(hash(await wholeSnapshot()), beforeForged);
    report.checks.push('Even a rehashed plan cannot add a non-address write target');

    // Protected-column edits do not need a replay of old values. They remain
    // current when an approved independent address patch is applied.
    await c.query("UPDATE Pacientes SET nombre='Nombre local más reciente',notas_paciente='Nota más reciente',updatedAt=updatedAt WHERE id_paciente=101");
    const beforeCommit = await wholeSnapshot();
    let releaseBackup;
    const backupBarrier = new Promise(resolve => { releaseBackup = resolve; });
    let enteredBackup;
    const backupEntered = new Promise(resolve => { enteredBackup = resolve; });
    const updates = [];
    const observed = intercepted(c, async (sql, values) => {
      if (/^UPDATE\s+`?Pacientes`?\b/i.test(sql.trim())) updates.push({ sql, values });
    });
    const pending = apply(approved, { beforeWrite: async ({ snapshot, operations }) => {
      assert(snapshot); assert.equal(operations.length, 1); enteredBackup(); await backupBarrier;
    } }, observed);
    await Promise.race([backupEntered, pending]);
    assert.equal(updates.length, 0, 'DML cannot start before the awaited durable backup callback finishes');
    let unrelatedWriteError;
    try {
      await concurrent.query("UPDATE Pacientes SET nombre='Edición concurrente de otra clínica',updatedAt=updatedAt WHERE id_paciente=900");
    } catch (error) { unrelatedWriteError = error; }
    finally { releaseBackup(); }
    await pending;
    if (unrelatedWriteError) throw unrelatedWriteError;
    beforeCommit.Pacientes.find(row => row.id_paciente === 900).nombre = 'Edición concurrente de otra clínica';
    report.checks.push('Scoped patient locks permit an unrelated clinic-74 profile edit while the address transaction waits for backup');
    const committed = await wholeSnapshot(), patient = committed.Pacientes.find(row => row.id_paciente === 101);
    assert.deepEqual(Object.fromEntries(core.ADDRESS_FIELDS.map(field => [field, patient[field]])), ADDRESS);
    const expected = structuredClone(beforeCommit);
    Object.assign(expected.Pacientes.find(row => row.id_paciente === 101), ADDRESS);
    assert.deepEqual(committed, expected);
    assert.equal(updates.length, 1);
    report.checks.push('SQL waits for durable backup, fills only five addresses and preserves updatedAt and every other field/table');

    const replay = await prepare();
    assert.equal(replay.operations.length, 0);
    const beforeReplay = hash(await wholeSnapshot());
    await apply(replay, { beforeWrite: async () => {} });
    assert.equal(hash(await wholeSnapshot()), beforeReplay);
    report.checks.push('A fresh second prepare and apply is idempotent with no duplicate rows or address overwrite');

    // 501 new eligible patients exercise the production bulk-query boundary.
    const patientRows = [], memberRows = [], sourceRows = [];
    for (let i = 0; i < 501; i++) {
      const id = 1000 + i, sourceContactId = 5000 + i;
      patientRows.push([id, String(id), 66, '2026-10-14 00:00:00', `Persona ficticia ${id}`, `${id}@example.invalid`, `Nota ${id}`]);
      memberRows.push([id, 66]);
      sourceRows.push([id, 66, 'cliniccloud', 'contacto_1.csv', `cliniccloud_raw_contact:${sourceContactId}`, sourceValue(sourceContactId, id), '2026-10-03 10:00:00']);
    }
    await c.query('INSERT INTO Pacientes (id_paciente,numero_historia,clinica_id,updatedAt,nombre,email,notas_paciente) VALUES ?', [patientRows]);
    await c.query('INSERT INTO PacienteClinicas (paciente_id,clinica_id) VALUES ?', [memberRows]);
    await c.query('INSERT INTO PatientCustomFields (paciente_id,clinica_id,source,source_column,field_key,value,last_imported_at) VALUES ?', [sourceRows]);
    approved = await prepare(); assert.equal(approved.operations.length, 501);
    const beforeBulk = await wholeSnapshot(), bulkUpdates = [];
    const bulk = intercepted(c, async sql => { if (/^UPDATE\s+`?Pacientes`?\b/i.test(sql.trim())) bulkUpdates.push(sql); });
    await apply(approved, { beforeWrite: async ({ operations }) => { assert.equal(operations.length, 501); } }, bulk);
    assert.equal(bulkUpdates.length, 2);
    const afterBulk = await wholeSnapshot(), expectedBulk = structuredClone(beforeBulk);
    for (const row of expectedBulk.Pacientes) if (row.id_paciente >= 1000) Object.assign(row, ADDRESS);
    assert.deepEqual(afterBulk, expectedBulk);
    report.checks.push('501 address operations cross the 500-row SQL boundary in one atomic transaction while preserving all unrelated data');

    // A second-chunk fault proves that the first 500 real updates do not survive.
    await c.query('UPDATE Pacientes SET direccion=NULL,codigo_postal=NULL,poblacion=NULL,provincia=NULL,pais=NULL,updatedAt=updatedAt WHERE id_paciente>=1000');
    approved = await prepare(); const beforeBatchFailure = hash(await wholeSnapshot()); let chunks = 0;
    const failSecondChunk = intercepted(c, async sql => {
      if (/^UPDATE\s+`?Pacientes`?\b/i.test(sql.trim()) && ++chunks === 2) throw Error('OWNED_SECOND_CHUNK_FAILURE');
    });
    await assert.rejects(() => apply(approved, { beforeWrite: async () => {} }, failSecondChunk), /OWNED_SECOND_CHUNK_FAILURE/);
    assert.equal(chunks, 2);
    assert.equal(hash(await wholeSnapshot()), beforeBatchFailure);
    report.checks.push('A failure after the second real bulk UPDATE rolls back both chunks without a partial address migration');
  } finally { await Promise.all([c.end(), concurrent.end()]); }
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
