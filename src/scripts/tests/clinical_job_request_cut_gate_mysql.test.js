'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const mysql=require('mysql2/promise');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {acquireClinicalJobRequestCutGate}=require('../../lib/clinicalJobRequestCutGate');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('SQL cut gate blocks claims across the check/stop window, releases on rejection, and preserves rows when a blocked consumer exits',async()=>{
 await withIsolatedCampaignMysql(async({sql,report,models})=>{
  await sql.query("CREATE TABLE JobRequests (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL, attempts INT NOT NULL DEFAULT 0) ENGINE=InnoDB");
  await sql.query("INSERT INTO JobRequests(id,status) VALUES(1,'pending'),(2,'waiting')");
  const connect=()=>mysql.createConnection({socketPath:path.join(report.root,'mysql.sock'),user:'root',database:report.database});
  const options={connect,database:report.database};
  await assert.rejects(acquireClinicalJobRequestCutGate({...options,database:'wrong_database'}),/connection_invalid/);
  await sql.query("UPDATE JobRequests SET status='running' WHERE id=1");
  await assert.rejects(acquireClinicalJobRequestCutGate(options),/active_jobs/);
  await sql.query("UPDATE JobRequests SET status='pending' WHERE id=1");
  const before=(await sql.query('SELECT * FROM JobRequests ORDER BY id'))[0];
  let gate=await acquireClinicalJobRequestCutGate(options),worker,workerDone;
  try {
   await assert.rejects(acquireClinicalJobRequestCutGate(options),/busy/);
   worker=await connect();await worker.query('SET SESSION lock_wait_timeout=2');await worker.beginTransaction();
   let selected=false,providerCalls=0;
   workerDone=(async()=>{
    await worker.query("SELECT * FROM JobRequests WHERE status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED");selected=true;
    await worker.query("UPDATE JobRequests SET status='running',attempts=attempts+1 WHERE id=1");
    await worker.commit();providerCalls++;
   })().then(()=>({ok:true}),error=>({ok:false,code:error.code}));
   await delay(100);assert.equal(selected,false);assert.equal(providerCalls,0);
   assert.deepEqual((await sql.query('SELECT * FROM JobRequests ORDER BY id'))[0],before);
   await gate.verify();
   // Terminating the old consumer while admission is closed must not spend an
   // attempt or call a provider. Release only after the consumer is gone.
   worker.destroy();await gate.verify();await gate.release();
   assert.equal((await workerDone).ok,false);assert.equal(providerCalls,0);
   assert.deepEqual((await sql.query('SELECT * FROM JobRequests ORDER BY id'))[0],before);
   await assert.rejects(gate.verify(),/not_held/);await gate.release();
  } finally { if(worker)worker.destroy();await gate.release();if(workerDone)await workerDone; }
  // An ordinary release admits the same original row exactly once; the gate
  // itself neither dequeues work nor resets statuses/attempts.
  gate=await acquireClinicalJobRequestCutGate(options);worker=await connect();
  try {
   await worker.beginTransaction();
   workerDone=(async()=>{await worker.query('SELECT * FROM JobRequests WHERE id=1 FOR UPDATE SKIP LOCKED');await worker.query("UPDATE JobRequests SET status='completed',attempts=attempts+1 WHERE id=1");await worker.commit();})();
   await delay(50);await gate.verify();await gate.release();await workerDone;
   const [rows]=await sql.query('SELECT * FROM JobRequests ORDER BY id');
   assert.equal(rows[0].status,'completed');assert.equal(rows[0].attempts,1);assert.deepEqual(rows[1],before[1]);
  } finally {await gate.release();await worker.end();}
  // Lock contention must fail promptly and leave no acquired operator lock.
  worker=await connect();await worker.beginTransaction();await worker.query('SELECT * FROM JobRequests WHERE id=2 FOR UPDATE');
  const started=Date.now();
  try {await assert.rejects(acquireClinicalJobRequestCutGate({...options,lockWaitSeconds:1}),e=>e.code==='ER_LOCK_WAIT_TIMEOUT');assert(Date.now()-started<3500);}
  finally {await worker.rollback();await worker.end();}
  gate=await acquireClinicalJobRequestCutGate(options);await gate.release();
  report.checks.push('Existing transactional FOR UPDATE/SKIP LOCKED claim cannot cross held READ barrier; ordinary reads continue; exiting blocked consumer spends no attempt; busy/active/wrong-target/timeout failures release locks; controlled release admits original work once');
  await sql.query('DROP TABLE JobRequests');
  models.Sequelize=require('sequelize');
  models.JobRequest=require('../../../models/jobrequest')(sql,models.Sequelize.DataTypes);
  await models.JobRequest.sync();
  const service=require('../../services/jobRequests.service');
  await models.JobRequest.bulkCreate([101,102].map(id=>({id,type:'clinical_cut_fixture',status:'pending',payload:{__runtime_namespace:service.getCurrentRuntimeNamespace()}})));
  for(const [id,claim]of [[101,()=>service.claimNextJob(['normal'],['clinical_cut_fixture'])],[102,()=>service.claimJobById(102)]]){
   gate=await acquireClinicalJobRequestCutGate(options);let claimed=false;
   const pending=claim().then(value=>{claimed=true;return value;});
   try{
    await delay(75);assert.equal(claimed,false);assert.equal((await models.JobRequest.findByPk(id)).attempts,0);
    await gate.verify();await gate.release();const job=await pending;assert.equal(job.id,id);assert.equal(job.status,'running');assert.equal(job.attempts,1);
    await service.markCompleted(id,{resultSummary:{fictitious:true}});
   }finally{await gate.release();await pending;}
  }
  report.checks.push('Actual application JobRequest model and both production claimNextJob/claimJobById paths are blocked before admission; original jobs claimed once after controlled release');
 });
});
