'use strict';
// A single reviewed replacement, never a generic destructive-DDL exception.
const MIGRATION='20261113160000-business-profile-binding-generations.js';
const SQL='DROP INDEX `uniq_clinicbusiness_locationid` ON `ClinicBusinessLocations`';
const sql=Object.freeze({
 columns:"SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ClinicBusinessLocations' AND COLUMN_NAME IN ('canonical_location_id','active_canonical_location_id') ORDER BY COLUMN_NAME",
 indexes:"SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ClinicBusinessLocations' AND INDEX_NAME IN ('uniq_clinicbusiness_locationid','cc_gbp_active_canonical','cc_gbp_location_history') ORDER BY INDEX_NAME,SEQ_IN_INDEX",
 checks:"SELECT t.CONSTRAINT_NAME,t.ENFORCED,c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.CONSTRAINT_SCHEMA=DATABASE() AND t.TABLE_NAME='ClinicBusinessLocations' AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME='cc_gbp_location_grammar'",
});
const accepts=(text,migration)=>migration===MIGRATION&&String(text).replace(/;$/,'')===SQL;
const normalized=s=>String(s).replace(/_utf8mb4/g,'').replace(/\\'/g,"'").replace(/`/g,'').replace(/\s+/g,'').toLowerCase();
const fail=()=>{throw Error('rds_schema_gbp_generation_index_guard');};
function validate(value,after=false){
 if(!value||!Array.isArray(value.columns)||value.columns.length!==2||!Array.isArray(value.indexes)||!Array.isArray(value.checks)||value.checks.length!==1)fail();
 const expectations={canonical_location_id:"substring_index(location_id,'/',-(1))",active_canonical_location_id:"(casewhen(is_active=1)thensubstring_index(location_id,'/',-(1))elsenullend)"};
 for(const row of value.columns)if(!Object.hasOwn(expectations,row.COLUMN_NAME)||row.COLUMN_TYPE!=='varchar(30)'||row.IS_NULLABLE!=='YES'||row.EXTRA!=='STORED GENERATED'||normalized(row.GENERATION_EXPRESSION)!==expectations[row.COLUMN_NAME])fail();
 const expected=[['cc_gbp_active_canonical',0,'active_canonical_location_id'],['cc_gbp_location_history',1,'canonical_location_id'],...(!after?[['uniq_clinicbusiness_locationid',0,'location_id']]:[])];
 if(value.indexes.length!==expected.length)fail();
 for(let i=0;i<expected.length;i++){const row=value.indexes[i],e=expected[i];if(row.INDEX_NAME!==e[0]||Number(row.NON_UNIQUE)!==e[1]||Number(row.SEQ_IN_INDEX)!==1||row.COLUMN_NAME!==e[2]||row.SUB_PART!==null||row.INDEX_TYPE!=='BTREE')fail();}
 const c=value.checks[0],expression="(regexp_like(location_id,'^(accounts/[1-9][0-9]{0,29}/)?(locations/)?[1-9][0-9]{0,29}$','c')and(is_activein(0,1)))";
 if(c.CONSTRAINT_NAME!=='cc_gbp_location_grammar'||c.ENFORCED!=='YES'||normalized(c.CHECK_CLAUSE)!==expression)fail();
 return true;
}
module.exports={MIGRATION,SQL,sql,accepts,validate};
