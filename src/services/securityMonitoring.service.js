'use strict';
// Extensible operational alerts. Detection never pauses a clinic or a provider.
const db=require('../../models');
const {isGlobalAdmin}=require('../lib/role-helpers');
const DEFINITIONS=Object.freeze([
  {key:'transport_certificates',label:'Certificados de comunicación',description:'Avisar si falla la renovación, se aproxima una caducidad o deja de comprobarse la recepción de WhatsApp.',threshold:1,unit:'incidencias'},
  {key:'whatsapp_template_sends',label:'Muchos envíos de una plantilla',description:'Avisar cuando una plantilla supera este número de envíos aceptados en una hora.',threshold:500,unit:'envíos / hora'},
  {key:'whatsapp_template_creation',label:'Muchas plantillas creadas',description:'Avisar cuando una clínica crea más plantillas de las habituales en una hora.',threshold:30,unit:'plantillas / hora'},
  {key:'ai_requests',label:'Muchas consultas de IA',description:'Avisar cuando una función acumula este número de consultas durante el día UTC.',threshold:2000,unit:'consultas / día'},
  {key:'ai_cost',label:'Consumo diario de IA',description:'Avisar cuando el coste estimado total del día UTC alcanza este importe.',threshold:10,unit:'USD / día'},
  {key:'ai_unpriced',label:'IA con coste pendiente',description:'Avisar si hay consultas cuyo coste no se puede calcular completamente.',threshold:1,unit:'consultas / día'},
]);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status,retryable:false});};
const checkAdmin=id=>{if(!isGlobalAdmin(id))fail('technical_admin_required',403);};
const clean=(v,n)=>String(v??'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,n);
const plain=v=>v?.toJSON?v.toJSON():v;
function rules(value={}){return DEFINITIONS.map(d=>({...d,enabled:value[d.key]?.enabled!==false,threshold:Number(value[d.key]?.threshold??d.threshold)}));}
async function settings(){const [row]=await db.SecurityMonitoringSetting.findOrCreate({where:{scope:'global'},defaults:{scope:'global',rules:{}}});return row;}
function link(type,id,clinicId){
  if(type==='transport_certificate')return '/ajustes?panel=jobs-monitoring&tab=security';
  if(type==='whatsapp_template')return '/marketing/plantillas?templateId='+encodeURIComponent(id)+(clinicId?'&clinicId='+clinicId:'');
  if(type==='clinic')return '/clinicas/'+Number(id);
  return '/ajustes?panel=jobs-monitoring&tab=ai';
}
function decorate(value){const row=plain(value);return {...row,link:link(row.entity_type,row.entity_id,row.clinic_id),can_pause:['whatsapp_template','ai_use_case'].includes(row.entity_type)};}
async function searchTargets(query,userId) {
  checkAdmin(userId);const search=clean(query,80);
  if(search.length<2)return [];
  // LIKE metacharacters are escaped so broad searches remain deliberate.
  const pattern='%'+search.replace(/[\\%_]/g,'\\$&')+'%';
  const [templates]=await db.sequelize.query("SELECT 'whatsapp_template' entity_type,CAST(id AS CHAR) entity_id,COALESCE(display_name,name) label,clinic_id,waba_id FROM WhatsappTemplates WHERE name LIKE :pattern OR display_name LIKE :pattern ORDER BY updatedAt DESC LIMIT 30",{replacements:{pattern}});
  const [uses]=await db.sequelize.query("SELECT DISTINCT 'ai_use_case' entity_type,use_case entity_id,CONCAT('IA · ',use_case) label FROM AiUsageDaily WHERE use_case LIKE :pattern LIMIT 20",{replacements:{pattern}});
  const bindings=require('../lib/whatsappAuthorizedBrokerClient').configuration()?.bindings||[];
  return [...templates.map(row=>({...row,clinic_id:row.clinic_id||bindings.find(b=>b.wabaId===row.waba_id)?.clinicId||null})),...uses].map(decorate);
}
async function overview(userId){
  checkAdmin(userId);const config=await settings();
  const [alerts,measures,changes]=await Promise.all([
    db.SecurityMonitoringAlert.findAll({order:[['created_at','DESC']],limit:100}),
    db.SecurityMonitoringMeasure.findAll({order:[['paused','DESC'],['updated_at','DESC']],limit:100}),
    db.SecurityMonitoringChange.findAll({order:[['created_at','DESC']],limit:100}),
  ]);
  return {rules:rules(config.rules),alerts:alerts.map(decorate),measures:measures.map(decorate),changes:changes.map(plain),checked_at:new Date().toISOString()};
}
async function updateRules(input,userId){
  checkAdmin(userId);if(!Array.isArray(input)||input.length!==DEFINITIONS.length||new Set(input.map(r=>r.key)).size!==DEFINITIONS.length)fail('security_rules_invalid');
  const values={};for(const r of input){if(!DEFINITIONS.some(d=>d.key===r.key)||typeof r.enabled!=='boolean'||!Number.isFinite(r.threshold)||r.threshold<=0||r.threshold>1e9)fail('security_rules_invalid');values[r.key]={enabled:r.enabled,threshold:r.threshold};}
  return db.sequelize.transaction(async transaction=>{
    const config=await settings();await config.update({rules:values,updated_by:Number(userId)},{transaction});
    await db.SecurityMonitoringChange.create({entity_type:'security_rules',entity_id:'global',action:'update',actor_id:Number(userId),detail:values},{transaction});return rules(values);
  });
}
async function target(type,id){
  if(type==='whatsapp_template'){
    if(!/^[1-9][0-9]{0,9}$/.test(String(id)))fail('security_target_invalid');
    const row=await db.WhatsappTemplate.findByPk(id,{attributes:['id','name','display_name','clinic_id','waba_id']});if(!row)fail('security_target_missing',404);
    return {entity_type:type,entity_id:String(row.id),label:row.display_name||row.name,clinic_id:row.clinic_id||require('../lib/whatsappAuthorizedBrokerClient').configuration()?.bindings.find(b=>b.wabaId===row.waba_id)?.clinicId||null};
  }
  if(type==='ai_use_case'&&/^[a-z0-9_:-]{1,80}$/.test(String(id))){
    const used=await db.AiUsageDaily.findOne({where:{useCase:id},attributes:['id']});if(!used)fail('security_target_missing',404);
    return {entity_type:type,entity_id:String(id),label:'IA · '+id,clinic_id:null};
  }
  fail('security_target_invalid');
}
async function setPaused(input,userId){
  checkAdmin(userId);if(typeof input?.paused!=='boolean'||!clean(input.reason,500))fail('security_measure_reason_required');
  const entity=await target(input.entity_type,input.entity_id);
  return db.sequelize.transaction(async transaction=>{
    const [row]=await db.SecurityMonitoringMeasure.findOrCreate({where:{entity_type:entity.entity_type,entity_id:entity.entity_id},defaults:{...entity,paused:false,reason:'Preparado',updated_by:Number(userId)},transaction});
    await row.reload({transaction,lock:transaction.LOCK.UPDATE});
    if(row.paused===input.paused)return decorate(row);
    await row.update({...entity,paused:input.paused,reason:clean(input.reason,500),updated_by:Number(userId)},{transaction});
    await db.SecurityMonitoringChange.create({entity_type:entity.entity_type,entity_id:entity.entity_id,action:input.paused?'pause':'resume',actor_id:Number(userId),detail:{reason:clean(input.reason,500),label:entity.label}},{transaction});
    return decorate(row);
  });
}
async function acknowledge(id,userId){checkAdmin(userId);const row=await db.SecurityMonitoringAlert.findByPk(id);if(!row)fail('security_alert_missing',404);await row.update({status:'reviewed',acknowledged_by:Number(userId),acknowledged_at:new Date()});return decorate(row);}
async function assertAiAllowed(useCase){
  if(await db.SecurityMonitoringMeasure.findOne({where:{entity_type:'ai_use_case',entity_id:useCase,paused:true},attributes:['id']}))fail('ai_function_manually_paused',409);
}
async function assertTemplateAllowed(wabaId,name,language){
  // IDs are canonical decimal strings. Compare their bytes so the connection
  // collation cannot conflict with the newer monitoring table's collation.
  const [rows]=await db.sequelize.query('SELECT m.id FROM SecurityMonitoringMeasures m JOIN WhatsappTemplates t ON BINARY CAST(t.id AS CHAR)=BINARY m.entity_id WHERE m.entity_type=\'whatsapp_template\' AND m.paused=1 AND t.waba_id=:waba AND t.name=:name AND t.language=:language LIMIT 1',{replacements:{waba:String(wabaId),name:String(name),language:String(language)}});
  if(rows.length)fail('whatsapp_template_manually_paused',409);
}
async function candidates(rule,from){
  if(rule.key==='transport_certificates')return require('../lib/transportCertificateHealth').readHealth().filter(c=>c.measured>=rule.threshold);
  const q=(sql,replacements={})=>db.sequelize.query(sql,{replacements}).then(([r])=>r);
  if(rule.key==='whatsapp_template_sends')return q(`SELECT 'whatsapp_template' entity_type,CAST(t.id AS CHAR) entity_id,t.clinic_id,t.waba_id,t.name label,COUNT(*) measured FROM Messages m JOIN WhatsappTemplates t ON t.waba_id=JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.wabaId')) AND t.name=JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) AND t.language=COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_language')),'es') WHERE m.createdAt>=:from AND m.direction='outbound' AND m.message_type='template' AND JSON_EXTRACT(m.metadata,'$.wamid') IS NOT NULL GROUP BY t.id,t.clinic_id,t.waba_id,t.name HAVING COUNT(*)>=:threshold`,{from,threshold:rule.threshold});
  if(rule.key==='whatsapp_template_creation')return q(`SELECT 'clinic' entity_type,CAST(clinic_id AS CHAR) entity_id,clinic_id,CONCAT('Clínica ',clinic_id) label,COUNT(*) measured FROM WhatsappTemplates WHERE createdAt>=:from AND clinic_id IS NOT NULL AND created_by_user_id IS NOT NULL AND origin<>'external' GROUP BY clinic_id HAVING COUNT(*)>=:threshold`,{from,threshold:rule.threshold});
  if(rule.key==='ai_requests')return q(`SELECT 'ai_use_case' entity_type,use_case entity_id,CONCAT('IA · ',use_case) label,SUM(request_count) measured FROM AiUsageDaily WHERE usage_date=UTC_DATE() GROUP BY use_case HAVING SUM(request_count)>=:threshold`,{threshold:rule.threshold});
  const field=rule.key==='ai_cost'?'estimated_cost_usd':'unpriced_requests';
  return q(`SELECT 'ai' entity_type,'global' entity_id,'Inteligencia artificial' label,SUM(${field}) measured FROM AiUsageDaily WHERE usage_date=UTC_DATE() HAVING SUM(${field})>=:threshold`,{threshold:rule.threshold});
}
async function scan(){
  const config=await settings(),from=new Date(Date.now()-3600000),bucket=new Date().toISOString().slice(0,13);const found=[];
  for(const rule of rules(config.rules).filter(r=>r.enabled))for(const c of await candidates(rule,from)){
    const dedupe=[rule.key,c.entity_type,c.entity_id,rule.key==='transport_certificates'?bucket.slice(0,10):bucket].join(':');
    const [row,created]=await db.SecurityMonitoringAlert.findOrCreate({where:{dedupe_key:dedupe},defaults:{dedupe_key:dedupe,rule_key:rule.key,entity_type:c.entity_type,entity_id:c.entity_id,clinic_id:c.clinic_id||(c.waba_id?require('../lib/whatsappAuthorizedBrokerClient').configuration()?.bindings.find(b=>b.wabaId===c.waba_id)?.clinicId:null)||null,title:rule.label,detail:c.detail||`${clean(c.label,180)}: ${Number(c.measured).toFixed(rule.key==='ai_cost'?4:0)} ${rule.unit}. Umbral de aviso: ${rule.threshold}. Revisa si corresponde a una actividad prevista.`,measured_value:Number(c.measured),threshold:rule.threshold,status:'open'}});
    if(created)found.push(decorate(row));
    if(!row.notification_queued_at){await require('./systemNotifications.service').queueNotification({eventKey:'security.activity_detected',payload:{severity:'warning',title:row.title,detail:row.detail,action:'Revisar Ajustes → Monitoreo del sistema → Seguridad.'},metadata:{source:'security_monitoring',alert_id:row.id,link:'/ajustes?panel=jobs-monitoring&tab=security'}});await row.update({notification_queued_at:new Date()});}
  }
  return {alerts:found.length};
}
module.exports={searchTargets,DEFINITIONS,rules,overview,updateRules,setPaused,acknowledge,assertAiAllowed,assertTemplateAllowed,scan,link};
