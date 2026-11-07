'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),S=require('sequelize');
const N=require('../../lib/securitySchemaContract'),P=require('../../lib/rdsSchemaMigrationPolicy'),F=require('../../lib/metaMarketingBusinessSchema'),R=require('../../lib/metaMarketingCredentialSchema');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture'),source=path.resolve(__dirname,'../../..');
test('the actual RDS loader proves all five continuity tables and append-only superseded semantics',async()=>{
  await withIsolatedCampaignMysql(async({sql,report})=>{
    const query=async(statement,values=[])=>(await sql.query(statement,{replacements:values}))[0];
    await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await sql.query("CREATE TABLE MetaMarketingEnrollmentRequests (enrollment_id CHAR(36) NOT NULL PRIMARY KEY,state ENUM('prepare_pending','prepared','activate_pending','active','revoke_pending','revoked') NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin");
    const migrations=[R.MIGRATION,F.MIGRATION],tables=[...R.TABLES,...F.TABLES];
    for(const name of migrations){const pins=P.migrationFiles(source,[name]),{migration,facade}=P.loadMigration(source,name,pins,S);await migration.up(sql.getQueryInterface(),facade);await query('INSERT INTO SequelizeMeta(name) VALUES (?)',[name]);await assert.rejects(migration.down(),/history_must_be_preserved/);}
    const actual=await N.snapshot(query),omit=({TABLE_NAME,...row})=>row;
    const metadata={version:1,tables:Object.fromEntries(tables.map(name=>{const table=actual.tables.find(row=>row.TABLE_NAME===name),indexes=actual.indexes.filter(row=>row.TABLE_NAME===name);return[name,{ENGINE:table.ENGINE,TABLE_COLLATION:table.TABLE_COLLATION,columns:actual.columns.filter(row=>row.TABLE_NAME===name).map(omit),indexes:[...new Set(indexes.map(row=>row.INDEX_NAME))].map(index=>({name:index,columns:indexes.filter(row=>row.INDEX_NAME===index).map(omit)})),checks:actual.checks.filter(row=>row.TABLE_NAME===name).map(omit),foreignKeys:actual.foreignKeys.filter(row=>row.TABLE_NAME===name).map(omit)}];})),
      migrations:migrations.map(name=>({name,sha256:P.sha(fs.readFileSync(path.join(source,'migrations',name)))})),enrollmentState:omit(actual.columns.find(row=>row.TABLE_NAME==='MetaMarketingEnrollmentRequests'&&row.COLUMN_NAME==='state'))};
    const exportFile=process.env.META_BUSINESS_SCHEMA_EXPORT;if(exportFile){assert(path.isAbsolute(exportFile)&&exportFile.startsWith('/home/ubuntu/qa-evidence/'));fs.writeFileSync(exportFile,JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});}
    const schema=exportFile?metadata:require('../../../ops/security/schema-contract.json'),expected={tables:Object.fromEntries(tables.map(name=>[name,schema.tables[name]])),migrations:metadata.migrations};
    expected.tables.MetaMarketingEnrollmentRequests={columns:[exportFile?metadata.enrollmentState:schema.tables.MetaMarketingEnrollmentRequests.columns.find(row=>row.COLUMN_NAME==='state')],indexes:[]};
    assert.equal(N.compare(actual,expected).compatible,true);
    const missing=structuredClone(actual);missing.tables=missing.tables.filter(row=>row.TABLE_NAME!=='MetaMarketingBusinessDrains');assert(N.compare(missing,expected).issues.some(row=>row.table==='MetaMarketingBusinessDrains'&&row.reason==='missing_table'));
    const narrowed=structuredClone(actual);narrowed.columns.find(row=>row.TABLE_NAME==='MetaMarketingCredentialMaintenances'&&row.COLUMN_NAME==='health_metadata').COLUMN_TYPE='text';assert(N.compare(narrowed,expected).issues.some(row=>row.column==='health_metadata'&&row.field==='COLUMN_TYPE'));
    const removed=structuredClone(actual);removed.indexes=removed.indexes.filter(row=>row.INDEX_NAME!=='cc_meta_business_drain_active');assert(N.compare(removed,expected).issues.some(row=>row.index==='cc_meta_business_drain_active'));
    report.checks.push('Both actual pinned migrations load without application models and create all five complete ASCII tables, LONGTEXT metadata, independent histories and one-current-request/drain uniqueness');
    report.checks.push('Existing enrollment states remain ordered and append superseded only; journal-only success cannot hide a missing drain table, truncated health metadata or absent active-drain unique index');report.tables=tables;report.migrations=migrations;
  });
});
