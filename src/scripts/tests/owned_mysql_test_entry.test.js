'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { ownedMysqlTestEntry } = require('./fixtures/owned_mysql_test_entry.fixture');

const enabled = { CAMPAIGN_OPTIMIZATION_MYSQL_TEST: '1' };
for (const database of ['clinicaclick', 'clinicaclick_dev_isolated', 'production', 'arbitrary_test']) {
  test(`a URL for ${database} cannot bypass the owned fixture`, () => {
    const secret = 'synthetic-do-not-print';
    assert.throws(() => ownedMysqlTestEntry({ ...enabled,
      WEB_EDITOR_TEST_MYSQL_URL: `mysql://root:${secret}@localhost/${database}`,
      WEB_RUNTIME_TEST_MYSQL_USE_EXISTING_DATABASE: 'true',
    }), error => error.message.includes('External MySQL targets') && !error.message.includes(secret));
  });
}

test('external sockets/URLs remain forbidden even without existing-database mode', () => {
  assert.throws(() => ownedMysqlTestEntry({ ...enabled,
    WEB_EDITOR_TEST_MYSQL_URL: 'mysql://localhost/qa_test?socketPath=/var/run/mysqld/mysqld.sock',
    WEB_RUNTIME_TEST_MYSQL_USE_EXISTING_DATABASE: 'false',
  }), /External MySQL targets/);
});

test('existing-database flags cannot authorize a connection without a URL', () => {
  for (const flag of ['true', 'TRUE', '1', 'yes', 'unexpected']) {
    assert.throws(() => ownedMysqlTestEntry({ ...enabled,
      WEB_RUNTIME_TEST_MYSQL_USE_EXISTING_DATABASE: flag,
    }), /existing databases are forbidden/);
  }
});

test('the fixture opt-in is required and absence may only skip without connecting', () => {
  assert.throws(() => ownedMysqlTestEntry({}), /Explicit CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1/);
  assert.equal(ownedMysqlTestEntry({}, { allowSkip: true }), false);
  assert.equal(ownedMysqlTestEntry(enabled), true);
});

for (const filename of ['job_executor.test.js', 'web_runtime_secret_envelope_mysql.integration.test.js']) {
  test(`${filename} rejects an external target before any driver/application import`, () => {
    const imports = [];
    assert.throws(() => vm.runInNewContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
      process: { env: { ...enabled, WEB_EDITOR_TEST_MYSQL_URL: 'mysql://localhost/clinicaclick' } },
      require(name) {
        imports.push(name);
        if (name === './fixtures/owned_mysql_test_entry.fixture') return { ownedMysqlTestEntry };
        throw Error('DRIVER_OR_APPLICATION_BOOTSTRAP_MUST_NOT_RUN');
      },
    }, { filename }), /External MySQL targets/);
    assert.deepEqual(imports, ['./fixtures/owned_mysql_test_entry.fixture']);
  });
}
