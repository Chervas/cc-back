'use strict';require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../../lib/rdsSchemaGbpGenerationIndexReplacement'),P=require('../../lib/rdsSchemaMigrationPolicy'),C=require('../../lib/rdsSchemaMigration');
function fixture(after=false){return {columns:[{COLUMN_NAME:'active_canonical_location_id',COLUMN_TYPE:'varchar(30)',IS_NULLABLE:'YES',EXTRA:'STORED GENERATED',GENERATION_EXPRESSION:"(case when (`is_active` = 1) then substring_index(`location_id`,_utf8mb4\\'/\\',-(1)) else NULL end)"},{COLUMN_NAME:'canonical_location_id',COLUMN_TYPE:'varchar(30)',IS_NULLABLE:'YES',EXTRA:'STORED GENERATED',GENERATION_EXPRESSION:"substring_index(`location_id`,_utf8mb4\\'/\\',-(1))"}],indexes:[['cc_gbp_active_canonical',0,'active_canonical_location_id'],['cc_gbp_location_history',1,'canonical_location_id'],...(!after?[['uniq_clinicbusiness_locationid',0,'location_id']]:[])].map(([INDEX_NAME,NON_UNIQUE,COLUMN_NAME])=>({INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX:1,SUB_PART:null,INDEX_TYPE:'BTREE'})),checks:[{CONSTRAINT_NAME:'cc_gbp_location_grammar',ENFORCED:'YES',CHECK_CLAUSE:"(regexp_like(`location_id`,_utf8mb4\\'^(accounts/[1-9][0-9]{0,29}/)?(locations/)?[1-9][0-9]{0,29}$\\',_utf8mb4\\'c\\') and (`is_active` in (0,1)))"}]};}
test('replacement recognizes one literal SQL and one owned migration, leaving generic DROP forbidden',()=>{
 assert.equal(G.accepts(G.SQL,G.MIGRATION),true);assert.equal(G.accepts(G.SQL+';',G.MIGRATION),true);
 for(const sql of [G.SQL+' ',G.SQL.replace('uniq_','foreign_'),G.SQL.replace('ClinicBusinessLocations','Other'),G.SQL+'; SELECT 1','DROP TABLE ClinicBusinessLocations'])assert.equal(G.accepts(sql,G.MIGRATION),false);
 assert.equal(G.accepts(G.SQL,'other.js'),false);assert.throws(()=>P.statementKind(G.SQL));
});
test('standard CLI operator pins include the reviewed replacement guard source',()=>{
 const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');const source=path.resolve(__dirname,'../../..');
 const pins=require('../security-rds-schema-migrate').operatorPins(source);const pin=pins.find(p=>p.path==='src/lib/rdsSchemaGbpGenerationIndexReplacement.js');assert(pin);assert.equal(pin.sha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,pin.path))).digest('hex'));
});
test('guard requires exact canonical expressions, enforced grammar/boolean CHECK and both replacement indexes before DROP',()=>{
 assert(G.validate(fixture()));assert(G.validate(fixture(true),true));
 for(const change of [s=>s.columns.pop(),s=>s.columns[0].EXTRA='',s=>s.columns[0].GENERATION_EXPRESSION=s.columns[0].GENERATION_EXPRESSION.replace('is_active','other'),s=>s.indexes[0].NON_UNIQUE=1,s=>s.indexes[1].COLUMN_NAME='location_id',s=>s.indexes.pop(),s=>s.checks[0].ENFORCED='NO',s=>s.checks[0].CHECK_CLAUSE=s.checks[0].CHECK_CLAUSE.replace('(0,1)','(0,1,2)')]){const state=fixture();change(state);assert.throws(()=>G.validate(state));}
 assert.throws(()=>G.validate(fixture(),true));assert.throws(()=>G.validate(fixture(true)));
});
test('actual RDS adapter checks and journals metadata around exact DROP; wrong owner and missing replacement perform no write',async()=>{
 for(const variant of ['ok','wrong-owner','not-ready','unknown']){
  let dropped=false,writes=0;const events=[];const raw={query(options,values,callback){if(typeof values==='function')callback=values;const text=typeof options==='string'?options:options.sql;
   if(text===G.SQL){writes++;if(variant==='unknown')return queueMicrotask(()=>callback(Error('connection lost')));dropped=true;return queueMicrotask(()=>callback(null,{affectedRows:0,warningStatus:0}));}
   if(text==='SHOW WARNINGS')return queueMicrotask(()=>callback(null,[]));
   for(const [key,sql]of Object.entries(G.sql))if(text===sql){const data=fixture(dropped);if(variant==='not-ready')data.indexes=data.indexes.filter(x=>x.INDEX_NAME!=='cc_gbp_active_canonical');return queueMicrotask(()=>callback(null,data[key]));}
   queueMicrotask(()=>callback(Error('unexpected SQL')));
  }};raw.execute=raw.query;
  const bridge=C.migrationInterface({admin:{raw},aws:{assertFresh(){}},journal:e=>events.push(e),migrationName:variant==='wrong-owner'?'other.js':G.MIGRATION});
  try{const action=bridge.queryInterface.removeIndex('ClinicBusinessLocations','uniq_clinicbusiness_locationid');if(variant==='ok'){await action;assert.equal(events.filter(e=>e.event==='gbp_generation_index_before').length,1);assert.equal(events.filter(e=>e.event==='gbp_generation_index_after').length,1);}else await assert.rejects(action);
   assert.equal(writes,variant==='ok'||variant==='unknown'?1:0);if(variant==='unknown'){assert.equal(events.filter(e=>e.event==='statement_request').length,1);assert.equal(events.filter(e=>e.event==='statement_ack').length,0);}}
  finally{await bridge.restore();}
 }
});
module.exports={fixture};
