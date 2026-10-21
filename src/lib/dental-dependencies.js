'use strict';
const D=require('./dental-plan-contract'),{addDays}=require('./personal-schedule-recurring');
const {civilLocal}=require('./program-reschedule');
function latestResults(state){const latest=new Map();for(const e of state.execution)latest.set(e.act_id+':'+e.target_id,e);return latest;}
function dependencyIssues(state,{actIds,startAt,timeZone,execution=false,selectedTogether=[]}){
 const latest=latestResults(state),issues=[];
 for(const dep of state.dependencies.filter(d=>actIds.includes(d.to_act_id))){
  const origin=state.acts.find(a=>a.id===dep.from_act_id);if(origin?.status==='cancelled'){issues.push({...dep,reason:'source_cancelled'});continue;}
  const completed=origin?.targets.map(t=>latest.get(origin.id+':'+t.id));
  let dates=completed?.length&&completed.every(e=>e?.status==='performed')?completed.map(e=>e.recorded_at):[];
  if(!dates.length&&!execution)dates=state.reservations.filter(r=>r.active!==false&&r.act_ids.includes(dep.from_act_id)).map(r=>r.end_at);
  if(!dates.length&&!execution&&selectedTogether.includes(dep.from_act_id)&&(dep.wait_min_value??dep.min_wait_days)===0)continue;
  if(!dates.length){issues.push({...dep,reason:execution?'source_not_performed':'source_not_scheduled'});continue;}
  const last=new Date(Math.max(...dates.map(d=>+new Date(d)))),start=new Date(startAt);
  const notBefore=require('./dental-civil-wait').dateForDependency(civilLocal(last,timeZone).slice(0,10),dep);
  if(start<last||civilLocal(start,timeZone).slice(0,10)<notBefore)issues.push({...dep,reason:'clinical_wait',not_before:notBefore});
 }
 return issues;
}
function assertDependencies(issues,reason){const blocking=issues.filter(i=>i.action!=='warn');if(blocking.some(i=>i.action==='block')||blocking.length&&!D.text(reason))D.fail('dependencies_pending','Hay dependencias o esperas clínicas pendientes. Revisa el plan.',409,{issues,can_override:!blocking.some(i=>i.action==='block')});}
function assertToolsReady(tools,sessionId,actIds,requirements=[]){
 const orders=(tools?.lab_orders||[]).filter(o=>o.needed_session_id?o.needed_session_id===sessionId:(o.act_ids||[]).some(id=>actIds.includes(id)));
 const evidence=(tools?.evidences||[]).filter(e=>e.required===true&&((e.session_ids||[]).includes(sessionId)||(e.act_ids||[]).some(id=>actIds.includes(id))));
 if(orders.some(o=>o.status!=='approved')||evidence.some(e=>e.clinical_status!=='approved'||e.status==='archived'))D.fail('materials_pending','Revisa y valida las pruebas o el laboratorio necesarios para esta sesión.',409,{laboratory_ids:orders.filter(o=>o.status!=='approved').map(o=>o.id),evidence_ids:evidence.filter(e=>e.clinical_status!=='approved'||e.status==='archived').map(e=>e.id)});
 for(const r of requirements.filter(r=>r.action!=='warn'&&r.act_ids.some(id=>actIds.includes(id)))){
  for(const actId of r.act_ids.filter(id=>actIds.includes(id))){
   if(r.source_type==='laboratory'&&!orders.some(o=>o.status==='approved'&&(o.needed_session_id===sessionId||!o.needed_session_id&&(o.act_ids||[]).includes(actId))))D.fail('laboratory_required','El protocolo necesita un pedido de laboratorio validado para cada trabajo de esta sesión.',409,{rule:r.code,act_id:actId});
   if(r.source_type==='test'&&!(tools?.evidences||[]).some(e=>e.status!=='archived'&&e.kind===r.source_ref&&e.clinical_status==='approved'&&((e.session_ids||[]).includes(sessionId)||(e.act_ids||[]).includes(actId))))D.fail('evidence_required','El protocolo necesita una prueba aportada y validada para cada trabajo.',409,{rule:r.code,kind:r.source_ref,act_id:actId});
  }
 }
}
module.exports={latestResults,dependencyIssues,assertDependencies,assertToolsReady};
