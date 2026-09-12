'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path'); const { createRequire } = require('node:module');
function load(file, overrides, env) {
  const filename = path.resolve(__dirname,'../..',file); const module = { exports: {} }; const local = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{ module,exports:module.exports,process:{env},
    require: name => Object.hasOwn(overrides,name) ? overrides[name] : local(name) },{filename});
  return module.exports;
}
test('shared Sequelize configuration retains required TLS options in every environment', () => {
  const ssl = { ca: 'fictitious', rejectUnauthorized: true, verifyIdentity: true };
  const env = { DB_HOST:'fixture.invalid',DB_NAME:'fixture',DB_USERNAME:'fixture',DB_PASSWORD:'fixture',DB_TLS_REQUIRED:'true' };
  const configs = load('config/config.js',{'dotenv':{config:()=>{}},'../lib/databaseTlsConfig':{
    buildDatabaseTlsOptions: input => { assert.equal(input.DB_TLS_REQUIRED,'true'); return {ssl}; }}},env);
  for (const config of Object.values(configs)) assert.equal(config.dialectOptions.ssl,ssl);
});
test('legacy pool and secondary Sequelize use the canonical identity and verified TLS with no embedded fallback', () => {
  const ssl = { ca:'fictitious',rejectUnauthorized:true,verifyIdentity:true };
  const cfg = { host:'fixture.invalid',username:'fixture_user',password:'SYNTHETIC_SENTINEL',database:'fixture_db',dialect:'mysql',dialectOptions:{ssl} };
  let options; let positional;
  const pool = load('config/db.js',{'./config':{test:cfg},'mysql2/promise':{createPool: input => { options=input;return {}; }}},{NODE_ENV:'test'});
  assert(pool); assert.equal(options.user,cfg.username); assert.equal(options.password,cfg.password); assert.equal(options.database,cfg.database); assert.equal(options.ssl,ssl);
  load('config/database.js',{'./config':{test:cfg},dotenv:{config:()=>{}},
    sequelize:{Sequelize:class {constructor(...args){positional=args;}}}},{NODE_ENV:'test'});
  assert.equal(positional[0],cfg.database); assert.equal(positional[2],cfg.password); assert.equal(positional[3].dialectOptions.ssl,ssl);
  for (const field of ['host','username','password','database']) {
    assert.throws(() => load('config/db.js',{'./config':{test:{...cfg,[field]:undefined}},
      'mysql2/promise':{createPool:()=>assert.fail('Missing identity must not reach driver defaults')}},{NODE_ENV:'test'}),/database_configuration_missing/);
  }
});
