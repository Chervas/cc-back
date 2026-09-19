'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {snapshot,compare,digest}=require('../../lib/securitySchemaContract');
const {applyPlan}=require('../security-schema-release');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const source=path.resolve(__dirname,'../../..');
const schema=require('../../../ops/security/schema-contract.json');
const original=require('./fixtures/meta_pre_migration_schema.json');
const names=['MetaConnections','ClinicMetaAssets','MetaMarketingBrokerBindings','MetaMarketingBrokerRevocations',
  'MetaMarketingOAuthSlots','MetaMarketingOAuthRequests','MetaMarketingEnrollmentRequests','MetaMarketingEnrollmentClaims','MetaMarketingEnrollmentIdentities'];
const selected=fs.readdirSync(path.join(source,'migrations')).filter(n=>/^20260919\d{6}-meta-marketing-.*\.js$/.test(n)).sort();
assert.equal(selected.length,9);
const migrations=selected.map(name=>({name,sha256:createHash('sha256').update(fs.readFileSync(path.join(source,'migrations',name))).digest('hex')}));
function extract(actual){
  return {version:1,tables:Object.fromEntries(names.map(name=>{
    const t=actual.tables.find(v=>v.TABLE_NAME===name), indexes=actual.indexes.filter(v=>v.TABLE_NAME===name);
    const omit=({TABLE_NAME,...value})=>value;
    return [name,{ENGINE:t.ENGINE,TABLE_COLLATION:t.TABLE_COLLATION,
      columns:actual.columns.filter(v=>v.TABLE_NAME===name).map(omit),
      indexes:[...new Set(indexes.map(v=>v.INDEX_NAME))].map(name=>({name,columns:indexes.filter(v=>v.INDEX_NAME===name).map(omit)})),
      checks:actual.checks.filter(v=>v.TABLE_NAME===name).map(omit),foreignKeys:actual.foreignKeys.filter(v=>v.TABLE_NAME===name).map(omit)}];
  })),migrations};
}
test('complete Meta migration chain preserves legacy rows, independent history and rejects real schema drift',async()=>{
  await withIsolatedCampaignMysql(async({sql,report})=>{
    const qi=sql.getQueryInterface();
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for(const [table,id] of [['Usuarios','id_usuario'],['Clinicas','id_clinica'],['GruposClinicas','id_grupo']]){
      await sql.query(`CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
    }
    await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    for(const ddl of Object.values(original.ddl))await sql.query(ddl);
    await sql.query("INSERT INTO MetaConnections(id,metaUserId,accessToken,userName,createdAt,updatedAt) VALUES(1,'123','FICTITIOUS_LEGACY_TOKEN','Ficticio ñ',NOW(),NOW())");
    await sql.query("INSERT INTO ClinicMetaAssets(id,metaConnectionId,metaAssetId,assetType,pageAccessToken,waAccessToken,isActive,createdAt,updatedAt) VALUES(1,1,'456','facebook_page','FICTITIOUS_PAGE_TOKEN','FICTITIOUS_WA_TOKEN',0,NOW(),NOW())");
    const beforeRows={};for(const table of names.slice(0,2))beforeRows[table]=(await sql.query('SELECT * FROM '+table))[0];
    const raw=await sql.connectionManager.getConnection(),connection=raw.promise();
    const query=async(q,v=[])=>(await connection.query(q,v))[0];
    const exportFile=process.env.META_SCHEMA_EXPORT;
    if(exportFile)assert(path.isAbsolute(exportFile)&&exportFile.startsWith('/home/ubuntu/qa-evidence/'));
    const contract=exportFile?{version:1,tables:{},migrations}:{version:1,tables:Object.fromEntries(names.map(n=>{assert(schema.tables[n],n);return[n,schema.tables[n]];})),migrations};
    const info={revision:'owned-mysql-meta-fixture',contractDigest:digest(contract),contract,migrations:Object.fromEntries(migrations.map(m=>[m.name,m.sha256]))};
    const journal=[];
    try{
      const before=await snapshot(query),plan={version:1,runtime:'dev',database:'clinicaclick_dev_isolated',revision:info.revision,
        contractDigest:info.contractDigest,beforeDigest:digest(before),migrations};
      const result=await applyPlan({connection,plan,info,loadMigration:m=>require(path.join(source,'migrations',m.name)),journal:e=>journal.push(structuredClone(e))});
      assert.equal(result.compatible,true,JSON.stringify(result));assert.deepEqual(result.completed,selected);
      assert.equal(journal.filter(v=>v.status==='migration_started').length,9);assert.equal(journal.filter(v=>v.status==='migration_completed').length,9);
      const after=await snapshot(query),expected=exportFile?extract(after):contract;
      if(exportFile)fs.writeFileSync(exportFile,JSON.stringify(expected,null,2)+'\n',{flag:'wx',mode:0o600});
      assert.equal(compare(after,expected).compatible,true);
      for(const table of names.slice(0,2)){
        const fields=Object.keys(beforeRows[table][0]).map(k=>'`'+k+'`').join(',');
        assert.deepEqual(await query('SELECT '+fields+' FROM '+table),beforeRows[table]);
        assert.deepEqual(after.foreignKeys.filter(k=>k.TABLE_NAME===table),before.foreignKeys.filter(k=>k.TABLE_NAME===table));
      }
      for(const table of names.slice(2))assert.equal(Number((await query('SELECT COUNT(*) n FROM '+table))[0].n),0);
      report.checks.push('All nine actual DDL modules applied and journaled; original token fields, Unicode, pauses, IDs and foreign keys unchanged; seven new tables empty');
      for(const set of ["credentials_external=1","accessToken=NULL","credentials_external=1,accessToken=NULL,broker_app_id='invalid'"]){
        await assert.rejects(query('UPDATE MetaConnections SET '+set+' WHERE id=1'),e=>e.errno===3819);
      }
      await query("INSERT INTO MetaConnections(id,metaUserId,accessToken,credentials_external,broker_app_id,createdAt,updatedAt) VALUES(2,'789',NULL,1,'123',NOW(),NOW())");
      report.checks.push('Database rejects missing legacy token, mixed storage and invalid app identity; external credential marker accepts a null local token');
      async function insertRequired(table,overrides={}){
        const row={};for(const col of after.columns.filter(c=>c.TABLE_NAME===table&&c.IS_NULLABLE==='NO'&&c.COLUMN_DEFAULT===null&&!c.GENERATION_EXPRESSION)){
          row[col.COLUMN_NAME]=col.COLUMN_TYPE.startsWith('datetime')?new Date('2026-09-19T00:00:00.000Z')
            :col.COLUMN_TYPE.startsWith('int')?1:col.COLUMN_TYPE==='char(36)'?randomUUID():col.COLUMN_TYPE==='char(64)'?'a'.repeat(64)
              :col.COLUMN_TYPE.startsWith('enum(')?col.COLUMN_TYPE.match(/'([^']+)'/)[1]:col.COLUMN_TYPE==='text'?'[]':'1';
        }
        Object.assign(row,overrides);const keys=Object.keys(row);await query('INSERT INTO '+table+' ('+keys.map(k=>'`'+k+'`').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',Object.values(row));return row;
      }
      const request=await insertRequired('MetaMarketingEnrollmentRequests');
      let rows=await query('SELECT delivery_due_at,next_attempt_at FROM MetaMarketingEnrollmentRequests');assert.deepEqual(rows[0].delivery_due_at,rows[0].next_attempt_at);
      await query("UPDATE MetaMarketingEnrollmentRequests SET state='revoked'");rows=await query('SELECT delivery_due_at FROM MetaMarketingEnrollmentRequests');assert.equal(rows[0].delivery_due_at,null);
      await insertRequired('MetaMarketingEnrollmentClaims',{asset_ref:'meta-facebook_page:456',enrollment_id:request.enrollment_id});
      await assert.rejects(insertRequired('MetaMarketingEnrollmentClaims',{asset_ref:'meta-facebook_page:456'}),e=>e.errno===1062);
      await assert.rejects(require('../../../migrations/20260919080000-meta-marketing-enrollment-journal').down(qi),/Preserve Meta enrollment ownership/);
      report.checks.push('Stored due expression excludes revoked requests; physical claim uniqueness and populated rollback guards protect ownership');
      await query('ALTER TABLE MetaMarketingEnrollmentClaims ADD CONSTRAINT qa_unwanted_cascade FOREIGN KEY (enrollment_id) REFERENCES MetaMarketingEnrollmentRequests(enrollment_id) ON DELETE CASCADE');
      assert(compare(await snapshot(query),expected).issues.some(i=>i.table==='MetaMarketingEnrollmentClaims'&&i.reason==='foreign_key_definition'));
      await query('ALTER TABLE MetaMarketingEnrollmentClaims DROP FOREIGN KEY qa_unwanted_cascade');
      await query('ALTER TABLE MetaMarketingEnrollmentRequests MODIFY COLUMN delivery_due_at DATETIME(3) GENERATED ALWAYS AS (next_attempt_at) STORED');
      assert(compare(await snapshot(query),expected).issues.some(i=>i.column==='delivery_due_at'&&i.field==='GENERATION_EXPRESSION'));
      await query("ALTER TABLE MetaMarketingEnrollmentRequests MODIFY COLUMN delivery_due_at DATETIME(3) GENERATED ALWAYS AS (CASE WHEN state='revoked' THEN NULL ELSE next_attempt_at END) STORED");
      await query('ALTER TABLE MetaConnections ALTER CHECK cc_meta_credential_storage NOT ENFORCED');
      assert(compare(await snapshot(query),expected).issues.some(i=>i.constraint==='cc_meta_credential_storage'));
      await query('ALTER TABLE MetaConnections ALTER CHECK cc_meta_credential_storage ENFORCED');
      await query('ALTER TABLE MetaMarketingEnrollmentRequests DROP INDEX cc_meta_enroll_latest');
      assert(compare(await snapshot(query),expected).issues.some(i=>i.index==='cc_meta_enroll_latest'));
      await qi.addIndex('MetaMarketingEnrollmentRequests',['scope_key','requested_at','enrollment_id'],{name:'cc_meta_enroll_latest'});
      assert.equal(compare(await snapshot(query),expected).compatible,true);
      report.checks.push('Metadata preflight rejects actual added cascade, altered generated expression, disabled credential CHECK and missing latest-scope index; restored schema passes');
      report.migrations=selected;report.tables=names;report.legacyRowsPreserved=2;
    }finally{await sql.connectionManager.releaseConnection(raw);}
  });
});
