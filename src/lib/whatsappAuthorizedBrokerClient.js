'use strict';

// Environment-scoped adapter. The registry contains routing metadata, never Meta
// credentials. Every send is pinned to an existing application Message ID.
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const TM = require('../../services/integrations-broker/src/whatsapp-template-management');
const C = require('../../services/integrations-broker/src/whatsapp-authorized-contract');
const providerErrors = require('../../services/integrations-broker/src/whatsapp-provider-errors');
const runtime = require('./whatsappAuthorizedRuntime');
const { createIntegrationsBrokerClient } = require('./integrationsBrokerClient');
const ROOT = runtime.ROOTS.staging;
const CONFIG_FILE = ROOT + '/config.json';
const BINDING_KEYS = ['connectionRef','authorizationId','clinicId','assetId','phoneId','wabaId','revision','sendEnabled'];
const validCutoff = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
// Only denials that cannot originate from checks after Meta's message POST.
// Scope/connection/asset revocations can race after that POST and remain unknown.
const NO_SEND_CODES = new Set(['invalid_signature','rate_limited','whatsapp_template_not_authorized']);
const PREFLIGHT_CODES = new Set(['whatsapp_broker_runtime_denied','whatsapp_authorized_configuration_invalid',
  'whatsapp_authorized_binding_invalid','whatsapp_authorized_scope_blocked','whatsapp_authorized_binding_changed']);
const id = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const providerId = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function fail(code, unknown = false) {
  throw Object.assign(Error(code), { code, retryable: false, ...(unknown ? { delivery_unknown: true } : {}) });
}
function checkedBinding(value) {
  const keys = [...BINDING_KEYS, ...(Object.hasOwn(value || {}, 'messageNotBefore') ? ['messageNotBefore'] : [])];
  if (!exact(value, keys) || Object.hasOwn(value || {}, 'messageNotBefore') && !validCutoff(value.messageNotBefore)
    || typeof value.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.connectionRef)
    || !uuid(value.authorizationId) || !id(value.clinicId) || !id(value.assetId) || !id(value.revision)
    || !providerId(value.phoneId) || !providerId(value.wabaId) || typeof value.sendEnabled !== 'boolean') fail('whatsapp_authorized_binding_invalid');
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
const sameBinding = (a, b) => [...BINDING_KEYS, 'messageNotBefore'].every(key => a[key] === b[key]);
const bindingCutoff = (config, binding) => new Date(Math.max(Date.parse(config.messageNotBefore),
  binding?.messageNotBefore ? Date.parse(binding.messageNotBefore) : 0)).toISOString();
