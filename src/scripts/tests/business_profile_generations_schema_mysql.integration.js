'use strict';
const assert=require('node:assert/strict'),D=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const C=require('../../lib/rdsSchemaMigration'),G=require('../../lib/rdsSchemaGbpGenerationIndexReplacement');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mysql=require('mysql2');
const T=require('../../lib/rdsSchemaMigrationTransport'),{digest}=require('../../lib/securitySchemaContract');
withIsolatedCampaignMysql(async({sql,report})=>{
 const q=sql.getQueryInterface();for(const [name,key]of[['Clinicas','id_clinica'],['GoogleConnections','id']])await q.createTable(name,{[key]:{type:D.INTEGER,primaryKey:true}});
 await sql.query('INSERT INTO Clinicas VALUES (71),(72)');await sql.query('INSERT INTO GoogleConnections VALUES(81)');
 await require('../../../migrations/20250915103000-create-clinicbusinesslocations').up(q,D);
 await require('../../../migrations/20260913000000-add-business-profile-broker-read-binding').up(q,D);
 await require('../../../migrations/20261111150000-business-profile-managed-associations').up(q,D);
 await sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES (71,81,'locations/123',0)");
 const before=(await sql.query('SELECT * FROM ClinicBusinessLocations'))[0];
 const source=path.resolve(__dirname,'../../..'),registry=require('../../../ops/security/schema-contract.json');
 const contract={tables:{BusinessProfileBrokerBindingGenerations:registry.tables.BusinessProfileBrokerBindingGenerations},migrations:registry.migrations.filter(m=>m.name===G.MIGRATION)};
 const info={revision:'a'.repeat(40),contract,contractDigest:digest(contract),migrations:{[G.MIGRATION]:crypto.createHash('sha256').update(fs.readFileSync(path.join(source,'migrations',G.MIGRATION))).digest('hex')}};
 const identity={database:'campaign_optimization_qa',engineVersion:'8.0.42',physicalDbId:'FICTITIOUS_OWNED_MYSQL'};
 const aws={inspect:async()=>({}),secret:async()=>({}),assertFresh(){},backup:async({journal})=>{journal({event:'backup_request',snapshotId:'FICTITIOUS_NO_AWS'});return {status:'available',createdAt:new Date().toISOString(),physicalDbId:identity.physicalDbId,snapshotId:'FICTITIOUS_NO_AWS'};}};
 const connect=async()=>{const raw=mysql.createConnection({socketPath:path.join(report.root,'mysql.sock'),user:'root',database:identity.database});const connection=raw.promise();await connection.connect();return {raw,identity,query:async(text,values=[])=>(await connection.query(text,values))[0],close:()=>T.closePhysical(connection)};};
 const runner=C.createRunner({sourceInfo:()=>info,awsFactory:()=>aws,connect,storeFactory:()=>C.createStore(path.join(report.root,'rds-ledger'),process.getuid()),operatorUid:()=>0,fileOwner:process.getuid()});
 const plan=await runner.plan({source,selected:[G.MIGRATION],out:path.join(report.root,'plan.json')});
 assert.equal(plan.statementPolicy.guardedIndexReplacement.index,'uniq_clinicbusiness_locationid');
 const applied=await runner.apply({source,planFile:plan.planRef.path,approvePlan:plan.planRef.sha256});assert.equal(applied.compatible,true);
 const events=fs.readFileSync(path.join(path.dirname(applied.resultRef.path),'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 await runner.verify({source,runDirectory:path.dirname(applied.resultRef.path)});
 await assert.rejects(runner.apply({source,planFile:plan.planRef.path,approvePlan:plan.planRef.sha256}),/plan_already_consumed/);
 assert.equal(events.filter(e=>e.event==='gbp_generation_index_before').length,1);assert.equal(events.filter(e=>e.event==='gbp_generation_index_after').length,1);
 const after=(await sql.query('SELECT * FROM ClinicBusinessLocations'))[0];for(const [key,val]of Object.entries(before[0]))assert.deepEqual(after[0][key],val);
 await sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES(72,81,'locations/123',1)");
 await assert.rejects(sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES(71,81,'accounts/9/locations/123',1)"));
 await sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES(71,81,'accounts/9/locations/123',0)");
 await assert.rejects(sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES(71,81,'invalid',0)"));
 await assert.rejects(sql.query("INSERT INTO ClinicBusinessLocations(clinica_id,google_connection_id,location_id,is_active) VALUES(71,81,'999',2)"));
 await assert.rejects(require('../../../migrations/'+G.MIGRATION).down(q),/gbp_generation_preserve_history/);
 // A lost ACK after the physical DROP leaves the normal durable operator
 // fence. Neither replay nor an unsupported continuation can bless it.
 await sql.query('CREATE DATABASE cc_gbp_generation_partial');
 const partial=new D.Sequelize({database:'cc_gbp_generation_partial',username:'root',password:'',dialect:'mysql',dialectOptions:{socketPath:path.join(report.root,'mysql.sock')},logging:false});
 try{
  const qi=partial.getQueryInterface();for(const [name,key]of[['Clinicas','id_clinica'],['GoogleConnections','id']])await qi.createTable(name,{[key]:{type:D.INTEGER,primaryKey:true}});
  await require('../../../migrations/20250915103000-create-clinicbusinesslocations').up(qi,D);await require('../../../migrations/20260913000000-add-business-profile-broker-read-binding').up(qi,D);await require('../../../migrations/20261111150000-business-profile-managed-associations').up(qi,D);
  identity.database='cc_gbp_generation_partial';let dropDispatched=0;
  const faultConnect=async()=>{const admin=await connect(),original=admin.raw.query;admin.raw.query=function(options,values,callback){const text=typeof options==='string'?options:options.sql;if(text===G.SQL){dropDispatched++;return original.call(this,options,values,(error,result,fields)=>callback(error||Error('FICTITIOUS_LOST_ACK'),result,fields));}return original.call(this,options,values,callback);};return admin;};
  const broken=C.createRunner({sourceInfo:()=>info,awsFactory:()=>aws,connect:faultConnect,storeFactory:()=>C.createStore(path.join(report.root,'partial-ledger'),process.getuid()),operatorUid:()=>0,fileOwner:process.getuid()});
  const p2=await broken.plan({source,selected:[G.MIGRATION],out:path.join(report.root,'partial-plan.json')});let refusal;
  try{await broken.apply({source,planFile:p2.planRef.path,approvePlan:p2.planRef.sha256});assert.fail('lost ACK must not be accepted');}catch(error){refusal=error;assert.match(error.message,/requires_reconciliation/);}
  assert.equal(dropDispatched,1);const result=JSON.parse(fs.readFileSync(refusal.resultRef.path));assert.equal(result.automaticReplayAllowed,false);assert.equal(result.status,'rds_schema_failed_preserve_partial');
  assert.equal((await partial.query('SELECT name FROM SequelizeMeta'))[0].length,0);
  const meta=await C.schemaSnapshot({query:async(text,values=[])=>(await partial.query(text,{replacements:values}))[0]});
  await assert.rejects(broken.apply({source,planFile:p2.planRef.path,approvePlan:p2.planRef.sha256}),/previous_attempt_requires_reconciliation/);
  await assert.rejects(broken.reconcile({source,runDirectory:path.dirname(refusal.resultRef.path),out:path.join(report.root,'unsupported-continuation.json')}));
  assert.equal(dropDispatched,1);assert.deepEqual(await C.schemaSnapshot({query:async(text,values=[])=>(await partial.query(text,{replacements:values}))[0]}),meta);
  assert(fs.existsSync(path.join(report.root,'partial-ledger','active.json')));
 }finally{await partial.close();await sql.query('DROP DATABASE cc_gbp_generation_partial');}
 report.checks.push('Standard RDS plan/approved apply/verify and physical adapter acknowledge guarded index replacement with durable metadata pre/post and reject consumed replay; historical columns unchanged; active canonical aliases and invalid IDs/boolean rejected, inactive history retained, down fails closed; AWS/backup transport entirely fictitious');
 report.checks.push('Physical DROP with lost ACK retains durable unknown fence, omits migration marker, refuses replay and unsupported reconciliation without further writes; partial metadata and original operator journal remain evidence');
});
