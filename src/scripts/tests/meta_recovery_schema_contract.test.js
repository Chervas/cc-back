'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const contract=require('../../../ops/security/schema-contract.json');
const {effectiveContract,compare}=require('../../lib/securitySchemaContract');
const TABLE='MetaMarketingRecoveries',GROUP='meta_marketing_recovery',MIGRATION='20261104123000-create-meta-marketing-recoveries.js';
// Isolate this additive dependency from unrelated mandatory legacy tables. Use
// the normal selector and comparator; no SQL, app models or environment load.
function selected(env){
  const effective=effectiveContract(contract,env);
  return {tables:effective.tables[TABLE]?{[TABLE]:effective.tables[TABLE]}:{},migrations:effective.migrations.filter(row=>row.name===MIGRATION),disabledFeatureGroups:effective.disabledFeatureGroups||[]};
}
const missing=()=>({defaults:{},tables:[],columns:[],indexes:[],checks:[],foreignKeys:[],migrations:[]});
function assertMissing(env){
  const actual=missing(),expected=selected(env),result=compare(actual,expected);
  assert(expected.tables[TABLE]);assert(expected.migrations.some(row=>row.name===MIGRATION));assert.equal(result.compatible,false);
  assert(result.issues.some(issue=>issue.table===TABLE&&issue.reason==='missing_table'));assert(result.missingMigrations.includes(MIGRATION));
}
// Frozen native information_schema snapshot from owned MySQL after the exact
// migration above; no SQL or external fixture path is used when tests execute.
// Snapshot SHA256 41de159b585315901921f415bca971ed501dc5bb0a89e5bcf5c8c1886907abaf
const observedNative={
  tables:[
    {"TABLE_NAME":"MetaMarketingRecoveries","ENGINE":"InnoDB","TABLE_COLLATION":"utf8mb4_bin"}
  ],
  columns:[
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"recovery_id","COLUMN_TYPE":"char(36)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"scope_key","COLUMN_TYPE":"varchar(64)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"clinic_ids","COLUMN_TYPE":"text","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"app_id","COLUMN_TYPE":"varchar(30)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"meta_user_id","COLUMN_TYPE":"varchar(30)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"source_connection_id","COLUMN_TYPE":"int","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"canonical_connection_id","COLUMN_TYPE":"int","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"mapping_ids","COLUMN_TYPE":"text","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"snapshot","COLUMN_TYPE":"longtext","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"snapshot_digest","COLUMN_TYPE":"char(64)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"prepared_by_user_id","COLUMN_TYPE":"int","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"prepared_at","COLUMN_TYPE":"datetime(3)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"expires_at","COLUMN_TYPE":"datetime(3)","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"state","COLUMN_TYPE":"enum('prepared','flow_bound','active','retired')","IS_NULLABLE":"NO","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"flow_id","COLUMN_TYPE":"char(36)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"candidate_digest","COLUMN_TYPE":"char(64)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"enrollment_id","COLUMN_TYPE":"char(36)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":"utf8mb4","COLLATION_NAME":"utf8mb4_bin","GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"bound_at","COLUMN_TYPE":"datetime(3)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"activated_at","COLUMN_TYPE":"datetime(3)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""},
    {"TABLE_NAME":"MetaMarketingRecoveries","COLUMN_NAME":"retired_at","COLUMN_TYPE":"datetime(3)","IS_NULLABLE":"YES","COLUMN_DEFAULT":null,"EXTRA":"","CHARACTER_SET_NAME":null,"COLLATION_NAME":null,"GENERATION_EXPRESSION":""}
  ],
  indexes:[
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"cc_meta_recovery_canonical","NON_UNIQUE":0,"SEQ_IN_INDEX":1,"COLUMN_NAME":"canonical_connection_id","SUB_PART":null,"INDEX_TYPE":"BTREE"},
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"cc_meta_recovery_enrollment","NON_UNIQUE":0,"SEQ_IN_INDEX":1,"COLUMN_NAME":"enrollment_id","SUB_PART":null,"INDEX_TYPE":"BTREE"},
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"cc_meta_recovery_flow","NON_UNIQUE":0,"SEQ_IN_INDEX":1,"COLUMN_NAME":"flow_id","SUB_PART":null,"INDEX_TYPE":"BTREE"},
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"cc_meta_recovery_scope_state","NON_UNIQUE":1,"SEQ_IN_INDEX":1,"COLUMN_NAME":"scope_key","SUB_PART":null,"INDEX_TYPE":"BTREE"},
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"cc_meta_recovery_scope_state","NON_UNIQUE":1,"SEQ_IN_INDEX":2,"COLUMN_NAME":"state","SUB_PART":null,"INDEX_TYPE":"BTREE"},
    {"TABLE_NAME":"MetaMarketingRecoveries","INDEX_NAME":"PRIMARY","NON_UNIQUE":0,"SEQ_IN_INDEX":1,"COLUMN_NAME":"recovery_id","SUB_PART":null,"INDEX_TYPE":"BTREE"}
  ],
  checks:[
  ],
  foreignKeys:[
  ],
  migrations:[],
};
test('RDS requires recovery history with the cohort flag off because negative authority is unconditional',()=>{
  assert.deepEqual(contract.featureGroups[GROUP],{enabledWhenAny:{DB_TLS_REQUIRED:'true',META_MARKETING_LEGACY_RECOVERY_ENABLED:'true'},tables:[TABLE],migrations:[MIGRATION]});
  assertMissing({DB_TLS_REQUIRED:'true',META_MARKETING_LEGACY_RECOVERY_ENABLED:'false'});
  assertMissing({DB_TLS_REQUIRED:'true'});
});
test('isolated DEV without TLS or recovery explicitly skips this dependency without changing the normal schema comparator',()=>{
  const expected=selected({DB_TLS_REQUIRED:'false',META_MARKETING_LEGACY_RECOVERY_ENABLED:'false'});
  assert.equal(expected.tables[TABLE],undefined);assert.deepEqual(expected.migrations,[]);assert(expected.disabledFeatureGroups.includes(GROUP));
  assert.equal(compare(missing(),expected).compatible,true);
});
test('DEV recovery opt-in requires the table and migration even when TLS is false',()=>{
  assertMissing({DB_TLS_REQUIRED:'false',META_MARKETING_LEGACY_RECOVERY_ENABLED:'true'});
});
test('the recovery table contract preserves all twenty native column metadata fields, binary text and millisecond dates',()=>{
  const table=contract.tables[TABLE];assert.equal(table.ENGINE,'InnoDB');assert.equal(table.TABLE_COLLATION,'utf8mb4_bin');
  assert.deepEqual(table.columns.map(column=>column.COLUMN_NAME),['recovery_id','scope_key','clinic_ids','app_id','meta_user_id','source_connection_id','canonical_connection_id','mapping_ids','snapshot','snapshot_digest','prepared_by_user_id','prepared_at','expires_at','state','flow_id','candidate_digest','enrollment_id','bound_at','activated_at','retired_at']);
  const metadata=['CHARACTER_SET_NAME','COLLATION_NAME','COLUMN_DEFAULT','COLUMN_NAME','COLUMN_TYPE','EXTRA','GENERATION_EXPRESSION','IS_NULLABLE'];
  for(const column of table.columns){
    assert.deepEqual(Object.keys(column).sort(),metadata);assert.equal(column.COLUMN_DEFAULT,null);assert.equal(column.EXTRA,'');assert.equal(column.GENERATION_EXPRESSION,'');
    const textual=!/^(int|datetime)/.test(column.COLUMN_TYPE);
    assert.equal(column.CHARACTER_SET_NAME,textual?'utf8mb4':null);assert.equal(column.COLLATION_NAME,textual?'utf8mb4_bin':null);
  }
  assert.equal(table.columns.find(column=>column.COLUMN_NAME==='snapshot').COLUMN_TYPE,'longtext');
  assert.equal(table.columns.find(column=>column.COLUMN_NAME==='state').COLUMN_TYPE,"enum('prepared','flow_bound','active','retired')");
  for(const name of ['prepared_at','expires_at','bound_at','activated_at','retired_at'])assert.equal(table.columns.find(column=>column.COLUMN_NAME===name).COLUMN_TYPE,'datetime(3)');
  assert.deepEqual(table.columns.filter(column=>column.IS_NULLABLE==='YES').map(column=>column.COLUMN_NAME),['canonical_connection_id','flow_id','candidate_digest','enrollment_id','bound_at','activated_at','retired_at']);
});
test('PRIMARY, three unique identities and the scope/state index are required with no foreign-key cascade',()=>{
  const table=contract.tables[TABLE];assert.equal(table.indexes.length,5);assert.deepEqual(table.foreignKeys,[]);
  for(const [name,fields,unique] of [['PRIMARY',['recovery_id'],0],['cc_meta_recovery_canonical',['canonical_connection_id'],0],['cc_meta_recovery_flow',['flow_id'],0],['cc_meta_recovery_enrollment',['enrollment_id'],0],['cc_meta_recovery_scope_state',['scope_key','state'],1]]){
    const index=table.indexes.find(value=>value.name===name);assert(index);
    assert.deepEqual(index.columns,fields.map((column,i)=>({INDEX_NAME:name,NON_UNIQUE:unique,SEQ_IN_INDEX:i+1,COLUMN_NAME:column,SUB_PART:null,INDEX_TYPE:'BTREE'})));
  }
});
test('normal publication pins the exact current recovery migration bytes',()=>{
  const entries=contract.migrations.filter(row=>row.name===MIGRATION);assert.equal(entries.length,1);
  const filename=path.resolve(__dirname,'../../../migrations',MIGRATION);
  assert.equal(entries[0].sha256,createHash('sha256').update(fs.readFileSync(filename)).digest('hex'));
});

