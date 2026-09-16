'use strict';
// Fixed operations on the WABA selected during enrollment. No arbitrary Graph
// path, token, permissions or business-management operation is accepted.
const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');
const LIST = 'meta.whatsapp.authorized.templates.list.v1';
const CREATE = 'meta.whatsapp.authorized.templates.create.v1';
const REMOVE = 'meta.whatsapp.authorized.templates.delete.v1';
const HEADER = 'meta.whatsapp.authorized.templates.header.v1';
const OPERATIONS = [LIST, CREATE, REMOVE, HEADER];
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
function validate(operation, payload) {
  const extra = operation === LIST ? [] : operation === CREATE ? ['template'] : operation === HEADER ? ['source'] : ['name','templateId'];
  if (!OPERATIONS.includes(operation) || !C.keys(payload, ['authorizationId','phoneId','wabaId',...extra], operation === LIST ? ['after'] : [])
    || !E.uuid(payload.authorizationId) || !E.id(payload.phoneId) || !E.id(payload.wabaId)) fail('invalid_request');
  if (operation === LIST && payload.after !== undefined && !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(payload.after)) fail('invalid_request');
  if (operation === REMOVE && (!E.id(payload.templateId) || !/^[a-z0-9_]{1,512}$/.test(payload.name))) fail('invalid_request');
  if (operation === HEADER) {
    require('./whatsapp-template-media').sourceUrl(payload.source);
  }
  if (operation === CREATE) {
    const t = payload.template;
    if (!C.keys(t, ['name','language','category','components']) || !/^[a-z0-9_]{1,512}$/.test(t.name)
      || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(t.language) || !['UTILITY','MARKETING','AUTHENTICATION'].includes(t.category)
      || !Array.isArray(t.components) || !t.components.length || t.components.length > 10
      || Buffer.byteLength(JSON.stringify(t)) > 24576) fail('invalid_request');
    // Components are Meta's template-definition data, never an HTTP envelope.
    for (const c of t.components) if (!c || !['HEADER','BODY','FOOTER','BUTTONS','CAROUSEL','LIMITED_TIME_OFFER'].includes(c.type)) fail('invalid_request');
  }
  return payload;
}
function project(operation, raw) {
  if (!raw || raw.error) fail('provider_failed');
  if (operation === HEADER) { if(!text(raw.handle,8192))fail('provider_failed');return {handle:raw.handle}; }
  if (operation === CREATE) {
    if (!E.id(raw.id)) fail('provider_failed');
    return { id: raw.id, ...(text(raw.status,64)?{status:raw.status}:{}), ...(text(raw.category,64)?{category:raw.category}:{}) };
  }
  if (operation === REMOVE) { if (raw.success !== true) fail('provider_failed'); return {success:true}; }
  if (!Array.isArray(raw.data) || raw.data.length > 100) fail('provider_failed');
  const data = raw.data.map(row => {
    if (!E.id(row?.id) || !text(row.name,512) || !text(row.language,32)) fail('provider_failed');
    return Object.fromEntries(['id','name','language','category','status','components','rejected_reason','quality_score'].filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
  });
  const after = raw.paging?.next ? raw.paging?.cursors?.after : null;
  if (after !== null && !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(after)) fail('provider_failed');
  return {data,after}; // Never return paging.next: Graph may embed a credential.
}
function operations({http,secrets,registry,media=require('./whatsapp-template-media').createTemplateMedia()}) {
  return Object.fromEntries(OPERATIONS.map(operation => [operation,Object.freeze({
    provider:C.PROVIDER,effect:operation===LIST?'read':'write',persistResult:operation!==LIST,
    validate:payload=>validate(operation,payload),authorize:input=>registry.authorize(input),
    async execute({payload,binding,secret,signal,assertActive}) {
      const value=registry.assert(binding);
      if(payload.wabaId!==value.definition.wabaId)fail('scope_denied');
      assertActive();
      if(operation===HEADER) return media({...payload,appId:value.metadata.appId,token:secret,proof:secrets.proof(secret,binding.connectionRef),signal,assertActive:()=>{assertActive();registry.assert(binding);secrets.proof(secret,binding.connectionRef);}});
      const result=await http({action:operation===LIST?'templates_list':operation===CREATE?'templates_create':'templates_delete',
        id:payload.wabaId,token:secret,proof:secrets.proof(secret,binding.connectionRef),signal,
        ...(operation===LIST?(payload.after?{after:payload.after}:{}):{json:operation===CREATE?payload.template:{name:payload.name,hsm_id:payload.templateId}})});
      assertActive();registry.assert(binding);return project(operation,result);
    },
    // The broker projects again before returning/persisting its receipt.
    project:result=>operation===LIST&&Object.hasOwn(result||{},'after')?project(LIST,{...result,paging:result.after?{next:true,cursors:{after:result.after}}:null}):project(operation,result),
  })]));
}
module.exports={LIST,CREATE,REMOVE,HEADER,OPERATIONS,validate,project,operations};
