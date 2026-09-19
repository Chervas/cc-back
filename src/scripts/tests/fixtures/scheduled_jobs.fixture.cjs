'use strict';
require('./security_offline_runtime.cjs');
const assert = require('node:assert/strict'); const sequelize = require('sequelize');
const file = require.resolve('../../../../models');
assert.equal(require.cache[file], undefined, 'Install the test model boundary before importing scheduler sources');
const forbidden = () => { throw Error('UNEXPECTED_SQL_IN_SCHEDULER_QA'); };
const table = () => Object.fromEntries(['findAll','findOne','findByPk','create','update','destroy','count'].map(name => [name, forbidden]));
const sql = new sequelize.Sequelize('offline', 'offline', 'fictitious', { host: 'offline.invalid', dialect: 'mysql', logging: false });
sql.query = forbidden; sql.transaction = forbidden;
const models = new Proxy({ sequelize: sql, Sequelize: sequelize }, {
  get(target, key) { if (!Object.hasOwn(target, key)) target[key] = table(); return target[key]; },
});
models.JobRequest = require('../../../../models/jobrequest')({ define: (_name, rawAttributes, options) => ({ ...table(), rawAttributes, options }) }, sequelize.DataTypes);
require.cache[file] = { id: file, filename: file, loaded: true, exports: models };
