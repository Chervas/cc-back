'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
// Tests cannot open a provider, root helper, database or secret file. All AWS
// responses below are explicitly TESTONLY fixtures passed to the real adapter.
const child=require('node:child_process');
for(const key of ['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync'])child[key]=()=>{throw Error('TESTONLY_REAL_PROCESS_FORBIDDEN');};
require('node:net').Socket.prototype.connect=()=>{throw Error('TESTONLY_REAL_SOCKET_FORBIDDEN');};
const fs=require('node:fs'),read=fs.readFileSync;
fs.readFileSync=(file,...args)=>{if(typeof file==='string'&&/\/\.env|\/\.aws\/|\/proc\/.*environ/.test(file))throw Error('TESTONLY_SECRET_READ_FORBIDDEN');return read.call(fs,file,...args);};
const R=require('../../lib/rdsSchemaMigration'),P=require('../../lib/rdsSchemaMigrationPolicy'),T=require('../../lib/rdsSchemaMigrationTransport');
const {digest}=require('../../lib/securitySchemaContract');
const {hash:stableHash}=require('../../lib/cliniccloud-import/adapter');
const {createRdsBackupReceiptVerifier,MAX_BACKUP_AGE_MS,ACCOUNT,REGION}=require('../../lib/cliniccloud-import/rds-backup-receipt');
const NOW=Date.parse('2026-11-18T10:00:00Z');

function fixture({nativeAws=false}={}){
 const nonce='11111111-2222-3333-4444-555555555555',dir=`${R.STATE}/runs/${nonce}`,planPath='/home/ubuntu/qa-evidence/rds-schema-plan-TESTONLY/plan.json';
 const identity={host:T.HOST,port:3306,database:T.DATABASE,serverUuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',engineVersion:'8.4.11',
  physicalDbId:T.PRIMARY_DBI,secretVersionId:'TESTONLY_VERSION_NOT_SECRET',caSha256:T.CA_SHA,strictTls:true,hostnameVerified:true};
 const source={host:T.HOST,port:3306,database:T.DATABASE,server_uuid:identity.serverUuid,server_hostname:'ip-10-0-0-TESTONLY'};
 const plan={schema:P.PLAN_SCHEMA,createdAtEpochMs:NOW-180000,awsProfile:'clinicaclick-prov-temp',sourceRevision:'a'.repeat(40),
  effectiveContractDigest:'b'.repeat(64),effectiveContractScope:{schema:'clinicaclick-rds-effective-requirements/1',runtime:'staging'},identity,
  toApply:['20261118073000-patient-follow-up-target-month.js'],policy:{schemaOnly:true,clinicalRowDml:false}};
 const backup={snapshotId:'cc-schema-'+nonce.replace(/-/g,''),physicalDbId:T.PRIMARY_DBI,createdAt:new Date(NOW-120000).toISOString(),status:'available',checkedAtEpochMs:NOW-30000};
 backup.snapshotArn=`arn:aws:rds:${REGION}:${ACCOUNT}:snapshot:${backup.snapshotId}`;
 const result={status:'rds_schema_applied_and_verified',operationNonce:nonce,sourceRevision:plan.sourceRevision,effectiveContractDigest:plan.effectiveContractDigest,
  effectiveContractScope:plan.effectiveContractScope,identity,backup,completed:plan.toApply,after:{migrations:plan.toApply},compatibility:{compatible:true},
  closure:{physicalCloseObserved:true,physicalStreamDestroyed:true}};
 const journal=[{event:'backup_request',snapshotId:backup.snapshotId,atEpochMs:NOW-120001},{event:'backup_create_ack',snapshotId:backup.snapshotId,atEpochMs:NOW-120000},
  {event:'backup_available',...backup,atEpochMs:backup.checkedAtEpochMs},{event:'terminal',status:result.status,accepted:true,writesDispatched:2,atEpochMs:NOW-10000}];
 const live={DBSnapshotIdentifier:backup.snapshotId,DBSnapshotArn:backup.snapshotArn,DBInstanceIdentifier:T.DB_ID,DbiResourceId:T.PRIMARY_DBI,
  Status:'available',Encrypted:true,Engine:'mysql',EngineVersion:'8.4.11',SnapshotCreateTime:backup.createdAt};
 const db={DBInstanceIdentifier:T.DB_ID,DbiResourceId:T.PRIMARY_DBI,DBInstanceArn:`arn:aws:rds:${REGION}:${ACCOUNT}:db:${T.DB_ID}`,
  DBInstanceStatus:'available',Endpoint:{Address:T.HOST,Port:3306},PubliclyAccessible:false,Engine:'mysql',EngineVersion:'8.4.11',StorageEncrypted:true,
  MultiAZ:true,BackupRetentionPeriod:7,PendingModifiedValues:{},DBParameterGroups:[{ParameterApplyStatus:'in-sync'}],
  MasterUserSecret:{SecretStatus:'active',SecretArn:`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:TESTONLY`}};
 const files=new Map(),calls=[],readPaths=[];let reference;
 const bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
 const refresh=()=>{
  result.afterDigest=digest(result.after);const planBytes=bytes(plan);result.planRef={path:planPath,sha256:P.sha(planBytes)};
  files.set(planPath,planBytes);files.set(`${R.STATE}/claims/${result.planRef.sha256}.json`,bytes({operationNonce:nonce,planRef:result.planRef}));
  files.set(dir+'/journal.jsonl',Buffer.from(journal.map(row=>JSON.stringify(row)).join('\n')+'\n'));
  const resultBytes=bytes(result);files.set(dir+'/result.json',resultBytes);reference={path:dir+'/result.json',sha256:P.sha(resultBytes)};
 };
 refresh();
 const options={getuid:()=>0,now:()=>NOW,
  io:{lstatSync:()=>({uid:0,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false}),realpathSync:value=>value},
  readPrivate:(file,owner,parse=JSON.parse)=>{assert.equal(owner,0);readPaths.push(file);const value=files.get(file);if(!value)throw Error('TESTONLY_MISSING_FILE');return{value:parse(value),reference:{path:file,sha256:P.sha(value)}};},
  execute:async(binary,args,config)=>{
   calls.push({binary,args,config});assert.equal(binary,'/sbin/runuser');assert(args.includes('--region')&&args.includes(REGION));
   if(args.includes('export-credentials'))return{stdout:JSON.stringify({AccessKeyId:'TESTONLY_KEY',SecretAccessKey:'TESTONLY_SECRET',SessionToken:'TESTONLY_TOKEN',Expiration:new Date(NOW+3600000).toISOString()})};
   if(args.includes('get-caller-identity'))return{stdout:JSON.stringify({Account:ACCOUNT,Arn:`arn:aws:sts::${ACCOUNT}:assumed-role/TESTONLY/session`})};
   if(args.includes('describe-db-instances'))return{stdout:JSON.stringify({DBInstances:[db]})};
   if(args.includes('describe-db-snapshots'))return{stdout:JSON.stringify({DBSnapshots:[live]})};
   throw Error('TESTONLY_UNEXPECTED_AWS_OPERATION');
  },
 };
 if(!nativeAws)options.awsFactory=()=>({inspect:async()=>{calls.push({inspect:true});return structuredClone(db);}});
 return{source,plan,result,backup,journal,live,db,calls,readPaths,files,refresh,options,
  verify:()=>createRdsBackupReceiptVerifier(options)({sourceIdentity:source,receiptPath:reference.path,receiptSha256:reference.sha256}),
  reference:()=>reference};
}