test('native owned-MySQL metadata matches the complete table contract with no waived column or index fields',()=>{
  const expected={tables:{[TABLE]:contract.tables[TABLE]},migrations:[]};
  assert.deepEqual(compare(observedNative,expected),{compatible:true,issues:[],missingMigrations:[]});
});
test('normal comparison rejects missing unique identity, collation/date/default drift and foreign-key additions',()=>{
  const expected={tables:{[TABLE]:contract.tables[TABLE]},migrations:[]};
  for(const change of [a=>a.indexes=a.indexes.filter(index=>index.INDEX_NAME!=='cc_meta_recovery_flow'),
    a=>a.tables[0].TABLE_COLLATION='utf8mb4_0900_ai_ci',
    a=>a.columns.find(column=>column.COLUMN_NAME==='prepared_at').COLUMN_TYPE='datetime',
    a=>a.columns.find(column=>column.COLUMN_NAME==='state').COLUMN_DEFAULT='prepared',
    a=>a.foreignKeys.push({TABLE_NAME:TABLE,CONSTRAINT_NAME:'FICTITIOUS_CASCADE',ORDINAL_POSITION:1,COLUMN_NAME:'source_connection_id',REFERENCED_TABLE_SCHEMA:'<self>',REFERENCED_TABLE_NAME:'MetaConnections',REFERENCED_COLUMN_NAME:'id',UPDATE_RULE:'CASCADE',DELETE_RULE:'CASCADE'})]){
    const actual=structuredClone(observedNative);change(actual);assert.equal(compare(actual,expected).compatible,false);
  }
});
