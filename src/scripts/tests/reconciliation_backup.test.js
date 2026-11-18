'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {verifyReconciliationBackup,validateProof,createOperationVerifier}=require('../../lib/cliniccloud-import/reconciliation-backup');
const prepared={target:'crm',database_identity:{host:'fixture.rds.test',port:3306,database:'fixture',server_uuid:'fixture',server_hostname:'fixture'}};
const fixtureProof=()=>({schema:'clinicaclick-rds-backup-verification/1',target:'crm',runtime:'staging',freshAwsRead:true,snapshotStatus:'available',clinicalRowDmlPerformed:false,sourceIdentitySha256:hash(prepared.database_identity),checkedAtEpochMs:1000,expiresAtEpochMs:2000});
test('CRM requires a verified RDS receipt instead of a legacy or fabricated local dump',async()=>{
 let calls=0;
 await assert.rejects(verifyReconciliationBackup({options:{'--backup-file':'old.sql.gz','--backup-sha256':'a'.repeat(64)},prepared,verifySqlBackup:async()=>{calls++}}),/VERIFIED_RDS/);
 assert.equal(calls,0);
});
test('the native RDS verifier receives only non-secret source identity and receipt reference',async()=>{
 let input;
 const options={'--rds-backup-receipt':'/private/result.json','--rds-backup-sha256':'a'.repeat(64)};
 const proof=await verifyReconciliationBackup({options,prepared,now:()=>1500,verifyRdsBackup:async value=>{input=value;return fixtureProof()}});
 assert.equal(proof.freshAwsRead,true);assert.deepEqual(input,{sourceIdentity:prepared.database_identity,receiptPath:'/private/result.json',receiptSha256:'a'.repeat(64)});
});
test('expiry, database drift, nonterminal snapshot and missing fresh AWS proof fail before row DML',()=>{
 for(const patch of [{expiresAtEpochMs:1400},{checkedAtEpochMs:1600},{sourceIdentitySha256:'wrong'},{snapshotStatus:'creating'},{freshAwsRead:false},{runtime:'dev'}]) assert.throws(()=>validateProof({...fixtureProof(),...patch},prepared,1500));
});
test('DEV retains its isolated SQL backup path and cannot consume a CRM receipt',async()=>{
 const dev={...prepared,target:'dev'},options={'--backup-file':'fixture.sql.gz','--backup-sha256':'b'.repeat(64)};let checked;
 const proof=await verifyReconciliationBackup({options,prepared:dev,now:()=>1000,verifySqlBackup:async(...args)=>{checked=args}});
 assert.deepEqual(checked,['fixture.sql.gz','b'.repeat(64)]);assert.equal(proof.target,'dev');
 await assert.rejects(verifyReconciliationBackup({options:{...options,'--rds-backup-receipt':'crm.json'},prepared:dev}),/DEV_BACKUP/);
});
test('the CLI operation verifier retains live identity and checks expiry before each source proof',()=>{
 let at=1500,calls=0;const operation={action:'create'},live={patients:[{id_paciente:99}]};
 const verifier=createOperationVerifier(fixtureProof(),prepared,(op,identity)=>{calls++;assert.equal(op,operation);assert.equal(identity,live);return 'verified'},()=>at);
 assert.equal(verifier(operation,live),'verified');at=2100;assert.throws(()=>verifier(operation,live),/EXPIRED/);assert.equal(calls,1);
});
