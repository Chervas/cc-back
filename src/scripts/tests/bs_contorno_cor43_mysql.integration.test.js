'use strict';

// Own short-lived Unix-socket mysqld. No CRM credentials, patient tables,
// external TCP, provider or production application bootstrap are accessible.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const O = require('../bs-contorno-cor43-closure');
const contract = require('../../lib/treatment-catalog-contract');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
const fixtureFile = path.join(__dirname, 'bs_contorno_cor43_operator.test.js'), fixtureRequire = createRequire(fixtureFile), fixtureModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(fixtureFile, 'utf8') + '\nmodule.exports={treatment,bundleFor,NOW};', {
  require: name => name === 'node:test' ? () => {} : fixtureRequire(name), module: fixtureModule, __dirname,
});
const fixtures = fixtureModule.exports;

test('COR-43 one-row operator uses real owned MySQL JSON CAS, DATETIME0, transactions, replay and rollback', {
  skip: process.env.BS_COR43_MYSQL_TEST !== '1', timeout: 120000,
}, async () => {
  await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
    const D = Sequelize.DataTypes; db.Sequelize = Sequelize;
    db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER, equipment_booking_enabled: D.BOOLEAN }, { tableName: 'Clinicas', timestamps: false });
    db.Instalacion = sql.define('Instalacion', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, activo: D.BOOLEAN, capacidad: D.INTEGER }, { tableName: 'Instalaciones', timestamps: false });
    db.DoctorClinica = sql.define('DoctorClinica', { id: { type: D.INTEGER, primaryKey: true }, doctor_id: D.INTEGER, clinica_id: D.INTEGER, activo: D.BOOLEAN, recibe_citas: D.BOOLEAN }, { tableName: 'DoctorClinicas', timestamps: false });
    for (const file of ['tratamiento', 'installationphysicalalias', 'bookingequipment', 'bookingequipmentclinic', 'bookingequipmentroompolicy']) {
      const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
    }
    db.Instalacion.belongsTo(db.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' }); db.BookingEquipment.associate(db);
    await sql.sync();
    await sql.query('CREATE TABLE Usuarios(id_usuario INT PRIMARY KEY,estado_cuenta VARCHAR(20)) ENGINE=InnoDB');
    await sql.query("INSERT INTO Usuarios VALUES(1,'activo')");
    await db.Clinica.create({ id_clinica: 72, grupoClinicaId: 29, equipment_booking_enabled: true });
    await db.Instalacion.create({ id: 85, clinica_id: 72, activo: true, capacidad: 1 });
    await db.DoctorClinica.create({ id: 119, doctor_id: 221, clinica_id: 72, activo: true, recibe_citas: true });
    await db.BookingEquipment.bulkCreate([
      { id: 4, owner_clinic_id: 72, group_id: 29, name: 'EXION ficticio', family_key: 'exion', mobility: 'mobile', status: 'available', turnaround_minutes: 0 },
      { id: 10, owner_clinic_id: 72, group_id: 29, name: 'Cyclone ficticio', family_key: 'cyclone', mobility: 'fixed', status: 'available', home_installation_id: 85, turnaround_minutes: 0 },
    ]);
    await db.BookingEquipmentClinic.bulkCreate([{ equipment_id: 4, clinic_id: 72 }, { equipment_id: 10, clinic_id: 72 }]);
    await db.BookingEquipmentRoomPolicy.create({ installation_id: 85, mode: 'selected', equipment_ids: [4] });
    await db.Tratamiento.bulkCreate([{ ...fixtures.treatment(), disciplina: 'estetica' },
      { id_tratamiento: 2123, nombre: 'Tratamiento ajeno ficticio', codigo: 'DO-NOT-TOUCH', disciplina: 'estetica', clinica_id: 72 }]);
    const untouchedHash = hash(await db.Tratamiento.findByPk(2123, { raw: true }));
    const baseQuery = sql.query.bind(sql), context = { db, contract, state: { writable: true, casVerified: false, writes: 0, selects: 0 },
      validate: (value, transaction) => validateCatalogResources(value, db, { transaction, environment: {
        BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_EQUIPMENT_ENABLED: 'true',
      } }) };
    sql.query = async (text, options) => {
      assert(O.sqlAllowed(text, context.state), 'Every operator SQL statement is explicitly allowed');
      if (text === O.UPDATE_SQL) context.state.writes++;
      return baseQuery(text, options);
    };
    const bundle = await sql.transaction(tx => fixtures.bundleFor(context, tx)), entries = [], log = { append(value) { entries.push(value.phase); } };
    const args = { bundle, approvedSha256: bundle.plan.plan_sha256, context, log, now: () => fixtures.NOW, assertPublishedSource() {} };
    const result = await O.applyBundle(args);
    assert.equal(result.updated, 1); assert.equal(result.after.precio_base, '145.00'); assert.equal(result.after.activo, true);
    assert.equal(new Date(result.after.updatedAt).getUTCMilliseconds(), 0);
    assert.equal(result.after.clinical_config.imported_price_review.reviewed_at, bundle.plan.reviewed_at);
    assert.equal((await O.applyBundle(args)).updated, 0); assert.equal(context.state.writes, 1);
    assert.equal(hash(await db.Tratamiento.findByPk(2123, { raw: true })), untouchedHash);
    report.checks.push('Real exact-ID JSON CAS updates one row; DECIMAL145.00, canonical audit and DATETIME whole-second storage verify; replay writes zero; other treatment unchanged.');

    // Restore only our own synthetic fixture through the unguarded setup handle.
    await baseQuery('UPDATE Tratamientos SET precio_base=NULL,activo=0,clinical_config=CAST(:config AS JSON),updatedAt=:clock WHERE id_tratamiento=2122', {
      replacements: { config: JSON.stringify(bundle.plan.before.clinical_config), clock: bundle.plan.before.updatedAt.slice(0, 19).replace('T', ' ') },
    });
    context.state.writes = 0;
    const rollbackBundle = await sql.transaction(tx => fixtures.bundleFor(context, tx)), beforeRollback = hash((await baseQuery('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0]);
    await assert.rejects(O.applyBundle({ ...args, bundle: rollbackBundle, approvedSha256: rollbackBundle.plan.plan_sha256,
      log: { append(value) { if (value.phase === 'verified_before_commit') throw Error('owned_disk_full_before_commit'); } } }), /owned_disk_full_before_commit/);
    assert.equal(hash((await baseQuery('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0]), beforeRollback);
    report.checks.push('Real UPDATE followed by failed durable post-read audit rolls back all changes; no false success or other row changes.');
    await baseQuery("CREATE TRIGGER owned_cor43_guard BEFORE UPDATE ON Tratamientos FOR EACH ROW SET NEW.nombre=CONCAT(NEW.nombre,' unexpected')");
    context.state.writes = 0;
    await assert.rejects(O.applyBundle({ ...args, bundle: rollbackBundle, approvedSha256: rollbackBundle.plan.plan_sha256 }), /COR43_OPERATOR_STORAGE_CONTRACT_INVALID/);
    assert.equal(context.state.writes, 0);
    report.checks.push('A real target-table trigger is rejected before any operator UPDATE; no CRM, patient, program, appointment, job or provider access.');
    sql.query = baseQuery;
  });
});