function assertMessageEligibility(message, messageNotBefore) {
  const cutoff = Date.parse(messageNotBefore);
  const created = new Date(message?.createdAt || message?.created_at || '').getTime();
  if (!Number.isFinite(cutoff) || !Number.isFinite(created) || created < cutoff
    || !['pending','sending'].includes(message?.status) || message.direction !== 'outbound') fail('whatsapp_authorized_message_ineligible');
  const metadata = message.metadata == null ? {} : message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('whatsapp_authorized_message_ineligible');
  const present = value => value !== undefined && value !== null && value !== false && value !== '';
  const blockedKeys = ['wamid','providerMessageId','provider_message_id','provider_acceptance_status','provider_acceptance_at',
    'post_acceptance_error','post_acceptance_error_at','delivery_unknown','outcome_unknown','quarantine','quarantined',
    'quarantined_at','quarantine_reason','security_quarantine','containment','hold','on_hold','cancelled','canceled','cancelled_at','canceled_at',
    'sender_health_blocked'];
  if (blockedKeys.some(key => present(metadata[key])) || present(metadata.wa_response)
    || [metadata.error, metadata.status, metadata.delivery_status, metadata.outbound_retry?.reason]
      .some(value => typeof value === 'string' && /quarantin|delivery_unknown|outcome_unknown|cancel|held|hold|provider_accepted|expired/i.test(value))) {
    fail('whatsapp_authorized_message_ineligible');
  }
  return true;
}
function privateFile(file, max) {
  try {
    if (fs.realpathSync(file) !== file) throw Error();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > max) throw Error();
    return fs.readFileSync(file);
  } catch { fail('whatsapp_authorized_configuration_invalid'); }
}
function validateConfiguration(value, namespace = 'staging') {
  const root = runtime.ROOTS[namespace];
  if (!root) fail('whatsapp_authorized_configuration_invalid');
  if (!exact(value, ['version','origin','keyId','audience','privateKeyFile','caFile','bindings','messageNotBefore']) || value.version !== 1
    || typeof value.messageNotBefore !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.messageNotBefore)
    || !Number.isFinite(Date.parse(value.messageNotBefore))
    || typeof value.origin !== 'string' || typeof value.keyId !== 'string' || typeof value.audience !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.keyId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.audience)
    || value.privateKeyFile !== root + '/private.pem' || value.caFile !== root + '/ca.pem'
    || namespace === 'dev' && !/^dev-whatsapp(?:[-:.][A-Za-z0-9_.:-]+)?$/.test(value.keyId)
    || namespace === 'staging' && /^dev-whatsapp(?:[-:.]|$)/.test(value.keyId)
    || !Array.isArray(value.bindings) || value.bindings.length > 1000) fail('whatsapp_authorized_configuration_invalid');
  try {
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
  } catch { fail('whatsapp_authorized_configuration_invalid'); }
  const bindings = value.bindings.map(checkedBinding);
  if (new Set(bindings.map(b => `${b.clinicId}:${b.assetId}`)).size !== bindings.length) fail('whatsapp_authorized_configuration_invalid');
  return Object.freeze({ ...value, bindings: Object.freeze(bindings) });
}
function configuration(env = process.env) {
  if (!env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE) return null;
  const namespace = runtime.namespace(env), file = runtime.ROOTS[namespace] + '/config.json';
  if (env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE !== file) fail('whatsapp_authorized_configuration_invalid');
  const raw = privateFile(file, 1048576);
  try { return validateConfiguration(JSON.parse(raw.toString('utf8')), namespace); }
  catch { fail('whatsapp_authorized_configuration_invalid'); }
  finally { raw.fill(0); }
}
function configuredTransport(config) {
  return { async execute(command) {
    let key; let ca;
    try {
      key = privateFile(config.privateKeyFile, 8192); ca = privateFile(config.caFile, 65536);
      const client = createIntegrationsBrokerClient({ origin: config.origin, keyId: config.keyId, audience: config.audience,
        privateKey: key, ca, timeoutMs: 30000 });
      return await client.execute(command);
    } finally { key?.fill(0); ca?.fill(0); }
  } };
}
const models = () => require('../../models');
function createWhatsappAuthorizedBrokerClient({ environment = () => process.env, loadConfiguration = () => configuration(environment()),
  loadAsset = assetId => models().ClinicMetaAsset.findOne({ where: { id: assetId, assetType: 'whatsapp_phone_number' },
    attributes: ['id','clinicaId','grupoClinicaId','assignmentScope','assetType','phoneNumberId','wabaId','isActive'], raw: true }),
  loadClinic = clinicId => models().Clinica.findByPk(clinicId, { attributes: ['id_clinica','grupoClinicaId'], raw: true }),
  loadMessage = messageId => models().Message.findByPk(messageId, { attributes: ['id','conversation_id','direction','status','createdAt','metadata'], raw: true }),
  loadConversation = conversationId => models().Conversation.findByPk(conversationId, { attributes: ['id','clinic_id','patient_id'], raw: true }),
  loadExecution = executionId => models().FlowExecutionV2.findByPk(executionId, { attributes: ['id','clinic_id','trigger_entity_type','trigger_entity_id','context'], raw: true }),
  loadAppointment = appointmentId => models().CitaPaciente.findByPk(appointmentId, { raw: true }),
  patientHeld = patientId => require('./whatsappAppointmentEligibility').patientImportHeld(patientId),
  isBlocked = clinicId => require('../services/metaScopeBlock.service').blocked({ assignmentScope: 'clinic', clinicId }, { purpose: 'whatsapp' }),
  createTransport = configuredTransport } = {}) {
  function read() {
    const value = loadConfiguration();
    if (value === null) return null;
    return validateConfiguration(value, runtime.namespace(environment()));
  }
  function selected(config, clinicId, assetId) {
    if (!id(clinicId) || !id(assetId)) fail('whatsapp_authorized_binding_invalid');
    return config?.bindings.find(b => b.clinicId === clinicId && b.assetId === assetId) || null;
  }
  async function binding(clinicId, assetId, assetHint) {
    try {
      const config = read(); const value = selected(config, clinicId, assetId);
      if (!value) return null;
      const asset = assetHint || await loadAsset(assetId); const clinic = await loadClinic(clinicId);
      if (!asset || !clinic || Number(clinic.id_clinica) !== clinicId || asset.id !== value.assetId || asset.assetType !== 'whatsapp_phone_number'
        || asset.phoneNumberId !== value.phoneId || asset.wabaId !== value.wabaId
        || !(asset.assignmentScope === 'clinic' && Number(asset.clinicaId) === clinicId
          || asset.assignmentScope === 'group' && id(Number(asset.grupoClinicaId)) && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId))) {
        fail('whatsapp_authorized_binding_invalid');
      }
      // blocked() includes both this clinic and its current group, including
      // durable tombstones surviving deletion of the former connection.
      if (await isBlocked(clinicId) !== false) fail('whatsapp_authorized_scope_blocked');
      runtime.namespace(environment());
      const latest = read();
      if (!latest || JSON.stringify(latest) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      return value;
    } catch (error) { fail(PREFLIGHT_CODES.has(error?.code) ? error.code : 'whatsapp_authorized_binding_invalid'); }
  }
  async function eligibleIntent(intent, config, selectedBinding) {
    try {
      const message = await loadMessage(intent.messageId);
      if (!message || String(message.id) !== intent.messageId || !id(Number(message.conversation_id))) fail('whatsapp_authorized_message_ineligible');
      const conversation = await loadConversation(message.conversation_id);
      if (!conversation || String(conversation.id) !== String(message.conversation_id) || Number(conversation.clinic_id) !== intent.clinicId) {
        fail('whatsapp_authorized_message_ineligible');
      }
      assertMessageEligibility(message, bindingCutoff(config, selectedBinding));
      await require('./whatsappAppointmentEligibility').assertAutomatedMessageEligibility({ message, conversation,
        payload: intent.message, loadExecution, loadAppointment, patientHeld });
    } catch { fail('whatsapp_authorized_message_ineligible'); }
  }
  return Object.freeze({
    assertMessageEligible(message) {
      const config = read();
      if (config) assertMessageEligibility(message, config.messageNotBefore);
    },
    bindingsForClinic(clinicId) {
      if (!id(clinicId)) return [];
      return read()?.bindings.filter(b => b.clinicId === clinicId).map(b => ({ ...b })) || [];
    },
    binding,
    async media(messageId) {
      runtime.namespace(environment());
      const message=await loadMessage(Number(messageId));
      const conversation=message&&await loadConversation(message.conversation_id), m=message?.metadata;
      const config=read();
      const candidate=config?.bindings.find(b=>b.clinicId===Number(conversation?.clinic_id)&&b.phoneId===m?.phone_number_id&&b.wabaId===m?.waba_id);
      if(!candidate||!providerId(m?.media?.id)||conversation?.id!==message.conversation_id)fail('whatsapp_authorized_binding_invalid');
      const captured=await binding(candidate.clinicId,candidate.assetId);
      if(!captured)fail('whatsapp_authorized_binding_invalid');
      const R=require('../../services/integrations-broker/src/whatsapp-inbound-media');
      const requestId=randomUUID();
      const result=await createTransport(config).execute({requestId,tenantRef:'clinic:'+captured.clinicId,connectionRef:captured.connectionRef,
        assetRef:'wa-phone:'+captured.phoneId,operation:R.READ,payload:{authorizationId:captured.authorizationId,phoneId:captured.phoneId,mediaId:m.media.id}});
      const latest=await binding(captured.clinicId,captured.assetId);
      if(!latest||!sameBinding(captured,latest)||JSON.stringify(read())!==JSON.stringify(config)||result?.requestId!==requestId)fail('whatsapp_authorized_binding_changed');
      const data=R.project(result.data);const buffer=Buffer.from(data.base64,'base64');
      if(data.id!==m.media.id||buffer.length!==data.size||createHash('sha256').update(buffer).digest('hex')!==data.sha256)fail('whatsapp_authorized_request_invalid');
      return {buffer,contentType:data.mimeType,mediaInfo:{id:data.id,mime_type:data.mimeType,sha256:data.sha256,file_size:data.size}};
    },
    async annotate(clinicId, assets = []) {
      const result = [];
      const config = read();
      for (const raw of assets) {
        const { whatsappAuthorizedBinding: ignored, ...asset } = raw;
        const authorized = config ? await binding(clinicId, Number(asset.id), asset) : null;
        if (authorized) result.push({ ...asset, whatsappAuthorizedBinding: authorized });
        else if (asset.isActive !== false && asset.isActive !== 0) result.push(asset);
      }
      return result;
    },
    async templateBinding(wabaId, clinicId = null) {
      const config = read();
      const candidate = config?.bindings.find(b => b.wabaId === String(wabaId) && (!clinicId || b.clinicId === Number(clinicId)));
      if (!candidate) return null;
      const checked = await binding(candidate.clinicId, candidate.assetId);
      return checked?.sendEnabled ? checked : null;
    },
    async templates(wabaId, operation, input = {}, clinicId = null) {
      runtime.namespace(environment());
      if (!TM.OPERATIONS.includes(operation)) fail('whatsapp_authorized_request_invalid');
      const captured = await this.templateBinding(wabaId, clinicId);
      if (!captured) fail('whatsapp_authorized_binding_invalid');
      const payload = { authorizationId: captured.authorizationId, phoneId: captured.phoneId, wabaId: captured.wabaId, ...input };
      TM.validate(operation, payload);
      const config = read();
      const before = await binding(captured.clinicId,captured.assetId);
      if (!before || !sameBinding(captured,before) || JSON.stringify(read()) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      // Stable identity for mutations: a timeout may never silently create a
      // second template. Read-only catalog refreshes always use a new receipt.
      const digest=createHash('sha256').update(operation+'\0'+JSON.stringify(payload)).digest().subarray(0,16);
      digest[6]=(digest[6]&15)|64;digest[8]=(digest[8]&63)|128;
      const h=digest.toString('hex');
      const requestId=[TM.LIST,TM.HEADER].includes(operation)?randomUUID():`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      const result=await createTransport(config).execute({requestId,tenantRef:'clinic:'+captured.clinicId,
        connectionRef:captured.connectionRef,assetRef:'wa-phone:'+captured.phoneId,operation,payload});
      if(result?.requestId!==requestId)fail('whatsapp_authorized_request_invalid');
      const latest=await binding(captured.clinicId,captured.assetId);
      if(!latest||!sameBinding(captured,latest))fail('whatsapp_authorized_binding_changed');
      return operation===TM.LIST ? TM.project(operation,{...result.data,paging:result.data?.after?{next:true,cursors:{after:result.data.after}}:null}) : TM.project(operation,result.data);
    },
    async send(input) {
      runtime.namespace(environment());
      if (!exact(input, ['messageId','clinicId','assetId','expectedBinding','message']) || !id(input.clinicId) || !id(input.assetId)) fail('whatsapp_authorized_request_invalid');
      let intent;
      try { intent = structuredClone(input); } catch { fail('whatsapp_authorized_request_invalid'); }
      const requestId = runtime.requestId(intent.messageId, environment());
      const expected = checkedBinding(intent.expectedBinding);
      if (expected.clinicId !== intent.clinicId || expected.assetId !== intent.assetId) fail('whatsapp_authorized_binding_invalid');
      const payload = { authorizationId: expected.authorizationId, phoneId: expected.phoneId, message: intent.message };
      try { C.validateSend(payload); } catch { fail('whatsapp_authorized_request_invalid'); }
      const captured = await binding(intent.clinicId, intent.assetId);
      if (!captured || !sameBinding(captured, expected)) fail('whatsapp_authorized_binding_changed');
      if (!captured.sendEnabled) fail('whatsapp_authorized_send_paused');
      const config = read(); const transport = createTransport(config);
      await eligibleIntent(intent, config, captured);
      // Recheck durable scope/asset and private revision immediately before the
      // only network dispatch. There is no credential or legacy fallback.
      const beforeSend = await binding(intent.clinicId, intent.assetId);
      if (!beforeSend || !sameBinding(captured, beforeSend) || JSON.stringify(read()) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      await eligibleIntent(intent, config, captured);
      if (await isBlocked(intent.clinicId) !== false) fail('whatsapp_authorized_scope_blocked');
      if (JSON.stringify(read()) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      runtime.namespace(environment());
      let result;
      try {
        result = await transport.execute({ requestId, tenantRef: 'clinic:' + intent.clinicId, connectionRef: captured.connectionRef,
          assetRef: 'wa-phone:' + captured.phoneId, operation: C.SEND, payload });
      } catch (error) {
        if (PREFLIGHT_CODES.has(error?.code) || error?.code === 'broker_configuration_invalid') fail(error.code);
        if (NO_SEND_CODES.has(error?.code)) fail(error.code);
        const provider = providerErrors.diagnostic(error?.code);
        if (provider) {
          throw Object.assign(Error(error.code), { code: error.code, retryable: false,
            response: { data: { error: provider } } });
        }
        fail('whatsapp_delivery_unknown', true);
      }
      try {
        runtime.namespace(environment());
        const latest = await binding(intent.clinicId, intent.assetId);
        if (!latest || !sameBinding(captured, latest) || !exact(result, ['requestId','data','replayed']) || result.requestId !== requestId
          || typeof result.replayed !== 'boolean' || !exact(result.data, ['messages']) || !Array.isArray(result.data.messages)
          || result.data.messages.length !== 1 || !exact(result.data.messages[0], ['id', ...(Object.hasOwn(result.data.messages[0] || {}, 'message_status') ? ['message_status'] : [])])) {
          fail('whatsapp_delivery_unknown', true);
        }
        return C.projectResult(result.data);
      } catch { fail('whatsapp_delivery_unknown', true); }
    },
  });
}
module.exports = { CONFIG_FILE, configuration, validateConfiguration, checkedBinding, assertMessageEligibility, createWhatsappAuthorizedBrokerClient,
  ...createWhatsappAuthorizedBrokerClient() };
