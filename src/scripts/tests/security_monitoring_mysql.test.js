'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
test('template pauses work across legacy and current MySQL collations without changing their scope',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  await sql.query('CREATE TABLE WhatsappTemplates(id INT PRIMARY KEY,waba_id VARCHAR(80),name VARCHAR(100),language VARCHAR(10)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await sql.query('CREATE TABLE SecurityMonitoringMeasures(id INT PRIMARY KEY,entity_type VARCHAR(80),entity_id VARCHAR(80),paused BOOLEAN) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
  await sql.query("INSERT INTO WhatsappTemplates VALUES (123,'100','synthetic','es'),(124,'200','synthetic','es'),(125,'100','synthetic','en')");
  await sql.query("INSERT INTO SecurityMonitoringMeasures VALUES (1,'whatsapp_template','123',1)");
  const service=require('../../services/securityMonitoring.service');
  for(const collation of ['utf8mb4_unicode_ci','utf8mb4_0900_ai_ci']){
   await sql.transaction(async transaction=>{
    await sql.query('SET NAMES utf8mb4 COLLATE '+collation,{transaction});
    const models=require('../../../models');const original=models.sequelize;
    models.sequelize={query:(query,options)=>sql.query(query,{...options,transaction})};
    try{
     await assert.rejects(service.assertTemplateAllowed('100','synthetic','es'),{code:'whatsapp_template_manually_paused'});
     await service.assertTemplateAllowed('200','synthetic','es');
     await service.assertTemplateAllowed('100','synthetic','en');
     await sql.query("UPDATE SecurityMonitoringMeasures SET paused=0",{transaction});
     await service.assertTemplateAllowed('100','synthetic','es');
     await sql.query("UPDATE SecurityMonitoringMeasures SET paused=1,entity_id='0123'",{transaction});
     await service.assertTemplateAllowed('100','synthetic','es');
     await sql.query("UPDATE SecurityMonitoringMeasures SET entity_id='123x'",{transaction});
     await service.assertTemplateAllowed('100','synthetic','es');
     await sql.query("UPDATE SecurityMonitoringMeasures SET entity_id='123'",{transaction});
    }finally{models.sequelize=original;}
   });
  }
  report.checks.push('both connection collations','exact decimal identifier','WABA and language separation','resume permits future sends');
 });
});
