'use strict';
const path = require('node:path'); const { randomUUID } = require('node:crypto');
const { fixture: onboardingFixture } = require('./whatsapp-onboarding-fixture.cjs');
const { BrokerStore } = require('../src/store'); const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const C = require('../src/whatsapp-authorized-contract'); const { createWhatsappAuthorizedRegistry } = require('../src/whatsapp-authorized-registry');
const { createWhatsappAuthorizedSecrets } = require('../src/whatsapp-authorized-secrets'); const { createWhatsappAuthorizedOperations } = require('../src/whatsapp-authorized-operations');
const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
const template = () => ({ id: '901', name: 'appointment_qa', language: 'es', status: 'APPROVED', components: [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['FICTITIOUS_IMAGE_HANDLE'] } },
  { type: 'BODY', text: 'Cita {{1}} a las {{2}}', example: { body_text: [['QA','10:00']] } },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar' }, { type: 'URL', text: 'Cambiar', url: 'https://clinic.example.invalid/appointment/{{1}}', example: ['https://clinic.example.invalid/appointment/qa'] }] },
] });
const textMessage = () => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '+34000000123', type: 'text', text: { body: 'FICTITIOUS_TEST_ONLY', preview_url: false } });
const templateMessage = () => ({ messaging_product: 'whatsapp', to: '34000000123', type: 'template', template: { name: 'appointment_qa', language: { code: 'es' }, components: [
  { type: 'header', parameters: [{ type: 'image', image: { link: 'https://clinic.example.invalid/image.png' } }] },
  { type: 'body', parameters: [{ type: 'text', text: 'QA' }, { type: 'text', text: '10:00' }] },
  { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'FICTITIOUS_CONFIRM' }] },
  { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'qa' }] },
] } });
async function fixture(t, { enabled = true } = {}) {
  const f = onboardingFixture(t, { customer: { selectionOnly: true }, scopes: ['whatsapp_business_management','whatsapp_business_messaging','public_profile','whatsapp_business_manage_events'] });
  const flow = await f.begin(); await f.finish(flow); const row = f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
  const definition = { connectionRef: 'connection:authorized-qa', authorizationId: flow.flowId, enabled, enrollmentBinding: f.binding,
    phoneId: '401', wabaId: '301', candidateDigest: row.secret_digest, expiresAt: f.now()+86400000,
    templates: [{ id: '901', name: 'appointment_qa', language: 'es', contentDigest: C.templateDigest(template()) }] };
  const binding = { connectionRef: definition.connectionRef, provider: C.PROVIDER, initialState: 'active', expiresAt: definition.expiresAt };
  const registry = createWhatsappAuthorizedRegistry({ filename: f.filename, authorizations: [definition], loadEnrollmentBinding: () => f.binding, now: f.now });
  const state = { calls: [], before: null, after: null, remoteTemplate: template(), response: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.FICTITIOUS_QA', message_status: 'accepted' }] } };
  const http = async request => {
    state.calls.push({ action: request.action, id: request.id, ...(request.json ? { json: structuredClone(request.json) } : {}) });
    await state.before?.(request); let result;
    if (request.action === 'send') result = structuredClone(state.response);
    else if (request.action === 'template') result = structuredClone(state.remoteTemplate);
    else result = await f.http(request);
    return state.after ? state.after(request, result) : result;
  };
  const secrets = createWhatsappAuthorizedSecrets({ client: f.aws, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY, registry, http, now: f.now });
  const principal = (id, keyId, key) => ({ id, keyId, enabled: true, maxPerMinute: 60, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  const policy = { audience: 'broker:authorized-qa', version: 'authorized-qa-v1', maxBacklog: 100,
    principals: [principal('staging:whatsapp','qa-staging',f.gateway), principal('control:whatsapp','qa-control',f.control)], connections: [binding],
    grants: [71,72].flatMap(id => [{ principalId: 'staging:whatsapp', tenantRef: 'clinic:'+id, connectionRef: binding.connectionRef, assetRef: 'wa-phone:401', operations: [C.SEND] },
      { principalId: 'control:whatsapp', tenantRef: 'clinic:'+id, connectionRef: binding.connectionRef, assetRef: 'wa-phone:401', operations: [C.REVOKE] }]) };
  const filename = path.join(f.dir, 'authorized.sqlite'); const stores=[];
  const make = () => { const store = new BrokerStore(filename); stores.push(store); return { store, broker: new Broker({ store, policy, secrets,
    operations: createWhatsappAuthorizedOperations({ http, secrets, registry }), now: f.now }) }; };
  let current = make();
  const request = (message = textMessage(), overrides = {}) => ({ requestId: randomUUID(), tenantRef: 'clinic:71', connectionRef: binding.connectionRef,
    assetRef: 'wa-phone:401', operation: C.SEND, payload: { authorizationId: flow.flowId, phoneId: '401', message }, ...overrides });
  const execute = (value = request(), control = false) => { const signed = signRequest(value, { keyId: control ? 'qa-control' : 'qa-staging',
    privateKey: (control ? f.control : f.gateway).privateKey, audience: policy.audience, now: f.now() }); return current.broker.execute(signed.raw,signed.headers); };
  t.after(() => { secrets.close(); registry.close(); for (const store of stores) try { store.close(); } catch {} });
  return { f, definition, binding, registry, state, http, secrets, policy, request, execute, get current() { return current; },
    restart() { current.store.close(); current=make(); }, sends: () => state.calls.filter(c => c.action === 'send'),
    blockScope() { f.current.store.db.prepare('INSERT INTO whatsapp_onboarding_scope_blocks VALUES (?,?,?,?)').run('clinic:71',f.binding.connectionRef,randomUUID(),f.now()); } };
}
module.exports = { fixture, template, textMessage, templateMessage };
