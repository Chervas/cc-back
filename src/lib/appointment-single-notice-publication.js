'use strict';
const {createHash}=require('node:crypto');
const {scoped,buildSingleNoticeFlow,policyFor}=require('./appointment-single-notice-flow');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const graph=row=>({entry_node_id:row.entry_node_id,trigger_type:row.trigger_type,nodes:row.nodes});
const storedGraphHash=row=>row.stored_graph_hash||hash(graph(row));
const sameFamily=(a,b)=>a.public_id===b.public_id&&a.template_key===b.template_key
  &&Number(a.clinic_id||0)===Number(b.clinic_id||0)&&Number(a.group_id||0)===Number(b.group_id||0);

function planEntry(source){
  if(!scoped(source)||!source.published_at||!Number.isSafeInteger(Number(source.id))||Number(source.id)<=0)throw Error('single_notice_source_invalid');
  if(policyFor(source))return null;
  const next=buildSingleNoticeFlow(source);
  return {source:structuredClone(source),source_hash:hash(graph(source)),graph_hash:hash(graph(next)),
    body:{single_notice_source_id:source.id,name:source.name,description:source.description??null,template_key:source.template_key,clinic_id:source.clinic_id,
      group_id:source.group_id,is_system:source.is_system===true,is_active:false,engine_version:'v2',...next}};
}

function preservedNodes(source,candidate){
  const plan=planEntry(source);
  if(!plan||candidate.template_key!==source.template_key||Number(candidate.clinic_id||0)!==Number(source.clinic_id||0)
    ||Number(candidate.group_id||0)!==Number(source.group_id||0)||!!candidate.is_system!==!!source.is_system
    ||candidate.name!==source.name||(candidate.description??null)!==(source.description??null)||hash(graph(candidate))!==plan.graph_hash){
    throw Object.assign(Error('single_notice_candidate_changed'),{code:'single_notice_candidate_changed',statusCode:409});
  }
  return structuredClone(plan.body.nodes);
}

async function validatePreservedNodeConfigs(source,nodes,validate){
  const plan=planEntry(source);
  if(!plan||hash(nodes)!==hash(plan.body.nodes))throw Object.assign(Error('single_notice_candidate_changed'),{
    code:'single_notice_candidate_changed',statusCode:409,
  });
  const result=await validate(nodes);
  if(!result.errors?.length)return result;
  const baseline=await validate(source.nodes);
  const previousErrors=new Set((baseline.errors||[]).map(hash));
  const originalNodes=new Map(source.nodes.map(node=>[node.id,node]));
  const candidateNodes=new Map(nodes.map(node=>[node.id,node]));
  let inherited=0;
  const errors=result.errors.filter(error=>{
    const node=candidateNodes.get(error.details?.node_id),original=originalNodes.get(node?.id);
    if(error.code!=='node_config_required'||!node||!original||hash(node)!==hash(original)
      ||!previousErrors.has(hash(error)))return true;
    // Immutable published nodes may predate generic schema defaults. Their
    // mode-specific and template-contract validations must still pass normally.
    const key=error.details?.key;
    const compatible=node.type==='action/send_whatsapp'&&key==='communication_scope'
      ||node.type==='condition/field_check'&&['multi_branch','appointment_booking_timing','lead_contact_state'].includes(node.config?.mode)
        &&['left_ref','operator'].includes(key)
      ||node.type==='action/send_system_notification'&&['display_mode','alert_level'].includes(key);
    if(!compatible)return true;
    inherited++;return false;
  });
  return {...result,ok:errors.length===0,errors,inherited_required_errors:inherited};
}

// Uses only the native draft/version/publish API. The caller supplies its own
// authenticated transport; this module has no DB, provider or startup side effects.
async function publishEntry(entry,request){
  const source=entry.source,ref=encodeURIComponent(source.public_id),base=`/api/automations/v2/templates/${ref}`;
  if(!scoped(source)||entry.source_hash!==hash(graph(source))||entry.graph_hash!==hash(graph(entry.body)))throw Error('single_notice_plan_changed');
  const expected=planEntry(source);
  if(!expected||hash(entry.body)!==hash(expected.body))throw Error('single_notice_plan_changed');
  const result=await request('GET',`${base}/versions?include_nodes=1&limit=200`);
  if(Number(result.pagination?.total||0)>(result.data||[]).length)throw Error('single_notice_versions_truncated');
  const versions=(result.data||[]).filter(row=>sameFamily(row,source));
  const latest=versions.filter(row=>row.published_at).sort((a,b)=>Number(b.version)-Number(a.version))[0];
  if(!latest||!sameFamily(latest,source))throw Error('single_notice_family_changed');
  if(policyFor(latest)&&storedGraphHash(latest)===entry.graph_hash)return {skipped:true,version:latest.version};
  if(Number(latest.version)!==Number(source.version)||storedGraphHash(latest)!==entry.source_hash||!!latest.is_active!==!!source.is_active)throw Error('single_notice_source_changed');
  const drafts=versions.filter(row=>!row.published_at);
  if(drafts.length>1||drafts.length&&storedGraphHash(drafts[0])!==entry.graph_hash)throw Error('single_notice_draft_requires_review');
  const draft=drafts[0]||(await request('POST','/api/automations/v2/templates',entry.body)).data;
  if(!draft||!sameFamily(draft,source)||Number(draft.version)<=Number(source.version)||draft.is_active)throw Error('single_notice_draft_identity_changed');
  // Native normalizers must not silently upgrade prompts or any other node.
  // A mismatch leaves an inactive draft for review, never an active release.
  if(storedGraphHash(draft)!==entry.graph_hash)throw Error('single_notice_normalization_requires_review');
  const published=(await request('POST',`${base}/versions/${draft.version}/publish`,{
    preserve_activation:true,expected_published_version:source.version,single_notice_source_id:source.id,
  })).data;
  if(!sameFamily(published,source)||storedGraphHash(published)!==entry.graph_hash||!!published.is_active!==!!source.is_active)throw Error('single_notice_publication_requires_review');
  return {skipped:false,version:published.version,is_active:published.is_active};
}
module.exports={hash,planEntry,publishEntry,preservedNodes,validatePreservedNodeConfigs};
