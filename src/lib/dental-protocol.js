'use strict';
const D=require('./dental-plan-contract'),C=require('./clinical-episode-contract');
const config=act=>typeof act.catalog_snapshot?.clinical_config==='string'?JSON.parse(act.catalog_snapshot.clinical_config):act.catalog_snapshot?.clinical_config||{};
function matches(act,ref){return ref!=null&&[String(act.treatment_id),act.catalog_snapshot?.code,...(Array.isArray(config(act).protocol_tags)?config(act).protocol_tags:[])].includes(String(ref));}
function overlapping(a,b){const first=a.targets.filter(t=>t.kind==='tooth').map(t=>t.fdi),second=b.targets.filter(t=>t.kind==='tooth').map(t=>t.fdi);return!first.length||!second.length||first.some(fdi=>second.includes(fdi));}
function deriveProtocol(state,catalogRules=[]){
 const previous=state.dependencies||[],manual=previous.filter(d=>d.source==='manual'),derived=[],requirements=[],warnings=[];
 for(const r of catalogRules)for(const from of state.acts.filter(a=>a.status!=='cancelled'&&a.treatment_id===Number(r.id_tratamiento_origen)))for(const to of state.acts.filter(a=>a.status!=='cancelled'&&a.treatment_id===Number(r.id_tratamiento_destino)))if(overlapping(from,to))derived.push({from_act_id:from.id,to_act_id:to.id,min_wait_days:Number(r.dias_espera)||0,action:r.tipo==='recomendada'?'warn':'override',source:`catalog:${r.id}`,notes:r.notas||null});
 for(const rule of(state.protocol_snapshot?.protocol_rules||[]).filter(r=>r.enabled)){
  const to=state.acts.filter(a=>a.status!=='cancelled'&&matches(a,rule.target_ref)),from=state.acts.filter(a=>a.status!=='cancelled'&&matches(a,rule.source_ref));
  const action=rule.action==='suggest'?'warn':rule.action==='allow_override_with_reason'?'override':'block',origin=`protocol:${rule.code}`;
  if(rule.source_type==='treatment'&&to.length&&from.length){
   for(const source of from)for(const target of to)if(overlapping(source,target))derived.push({from_act_id:source.id,to_act_id:target.id,min_wait_days:rule.wait_min_unit==='months'?0:rule.wait_min_value*(rule.wait_min_unit==='weeks'?7:1),wait_min_value:rule.wait_min_value,wait_min_unit:rule.wait_min_unit,action,source:origin,notes:rule.condition||rule.description});
  }else if(to.length&&((rule.source_type==='laboratory'&&['lab_work_received','lab_work_approved'].includes(rule.source_ref))||(rule.source_type==='document'&&['surgical_consent_signed','clinical_consent_signed'].includes(rule.source_ref))||(rule.source_type==='test'&&['rx','photo','pdf','stl','physical'].includes(rule.source_ref)))){
   requirements.push({code:rule.code,source_type:rule.source_type,source_ref:rule.source_ref,act_ids:to.map(a=>a.id),action,condition:rule.condition||rule.description});
  }else warnings.push({code:rule.code,title:rule.title,condition:rule.condition||rule.description,reason:!to.length?'target_reference_unresolved':rule.source_type==='treatment'&&!from.length?'source_reference_unresolved':'condition_requires_review',source:origin,rule_sha256:C.hash(rule),severity:'review'});
 }
 for(const r of derived){const found=previous.find(d=>d.from_act_id===r.from_act_id&&d.to_act_id===r.to_act_id&&d.source===r.source);if(found)r.id=found.id;}
 const normalized=D.dependencies([...manual,...derived],state.acts);
 for(const d of derived){const n=normalized.find(x=>x.from_act_id===d.from_act_id&&x.to_act_id===d.to_act_id&&x.source===d.source);if(d.wait_min_value!==undefined){n.wait_min_value=d.wait_min_value;n.wait_min_unit=d.wait_min_unit;}}
 const started=state.reservations?.filter(r=>r.active!==false).flatMap(r=>r.act_ids)||[];
 if(normalized.some(d=>started.includes(d.to_act_id)&&!previous.some(p=>p.from_act_id===d.from_act_id&&p.to_act_id===d.to_act_id&&p.source===d.source)))D.fail('change_replan_required','El cambio añade una dependencia a trabajo ya reservado. Revisa su replanificación antes de incorporar el acto.',409);
 return{dependencies:normalized,protocol_requirements:requirements,protocol_warnings:warnings};
}
function validateReview(state,payload){
 const warnings=state.protocol_warnings||[];if(!warnings.length)return;
 const acknowledged=payload.protocol_acknowledgements;if(!Array.isArray(acknowledged)||warnings.some(w=>!acknowledged.includes(w.code)))D.fail('protocol_review_required','Hay reglas cuya correspondencia o condición requiere revisión profesional. Confirma los avisos antes de validar la sesión.',409,{warnings});
}
module.exports={matches,overlapping,deriveProtocol,validateReview};
