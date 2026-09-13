'use strict';
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { rotateGlobalAdminPasswords } = require('../../lib/rotateGlobalAdminPasswords');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const connection = await require('mysql2/promise').createConnection({ socketPath: sql.options.dialectOptions.socketPath,
    user: 'root', database: 'campaign_optimization_qa', multipleStatements: false });
  try {
    await connection.query('CREATE TABLE Usuarios (id_usuario INT PRIMARY KEY,email_usuario VARCHAR(255),password_usuario VARCHAR(255),estado_cuenta VARCHAR(30),es_provisional INT,updatedAt DATETIME(3)) ENGINE=InnoDB');
    await connection.query('CREATE TABLE PasswordResetTokens (id INT PRIMARY KEY,user_id INT,status VARCHAR(30),updated_at DATETIME(3)) ENGINE=InnoDB');
    const oldHash = await bcrypt.hash('fictional-old-password', 4);
    const expectedUsers = [{ id: 1, email: 'admin-one@example.invalid' }, { id: 44, email: 'admin-two@example.invalid' }];
    async function seed() {
      await connection.query('DELETE FROM PasswordResetTokens'); await connection.query('DELETE FROM Usuarios');
      for (const id of [1,44,99]) await connection.execute('INSERT INTO Usuarios VALUES (?,?,?,\'activo\',0,NULL)', [id, expectedUsers.find(user => user.id === id)?.email || 'owner@example.invalid', oldHash]);
      await connection.query("INSERT INTO PasswordResetTokens VALUES (1,1,'pending',NULL),(2,44,'pending',NULL),(3,99,'pending',NULL),(4,1,'used',NULL)");
    }
    const snapshot = async () => ({ users: (await connection.query('SELECT * FROM Usuarios ORDER BY id_usuario'))[0],
      resets: (await connection.query('SELECT * FROM PasswordResetTokens ORDER BY id'))[0] });
    await seed(); const records = [];
    const result = await rotateGlobalAdminPasswords({ connection, expectedUsers, record: value => records.push(value) });
    assert.equal(result.changedPasswords, 2); assert.equal(result.revokedResetLinks, 2); assert.equal(result.oldJwtSessionsRevoked, false);
    const after = await snapshot();
    for (const row of after.users.slice(0, 2)) {
      assert.equal(await bcrypt.compare('fictional-old-password', row.password_usuario), false);
      assert.equal(bcrypt.getRounds(row.password_usuario), 12);
      assert.equal(row.email_usuario, expectedUsers.find(user => user.id === row.id_usuario).email);
    }
    assert.notEqual(after.users[0].password_usuario, after.users[1].password_usuario);
    assert.equal(after.users[2].password_usuario, oldHash); assert.equal(after.users[2].updatedAt, null);
    assert.deepEqual(after.resets.map(row => row.status), ['revoked','revoked','pending','used']);
    assert.deepEqual(records.map(row => row.status), ['commit_pending','committed']);
    assert.equal(JSON.stringify(records).includes('$2'), false); assert.equal(JSON.stringify(records).includes('@'), false);
    report.checks.push('both random passwords replaced; only global admins and their pending reset links changed; receipt has no passwords, hashes or emails');

    await seed(); const beforeFailure = await snapshot();
    await connection.query("CREATE TRIGGER rotation_failure BEFORE UPDATE ON Usuarios FOR EACH ROW BEGIN IF NEW.id_usuario=44 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture failure'; END IF; END");
    await assert.rejects(rotateGlobalAdminPasswords({ connection, expectedUsers, record() {} }), /admin_rotation_rolled_back/);
    assert.deepEqual(await snapshot(), beforeFailure);
    await connection.query('DROP TRIGGER rotation_failure');
    report.checks.push('second-user update failure rolls back first password and reset-link revocation');

    await assert.rejects(rotateGlobalAdminPasswords({ connection, expectedUsers: [{ id: 1, email: 'wrong@example.invalid' }, expectedUsers[1]], record() {} }), /admin_rotation_rolled_back/);
    assert.deepEqual(await snapshot(), beforeFailure);
    await assert.rejects(rotateGlobalAdminPasswords({ connection, expectedUsers: [expectedUsers[0], { id: 99, email: 'owner@example.invalid' }], record() {} }), /admin_rotation_scope_changed/);
    report.checks.push('changed identity and clinic-owner substitution fail without mutation');

    await assert.rejects(rotateGlobalAdminPasswords({ connection, expectedUsers, record(value) { if (value.status === 'commit_pending') throw Error('disk failure'); } }), /admin_rotation_rolled_back/);
    assert.deepEqual(await snapshot(), beforeFailure);
    report.checks.push('receipt failure before COMMIT rolls back all changes');

    await connection.query('CREATE TABLE AuthSessions (id INT) ENGINE=InnoDB');
    await assert.rejects(rotateGlobalAdminPasswords({ connection, expectedUsers, record() {} }), /admin_rotation_rolled_back/);
    assert.deepEqual(await snapshot(), beforeFailure); await connection.query('DROP TABLE AuthSessions');
    report.checks.push('new session schema requires a reviewed session-aware operation');

    let commits = 0; const unknownRecords = [];
    const lostAck = new Proxy(connection, { get(target, name) {
      if (name === 'commit') return async () => { commits++; await target.commit(); throw Error('lost acknowledgement'); };
      const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(rotateGlobalAdminPasswords({ connection: lostAck, expectedUsers, record: value => unknownRecords.push(value) }), /admin_rotation_commit_outcome_unknown/);
    assert.equal(commits, 1); assert.equal(unknownRecords.at(-1).status, 'commit_outcome_unknown');
    assert.notEqual((await snapshot()).users[0].password_usuario, oldHash);
    report.checks.push('lost COMMIT acknowledgement is recorded as uncertain and never retried');
  } finally { await connection.end(); }
}).catch(() => { process.stderr.write('admin rotation isolated MySQL QA failed; inspect private fixture result\n'); process.exitCode = 1; });
