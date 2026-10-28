'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./delegated_sessions_dev_sql');
test('offline SQL plan binds exact DEV namespace and only absent prefixed fixture tables', () => {
  const plan = H.plan(); assert.equal(plan.database, 'clinicaclick_dev_isolated');
  assert.deepEqual(plan.allowedNamespaces, ['dev', 'DEV']); assert.equal(plan.globalMigrationApplied, false);
  assert.equal(plan.realAccountRowsAccessed, false); assert.equal(Object.values(plan.tables).length, 5);
  assert(Object.values(plan.tables).every(table => table.startsWith('QADelegation20261028')));
  assert(Object.values(plan.sourcePins).every(hash => /^[a-f0-9]{64}$/.test(hash)));
});
test('SQL fence rejects real account/session tables, DCL, cross-schema operations and foreign-key disable', () => {
  for (const sql of ['SELECT * FROM Usuarios', 'SELECT * FROM AuthSessions', 'UPDATE Usuarios SET nombre=?',
    'DELETE FROM SequelizeMeta', 'GRANT ALL ON *.* TO someone', 'SET FOREIGN_KEY_CHECKS=0',
    'SELECT * FROM other.QADelegation20261028Users', 'DROP TABLE Usuarios', 'SELECT * FROM QADelegation20261028Users; DROP TABLE Usuarios']) {
    assert.throws(() => H.guard(sql), { code: 'delegation_qa_sql_scope' }, sql);
  }
});
test('production normal-session SQL is mapped before fenced dispatch and FK update clauses are not mistaken for table writes', () => {
  const mapped = H.remap('SELECT s.*,u.password_usuario FROM AuthSessions s JOIN Usuarios u ON u.id_usuario=s.user_id WHERE s.session_id=:id');
  assert(mapped.includes(H.TABLES.AuthSessions)); assert(mapped.includes(H.TABLES.Usuarios)); H.guard(mapped);
  H.guard('CREATE TABLE `' + H.TABLES.DelegatedSessions + '` (`parent` CHAR(36), FOREIGN KEY (`parent`) REFERENCES `'
    + H.TABLES.AuthSessions + '` (`session_id`) ON DELETE RESTRICT ON UPDATE RESTRICT)');
  H.guard('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  H.guard('START TRANSACTION;'); H.guard('ROLLBACK;');
});
test('cleanup ownership is acquired only after CREATE acknowledgement; collisions are not adopted and later index failure retains ownership', async () => {
  const table = H.TABLES.DelegatedSessions, created = [], commands = [];
  const dispatch = H.ownedDispatch(async sql => { commands.push(sql); if (sql.startsWith('ALTER')) throw Error('TESTONLY index failure'); return []; }, created);
  await dispatch('  CREATE TABLE IF NOT EXISTS `' + table + '` (`id` INT)');
  assert.equal(commands[0], 'CREATE TABLE `' + table + '` (`id` INT)'); assert.deepEqual(created, [table]);
  await assert.rejects(dispatch('ALTER TABLE `' + table + '` ADD INDEX (`id`)')); assert.deepEqual(created, [table]);
  const collisionLedger = [];
  await assert.rejects(H.ownedDispatch(async () => { throw Error('TESTONLY table exists'); }, collisionLedger)
    ('CREATE TABLE IF NOT EXISTS `' + table + '` (`id` INT)'));
  assert.deepEqual(collisionLedger, []);
});
test('only exact installed Sequelize query/bind or query/values forms are accepted, fenced and passed without logging bindings', async () => {
  const Sequelize = require('sequelize'), sql = new Sequelize({ dialect: 'mysql', logging: false });
  const generated = sql.getQueryInterface().queryGenerator.insertQuery('Usuarios', { id_usuario: 1, nombre: 'TESTONLY' }, {}, {});
  const calls = [], dispatch = H.ownedDispatch(async (...args) => { calls.push(args); return []; }, []);
  await dispatch(generated, { logging: () => assert.fail('bindings must never be logged') });
  assert(calls[0][0].query.includes(H.TABLES.Usuarios)); assert.equal(calls[0][0].bind, generated.bind);
  assert.equal(calls[0][1].logging, false);
  const values = [1]; await dispatch({ query: 'SELECT * FROM Usuarios WHERE id_usuario=?', values });
  assert.equal(calls[1][0].values, values); assert(calls[1][0].query.includes(H.TABLES.Usuarios));
  for (const statement of [{ query: 'SELECT * FROM other.Usuarios', bind: [] }, { query: 'DROP TABLE forbidden', values: [] },
    { query: 'SELECT * FROM Usuarios', bind: [], values: [] }, { query: 'SELECT * FROM Usuarios', sql: 'ignored' },
    { query: () => 'SELECT * FROM Usuarios' }, Object.create({ query: 'SELECT * FROM Usuarios' })]) {
    await assert.rejects(dispatch(statement));
  }
  assert.equal(calls.length, 2); await sql.close();
});
