'use strict';
const crypto=require('node:crypto');
const QUALITY_REASONS=new Set(['opt_out_rate_high','early_warmup_opt_out']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
function binding(list,dispatch={}) {
 const s=object(dispatch.sender_snapshot),t=object(dispatch.template_snapshot),a=object(dispatch.account_quality);
 return crypto.createHash('sha256').update(JSON.stringify([Number(list.id),list.clinica_id||null,list.grupo_clinica_id||null,
  [...(list.clinic_ids||[])].map(Number).sort((x,y)=>x-y),dispatch.started_at||null,
  dispatch.whatsapp_template_id||t.id||null,t.name||null,t.language||null,s.asset_id||s.assetId||null,
  s.phone_number_id||s.phoneNumberId||a.phone_number_id||null,dispatch.sender_phone_number||null])).digest('hex');
}
function approval(list,dispatch,actorId,now=new Date()) {
 if(!QUALITY_REASONS.has(String(dispatch.paused_reason||'')))return null;
 const snapshot=object(dispatch.quality_snapshot),sent=Number(snapshot.sent),rate=Number(snapshot.opt_out_rate);
 if(!Number.isSafeInteger(sent)||sent<1||!Number.isFinite(rate)||rate<0||rate>1)return null;
 return {version:1,binding:binding(list,dispatch),baseline_sent:sent,baseline_opt_out:Math.round(sent*rate),
  authorized_by:Number(actorId),authorized_at:now.toISOString()};
}
function evaluate({list,dispatch={},sent,optOut,batchSize,maxOptOutRate}) {
 const a=object(dispatch.quality_exception),valid=a.version===1&&a.binding===binding(list,dispatch)
  &&Number.isSafeInteger(a.authorized_by)&&a.authorized_by>0&&Number.isFinite(Date.parse(a.authorized_at))
  &&Number.isSafeInteger(a.baseline_sent)&&a.baseline_sent>=1&&a.baseline_sent<=sent
  &&Number.isSafeInteger(a.baseline_opt_out)&&a.baseline_opt_out>=0&&a.baseline_opt_out<=optOut;
 const observedSent=valid?sent-a.baseline_sent:sent,observedOptOut=valid?optOut-a.baseline_opt_out:optOut;
 const rate=observedSent>0?observedOptOut/observedSent:observedOptOut>0?1:0;
 const early=(observedSent>0||valid)&&observedSent<=5&&observedOptOut>0;
 const breached=observedSent>=batchSize&&rate>maxOptOutRate;
 return {paused:early||breached,reason:early?'early_warmup_opt_out':breached?'opt_out_rate_high':null,
  exception_applied:valid,observed_sent:observedSent,observed_opt_out:observedOptOut,opt_out_rate:rate};
}
module.exports={binding,approval,evaluate,QUALITY_REASONS};
