'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { report } = require('../../src/scripts/tests/fixtures/aws_costs.fixture');
const production = require('./sync-dev-cache.cjs');
const sourceEnv = () => ({ DB_HOST: 'clinicaclick-mysql.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com', DB_PORT: '3306',
  DB_NAME: 'clinicaclick', DB_USERNAME: 'cc_app_api_ee4b8ca0', DB_PASSWORD: 'FICTITIOUS_SOURCE_PASSWORD', DB_TLS_REQUIRED: 'true', DB_TLS_CA_FILE: '/fixed/fixture-ca.pem' });
const destinationEnv = () => ({ DB_HOST: '127.0.0.1', DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_PASSWORD: 'FICTITIOUS_DEV_PASSWORD' });
const now = () => new Date('2026-09-12T04:00:00Z');
function fixture(destinationRows = []) {
  const ca = Buffer.from('PUBLIC_FIXTURE_CA');
  const filename = path.resolve(__dirname, 'sync-dev-cache.cjs'); const local = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module,exports:module.exports,Buffer,Date,Promise,Set,Map,
    setTimeout,clearTimeout,process:{argv:[],getuid:()=>1000},require:name => name === '../../src/lib/databaseTlsConfig'
      ? { buildDatabaseTlsOptions: () => ({ ssl: { ca,rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2' } }) }
      : name === '../../src/lib/schemaReleaseDatabase' ? { ...local(name),CA:'/fixed/fixture-ca.pem',CA_SHA:createHash('sha256').update(ca).digest('hex') } : local(name) }, { filename });
  const mirror = module.exports; const calls = []; let closed = 0;
  const records = mirror.cacheKeys(now()).map(key => {
    const value = report(key.slice(-7));
    return { cache_key:key,snapshot:key.startsWith('aws:account:')?value.account:value.attributed,
      collected_at:'2026-09-12T01:40:00Z',last_attempt_at:'2026-09-12T01:40:00Z',last_error_code:null,lease_token:null,lease_until:null };
  });
  const createRawConnection = config => {
    const remote = config.host !== '127.0.0.1'; const stream = new EventEmitter(); stream.destroyed=false;stream.closed=false;
    const close = () => { if (!stream.closed) { stream.closed=true;stream.destroyed=true;closed++;stream.emit('close'); } };
    const raw = new EventEmitter(); Object.assign(raw,{ config:{...config},stream,destroy:close });stream.destroy=close;
    const connection = { connection:raw,end:async()=>{queueMicrotask(close);},query:async(input,values)=>{
      const sql=input.sql;calls.push({remote,sql,values});
      if(sql==='SHOW WARNINGS')return[[]];
      if(sql===mirror.IDENTITY_SQL)return[[{uuid:remote?'be301234-1234-4123-8123-123456789abc':mirror.DEV_UUID,database_name:config.database,account:config.user+(remote?'@%':'@localhost'),port:3306}]];
      if(sql===mirror.TLS_SQL)return[[{Variable_name:'Ssl_version',Value:'TLSv1.3'},{Variable_name:'Ssl_cipher',Value:'FIXTURE_CIPHER'}]];
      if(sql===mirror.SELECT_SQL)return[remote?records:destinationRows];
      if(!remote&&[mirror.UPSERT_SQL,'START TRANSACTION','COMMIT','ROLLBACK'].includes(sql))return[{warningStatus:0,affectedRows:1}];
      assert.fail('unexpected SQL');
    } }; connection.execute = connection.query; raw.connect = callback => queueMicrotask(() => callback(null));
    raw.promise = () => connection; raw.end = connection.end; return raw;
  };
  return {mirror,calls,records,createRawConnection,closed:()=>closed};
}
test('mirror executes source SELECTs and destination cost-only transaction, then closes both actual fake streams', async()=>{
  const f=fixture();const source=sourceEnv(),destination=destinationEnv();
  const result=await f.mirror.syncDevCache({sourceEnv:source,destinationEnv:destination,createRawConnection:f.createRawConnection,now});
  assert.equal(result.rowsWritten,4);assert.equal(result.awsCalls,0);assert.equal(result.physicalConnectionsClosed,2);assert.equal(f.closed(),2);
  const writes=f.calls.filter(call=>call.sql===f.mirror.UPSERT_SQL);assert.equal(writes.length,4);
  assert(writes.every(call=>!call.remote&&f.mirror.cacheKeys(now()).includes(call.values[0])&&call.values.length===7));
  assert(f.calls.filter(call=>call.remote).every(call=>[f.mirror.IDENTITY_SQL,f.mirror.TLS_SQL,f.mirror.SELECT_SQL,'SHOW WARNINGS'].includes(call.sql)));
  assert.equal(source.DB_PASSWORD,'');assert.equal(destination.DB_PASSWORD,'');
});
test('unchanged sanitized snapshots do not produce periodic writes; missing source keys never erase destination',()=>{
  const f=fixture();assert.equal(f.mirror.planRows(f.records,f.records,f.mirror.cacheKeys(now())).length,0);
  assert.equal(f.mirror.planRows([],f.records,f.mirror.cacheKeys(now())).length,0);
});
test('arbitrary keys and destination leases are rejected before mutation and both streams still close',async()=>{
  const f=fixture([{cache_key:production.cacheKeys(now())[0],snapshot:null,lease_token:'unknown',lease_until:null}]);
  await assert.rejects(f.mirror.syncDevCache({sourceEnv:sourceEnv(),destinationEnv:destinationEnv(),createRawConnection:f.createRawConnection,now}),/cost_mirror_destination_lease/);
  assert.equal(f.calls.filter(call=>call.sql===f.mirror.UPSERT_SQL).length,0);assert.equal(f.closed(),2);
  assert.throws(()=>production.planRows([{cache_key:'Patient:1',snapshot:null}],[],production.cacheKeys(now())),/cost_mirror_cache_scope/);
});
test('destination AWS gate, other database/host and source TLS relaxation fail before connect',async()=>{
  for(const patch of [{DB_HOST:'localhost'},{DB_NAME:'clinicaclick'},{DB_USERNAME:'root'},{AWS_INFRA_COSTS_ENABLED:'true'}]){
    const f=fixture();let connected=0;
    await assert.rejects(f.mirror.syncDevCache({sourceEnv:sourceEnv(),destinationEnv:{...destinationEnv(),...patch},createRawConnection:()=>{connected++;},now}),/cost_mirror_destination_configuration/);
    assert.equal(connected,0);
  }
  assert.throws(()=>production.configurations({...sourceEnv(),DB_TLS_REQUIRED:'false'},destinationEnv()),/cost_mirror_source_configuration/);
});
test('authentication failure retains and closes the raw socket before a promise connection exists',async()=>{
  const f=fixture();let made=0,closed=0;
  const make=config=>{
    made++;const raw=new EventEmitter(),stream=new EventEmitter();stream.closed=false;stream.destroyed=false;
    const end=()=>{if(!stream.closed){closed++;stream.closed=true;stream.destroyed=true;stream.emit('close');}};
    Object.assign(raw,{config:{...config},stream,end,destroy:end,connect:callback=>queueMicrotask(()=>callback(Error('FICTITIOUS_AUTH_FAILURE'))),
      promise:()=>assert.fail('promise wrapper must not be created after failed handshake')});stream.destroy=end;return raw;
  };
  await assert.rejects(f.mirror.syncDevCache({sourceEnv:sourceEnv(),destinationEnv:destinationEnv(),createRawConnection:make,now}),/cost_mirror_connection_failed/);
  assert.equal(made,1);assert.equal(closed,1);assert.equal(f.calls.length,0);
});
test('dotenv grammar preserves quoted/multiline values, rejects DB duplicates, permits ordered DEV overlays',()=>{
  const first=production.parseEnvironment('DB_PASSWORD="first\\nsecond-long-password"\nEMAIL_PUBLIC_APP_URL=a\nEMAIL_PUBLIC_APP_URL=a\n');
  assert.equal(first.DB_PASSWORD,'first\nsecond-long-password');
  assert.throws(()=>production.parseEnvironment('DB_HOST=x\nDB_HOST=x\n'),/cost_mirror_duplicate_database_key/);
  assert.equal(Object.assign({},production.parseEnvironment('DB_NAME=first\n'),production.parseEnvironment('DB_NAME=second\n')).DB_NAME,'second');
});
