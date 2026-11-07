'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const S=require('sequelize'),N=require('../../lib/securitySchemaContract'),P=require('../../lib/rdsSchemaMigrationPolicy');
const F=require('../../lib/metaMarketingCredentialSchema'),G=require('../../lib/delegatedSchemaPreflight');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const source=path.resolve(__dirname,'../../..');
function selected(actual){
  const omit=({TABLE_NAME,...value})=>value;
  return {version:1,tables:Object.fromEntries(F.TABLES.map(name=>{
    const table=actual.tables.find(row=>row.TABLE_NAME===name),indexes=actual.indexes.filter(row=>row.TABLE_NAME===name);
    return [name,{ENGINE:table.ENGINE,TABLE_COLLATION:table.TABLE_COLLATION,columns:actual.columns.filter(row=>row.TABLE_NAME===name).map(omit),
      indexes:[...new Set(indexes.map(row=>row.INDEX_NAME))].map(index=>({name:index,columns:indexes.filter(row=>row.INDEX_NAME===index).map(omit)})),
      checks:actual.checks.filter(row=>row.TABLE_NAME===name).map(omit),foreignKeys:actual.foreignKeys.filter(row=>row.TABLE_NAME===name).map(omit)}];
  })),migrations:[{name:F.MIGRATION,sha256:P.sha(fs.readFileSync(path.join(source,'migrations',F.MIGRATION)))}]};
}
test('renewal schema requires both version tables with admission disabled and grants no global-admin-only authority',()=>{
  const schema=require('../../../ops/security/schema-contract.json'),effective=N.effectiveContract(schema,{META_MARKETING_CREDENTIAL_RENEWAL_ENABLED:'false'});
  for(const name of F.TABLES)assert(effective.tables[name],name);
  assert(effective.migrations.some(row=>row.name===F.MIGRATION));
  const selection=require('../../lib/metaClinicalSchemaRelease').continuitySelection({contract:schema,migrations:Object.fromEntries(schema.migrations.map(row=>[row.name,row.sha256]))});
  assert.equal(selection.tables.length,5);assert.equal(selection.migrations.length,2);
  assert.deepEqual(require('../../lib/role-helpers').MARKETING_WRITE_ROLES,['propietario','agencia']);
  for(const name of F.TABLES){
    assert.deepEqual(G.privileges([{'grant':'GRANT SELECT, INSERT, UPDATE ON `fixture`.`'+name+'` TO private'}],'fixture',name),G.REQUIRED);
    assert.deepEqual(G.privileges([{'grant':'GRANT SELECT ON `fixture`.`'+name+'` TO private'}],'fixture',name),['SELECT']);
    assert.deepEqual(G.privileges([{'grant':'GRANT ALL PRIVILEGES ON `other`.* TO private'}],'fixture',name),[]);
  }
});
test('native metadata and restricted RDS loader prove both complete tables, LONGTEXT and independent journals',async()=>{
  await withIsolatedCampaignMysql(async({sql,report})=>{
    const query=async(statement,values=[])=>(await sql.query(statement,{replacements:values}))[0];
    await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    const pins=P.migrationFiles(source,[F.MIGRATION]);
    assert.deepEqual(pins.map(row=>row.path).sort(),['migrations/'+F.MIGRATION,'src/lib/metaMarketingCredentialSchema.js'].sort());
    const {migration,facade}=P.loadMigration(source,F.MIGRATION,pins,S);
    await migration.up(sql.getQueryInterface(),facade);
    await query('INSERT INTO SequelizeMeta (name) VALUES (?)',[F.MIGRATION]);
    const actual=await N.snapshot(query),metadata=selected(actual),exportFile=process.env.META_CREDENTIAL_SCHEMA_EXPORT;
    if(exportFile){assert(path.isAbsolute(exportFile)&&exportFile.startsWith('/home/ubuntu/qa-evidence/'));fs.writeFileSync(exportFile,JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});}
    const contract=exportFile?metadata:require('../../../ops/security/schema-contract.json');
    const expected={tables:Object.fromEntries(F.TABLES.map(name=>[name,contract.tables[name]])),migrations:metadata.migrations};
    assert.equal(N.compare(actual,expected).compatible,true);
    const missing=structuredClone(actual);missing.tables=missing.tables.filter(row=>row.TABLE_NAME!==F.TABLES[1]);
    assert(N.compare(missing,expected).issues.some(row=>row.table===F.TABLES[1]&&row.reason==='missing_table'));
    await sql.query('ALTER TABLE MetaMarketingEffectiveCredentials MODIFY candidate_metadata TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
    assert(N.compare(await N.snapshot(query),expected).issues.some(row=>row.table===F.TABLES[1]&&row.column==='candidate_metadata'&&row.field==='COLUMN_TYPE'));
    await sql.query('ALTER TABLE MetaMarketingEffectiveCredentials MODIFY candidate_metadata LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
    await sql.query('ALTER TABLE MetaMarketingCredentialRenewals DROP INDEX cc_meta_renewal_pending');
    assert(N.compare(await N.snapshot(query),expected).issues.some(row=>row.index==='cc_meta_renewal_pending'));
    await sql.getQueryInterface().addIndex(F.TABLES[0],['pending_enrollment_id'],{name:'cc_meta_renewal_pending',unique:true});
    assert.equal(N.compare(await N.snapshot(query),expected).compatible,true);
    await assert.rejects(migration.down(),/history_must_be_preserved/);
    report.checks.push('Restricted RDS migration loader pins only the migration and pure field helper; real MySQL metadata matches both complete ASCII tables, all columns/indexes and empty foreign-key sets');
    report.checks.push('A present migration journal cannot hide a missing effective pointer table; narrowed TEXT metadata and a missing one-pending unique index fail exact preflight');
    report.tables=F.TABLES;report.migrations=[F.MIGRATION];report.providerRequests=0;
  });
});
