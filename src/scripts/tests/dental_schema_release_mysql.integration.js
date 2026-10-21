'use strict';
const assert=require('node:assert/strict'),{DataTypes:D,Sequelize}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const operator=require('../dental-schema-release');
withIsolatedCampaignMysql(async({sql,report})=>{
  const q=sql.getQueryInterface();
  for(const table of operator.PARENTS){
    if(table==='SequelizeMeta'){await q.createTable(table,{name:{type:D.STRING,primaryKey:true}});continue;}
    const key=table==='Clinicas'?'id_clinica':table==='Pacientes'?'id_paciente':table==='CitasPacientes'?'id_cita':'id';
    await q.createTable(table,{[key]:{type:table==='EconomicBudgets'?D.BIGINT.UNSIGNED:D.INTEGER,primaryKey:true}});
  }
  for(const name of operator.PREREQUISITES)await sql.query('INSERT INTO SequelizeMeta(name) VALUES(:name)',{replacements:{name}});
  const [[identity]]=await sql.query('SELECT DATABASE() database_name,CURRENT_USER() database_user,@@hostname server_name,@@port server_port');
  const before=await operator.captureMetadata(sql,identity);assert.deepEqual(operator.pending(before),operator.MIGRATIONS);
  await require('../../../migrations/'+operator.MIGRATIONS[0]).up(q,Sequelize);
  await sql.query('INSERT INTO SequelizeMeta(name) VALUES(:name)',{replacements:{name:operator.MIGRATIONS[0]}});
  const partial=await operator.captureMetadata(sql,identity);assert.deepEqual(operator.pending(partial),[operator.MIGRATIONS[1]]);
  await require('../../../migrations/'+operator.MIGRATIONS[1]).up(q,Sequelize);
  const preRegistered=await operator.captureMetadata(sql,identity);operator.verifyAfter(partial,preRegistered,[operator.MIGRATIONS[1]],false);
  await sql.query('INSERT INTO SequelizeMeta(name) VALUES(:name)',{replacements:{name:operator.MIGRATIONS[1]}});
  const after=await operator.captureMetadata(sql,identity);operator.verifyAfter(before,after,operator.MIGRATIONS);assert.deepEqual(operator.pending(after),[]);
  operator.verifySchema(after);assert.equal(after.tables.filter(t=>operator.NEW_TABLES.includes(t.TABLE_NAME)).length,4);
  report.checks.push('Owned socket-only MySQL executes exact two real Dental DDL; capture verifies types/nullability/column set/indexes/FKs, preserves every parent metadata row and migration entry. First-DDL registered state plans only second; full state plans none. No runtime credentials/services or business DML.');
  const altered=JSON.parse(JSON.stringify(after));altered.columns.find(c=>c.TABLE_NAME==='DentalSupportingTools'&&c.COLUMN_NAME==='state').COLUMN_TYPE='longtext';assert.throws(()=>operator.verifyAfter(before,altered,operator.MIGRATIONS),/DENTAL_SCHEMA_COLUMN_TYPE_INVALID/);
  const drift=JSON.parse(JSON.stringify(after));drift.indexes.push({TABLE_NAME:'Pacientes',INDEX_NAME:'unexpected'});assert.throws(()=>operator.verifyAfter(before,drift,operator.MIGRATIONS),/EXISTING_METADATA_CHANGED/);
  report.checks.push('Typed JSON regression and unrelated existing-index drift are rejected after actual DDL.');
}).catch(error=>{console.error(error);process.exitCode=1;});