test('real ledger format binds result, plan, claim, journal and fresh read without DML or secrets',async()=>{
 const f=fixture(),proof=await f.verify();
 assert.equal(proof.freshAwsRead,true);assert.equal(proof.runtime,'staging');assert.equal(proof.physicalDbId,T.PRIMARY_DBI);
 assert.equal(proof.sourceIdentitySha256,stableHash(f.source));assert.equal(proof.expiresAtEpochMs,NOW+300000);
 assert.equal(f.calls.filter(row=>row.inspect).length,2);assert.equal(f.calls.filter(row=>row.args?.includes('describe-db-snapshots')).length,1);
 assert.equal(f.readPaths.length,4);assert(!JSON.stringify(proof).includes('TESTONLY_SECRET'));
});
test('default RDS transport uses native temporary AWS identity and read-only calls, never Secrets Manager',async()=>{
 const f=fixture({nativeAws:true}),proof=await f.verify();assert.equal(proof.snapshotStatus,'available');
 const calls=f.calls.map(row=>row.args.join(' '));
 assert(calls.some(line=>line.includes('get-caller-identity')));assert(calls.some(line=>line.includes('describe-db-instances')));
 assert(calls.some(line=>line.includes('describe-db-snapshots')));assert(!calls.some(line=>/get-secret-value|create-db-snapshot/.test(line)));
 for(const row of f.calls){assert.equal(row.config.env.AWS_MAX_ATTEMPTS,'1');assert(!Object.keys(row.config.env).some(key=>/SECRET_ACCESS|SESSION_TOKEN/.test(key)));}
});
for(const [name,mutate,code]of[
 ['DEV source',f=>f.source.database='clinicaclick_dev_isolated','SOURCE_IDENTITY'],
 ['foreign host',f=>f.source.host='other.example.test','SOURCE_IDENTITY'],
 ['different SQL uuid',f=>f.source.server_uuid='00000000-0000-0000-0000-000000000000','DATABASE_IDENTITY'],
 ['unobserved SQL hostname',f=>delete f.source.server_hostname,'SOURCE_IDENTITY'],
 ['QA physical instance',f=>f.result.identity={...f.result.identity,physicalDbId:'db-TESTONLY-QA'},'SUCCESSFUL_STAGING'],
 ['failed release',f=>f.result.status='rds_schema_failed_preserve_partial','SUCCESSFUL_STAGING'],
 ['not staging',f=>f.plan.effectiveContractScope={runtime:'gateway'},'SUCCESSFUL_STAGING'],
 ['clinical DML release policy',f=>f.plan.policy.clinicalRowDml=true,'SUCCESSFUL_STAGING'],
 ['old snapshot',f=>f.backup.createdAt=new Date(NOW-MAX_BACKUP_AGE_MS-1).toISOString(),'SNAPSHOT_STALE'],
 ['future backup check',f=>f.backup.checkedAtEpochMs=NOW+1,'SNAPSHOT_STALE'],
 ['wrong snapshot account',f=>f.backup.snapshotArn=f.backup.snapshotArn.replace(ACCOUNT,'000000000000'),'SNAPSHOT_STALE'],
 ['journal different nonce',f=>f.journal[1].snapshotId='unrelated','JOURNAL_BINDING'],
 ['journal terminal not accepted',f=>f.journal.at(-1).accepted=false,'JOURNAL_BINDING'],
 ['live snapshot not available',f=>f.live.Status='deleting','FRESH_SNAPSHOT'],
 ['live snapshot different DBI',f=>f.live.DbiResourceId='db-TESTONLY','FRESH_SNAPSHOT'],
 ['publicly accessible DB',f=>f.db.PubliclyAccessible=true,'FRESH_DATABASE_IDENTITY'],
 ['live DB endpoint changed',f=>f.db.Endpoint.Address='other.example.test','FRESH_DATABASE_IDENTITY'],
])test(`refuses ${name}`,async()=>{const f=fixture();mutate(f);f.refresh();await assert.rejects(f.verify(),new RegExp(code));});
test('root helper, canonical receipt path, caller SHA and private root directories are mandatory',async()=>{
 let f=fixture();f.options.getuid=()=>1000;await assert.rejects(f.verify(),/NATIVE_ROOT/);assert.equal(f.calls.length,0);
 f=fixture();await assert.rejects(createRdsBackupReceiptVerifier(f.options)({sourceIdentity:f.source,receiptPath:'/tmp/result.json',receiptSha256:f.reference().sha256}),/REFERENCE_INVALID/);
 f=fixture();await assert.rejects(createRdsBackupReceiptVerifier(f.options)({sourceIdentity:f.source,receiptPath:f.reference().path,receiptSha256:'0'.repeat(64)}),/HASH_MISMATCH/);
 f=fixture();f.options.io.lstatSync=()=>({uid:1000,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false});await assert.rejects(f.verify(),/PRIVATE_DIRECTORY/);
 f=fixture();f.options.io.realpathSync=value=>value+'/symlink';await assert.rejects(f.verify(),/PRIVATE_DIRECTORY/);
});
test('plan and claim tampering or truncated journals refuse before AWS',async()=>{
 let f=fixture();f.files.set(f.result.planRef.path,Buffer.from('{}'));await assert.rejects(f.verify(),/PLAN_HASH_MISMATCH/);assert.equal(f.calls.length,0);
 f=fixture();f.files.set(f.reference().path.replace('result.json','journal.jsonl'),Buffer.from('{}'));await assert.rejects(f.verify(),/JOURNAL_TRUNCATED/);assert.equal(f.calls.length,0);
});
test('AWS failure does not return a stale proof or expose native stdout/stderr',async()=>{
 const f=fixture(),error=Object.assign(Error('sensitive native output'),{stdout:'TESTONLY_SECRET',stderr:'TESTONLY_SECRET'});
 f.options.execute=async()=>{throw error;};await assert.rejects(f.verify(),/AWS_READ_FAILED/);
 assert.equal(error.stdout,'');assert.equal(error.stderr,'');
});
test('a changed instance after snapshot read refuses the second inspection',async()=>{
 const f=fixture();let count=0;f.options.awsFactory=()=>({inspect:async()=>++count===1?f.db:{...f.db,DbiResourceId:'db-CHANGED'}});
 await assert.rejects(f.verify(),/FRESH_DATABASE_IDENTITY/);assert.equal(count,2);
});
