'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const original=require('./google_pre_migration_schema.json');
const schema=require('../../../../ops/security/schema-contract.json');
const {digest}=require('../../../lib/securitySchemaContract');
const migration=require('../../../lib/googleClinicalSchemaRelease');
const source=path.resolve(__dirname,'../../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');

async function setup(sql){
 await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
 for(const [table,id,ids] of [['Usuarios','id_usuario',[1,2]],['Clinicas','id_clinica',[11,12]],['GruposClinicas','id_grupo',[7]],['IntakeConfigs','id',[13]]]){
  await sql.query('CREATE TABLE '+table+' ('+id+' INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
  for(const value of ids)await sql.query('INSERT INTO '+table+' VALUES (?)',{replacements:[value]});
 }
 await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
 for(const ddl of Object.values(original.ddl))await sql.query(ddl);
 const raw=await sql.connectionManager.getConnection(),connection=raw.promise();
 const query=async(s,v=[])=>(await connection.query(s,v))[0];
 const insert=async(table,row)=>{const keys=Object.keys(row);await query('INSERT INTO '+table+' ('+keys.map(k=>'`'+k+'`').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',Object.values(row));};
 for(const name of migration.HISTORICAL_MIGRATIONS)await insert('SequelizeMeta',{name});
 for(const [id,user] of [[101,1],[102,2]])await insert('GoogleConnections',{id,userId:user,googleUserId:'fictitious-shared-identity',accessToken:'FICTITIOUS_TOKEN_'+id,refreshToken:'FICTITIOUS_REFRESH_'+id,userName:'Clínica ficticia ñ',scopes:'fictitious-scope'});
 for(const [id,scope,status] of [[1,'clinic:11','active'],[2,'group:7','active'],[3,'clinic:12','disconnected']])await insert('GoogleConnectionAssignments',{id,scopeKey:scope,assignmentScope:id===2?'group':'clinic',clinicaId:id===2?null:id===1?11:12,grupoClinicaId:id===2?7:null,googleConnectionId:101,status,authorizedByUserId:1});
 for(const id of [1,2]){
  await insert('ClinicBusinessLocations',{id,clinica_id:10+id,google_connection_id:101,location_id:String(id),is_active:id===1,raw_payload:JSON.stringify({paused:id===2,unicode:'ñ',nullable:null})});
  await insert('ClinicWebAssets',{id,clinicaId:10+id,googleConnectionId:101,siteUrl:'https://fictitious-'+id+'.invalid/',isActive:id===1});
  await insert('ClinicAnalyticsProperties',{id,clinicaId:10+id,googleConnectionId:101,propertyName:'properties/'+id,isActive:id===1});
  await insert('ClinicGoogleAdsAccounts',{id,clinicaId:10+id,googleConnectionId:101,customerId:'123456789'+id,isActive:id===1,assignmentScope:'group',grupoClinicaId:7});
  await insert('GroupAssetClinicAssignments',{id,grupoClinicaId:7,assetType:'google_ads_account',assetId:1,clinicaId:10+id});
 }
 await insert('GroupAssetClinicAssignments',{id:3,grupoClinicaId:7,assetType:'meta_ad_account',assetId:1,clinicaId:11});
 for(const [i,status] of ['pending','accepted','succeeded','partial_success','failed','skipped'].entries())await insert('GoogleAdsConversionUploadAttempts',{
  dedupe_key:sha('fictitious-'+i),assignment_scope:'group',grupo_clinica_id:7,clinica_id:11,intake_config_id:13,google_connection_id:101,google_connection_assignment_id:2,
  event_name:'fictitious_event',status,consent_status:i?'UNSPECIFIED':'DENIED',history:JSON.stringify([{source:'fictitious',unknown:null,unicode:'ñ'}]),
 });
 const names=[...migration.HISTORICAL_MIGRATIONS,...migration.MIGRATIONS],selected=names.map(name=>({name,sha256:sha(fs.readFileSync(path.join(source,'migrations',name)))}));
 const expectedTables=[...migration.TABLES.filter(n=>schema.tables[n]),...migration.NEW_TABLES];assert.equal(expectedTables.length,22);
 const contract={version:1,defaults:schema.defaults,tables:Object.fromEntries(expectedTables.map(n=>[n,schema.tables[n]])),migrations:selected};
 return {raw,connection,query,info:{revision:'owned-google-clinical-fixture',contractDigest:digest(contract),contract,migrations:Object.fromEntries(selected.map(m=>[m.name,m.sha256]))},database:'campaign_optimization_qa'};
}

module.exports={setup};
