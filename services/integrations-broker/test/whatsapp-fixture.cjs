'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { BrokerStore } = require('../src/store'); const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const { createWhatsappSecrets } = require('../src/whatsapp-secrets'); const { createWhatsappOperations } = require('../src/whatsapp-operations');
const { ACCOUNT, SECRET_KEY } = require('../src/google-main'); const C = require('../src/whatsapp-contract');
const { createWhatsappCredentialInspector } = require('../src/whatsapp-credential-inspector');
const SEND_TOKEN = 'FICTITIOUS_WHATSAPP_SEND_TOKEN'; const READ_TOKEN = 'FICTITIOUS_WHATSAPP_READER_TOKEN'; const APP_SECRET = '0123456789abcdef'.repeat(2);
function tokenMetadata(read = false) {
  const scope = read ? 'whatsapp_business_management' : 'whatsapp_business_messaging';
  return { data: { app_id: '101', user_id: read ? '202' : '201', type: 'SYSTEM_USER', is_valid: true, expires_at: 0, data_access_expires_at: 0,
    scopes: [scope], granular_scopes: [{ scope, target_ids: ['301'] }] } };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-whatsapp-qa-')); fs.chmodSync(dir, 0o700);
  const keys = generateKeyPairSync('ed25519'); const controlKeys = generateKeyPairSync('ed25519');
  const rawTemplate = { id: '901', name: 'qa_appointment', language: 'es', status: 'APPROVED',
    components: [{ type: 'BODY', text: 'FICTITIOUS_APPOINTMENT {{1}}', example: { body_text: [['FICTITIOUS_NAME']] } }] };
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`;
  const binding = { connectionRef: 'connection:wa-qa', provider: C.PROVIDER, initialState: 'active', expiresAt: Date.now() + 3600000,
    secretArn: prefix + 'qa-send-abcdef', templateReaderSecretArn: prefix + 'qa-reader-abcdef', clientSecretArn: prefix + 'qa-app-abcdef',
    whatsapp: { appId: '101', subjectId: '201', readerSubjectId: '202', wabaId: '301', phoneId: '401', tokenVersionId: 's'.repeat(32),
      readerVersionId: 'r'.repeat(32), appVersionId: 'a'.repeat(32), templates: [{ key: 'appointment', id: rawTemplate.id,
        name: rawTemplate.name, language: rawTemplate.language, contentDigest: C.templateDigest(rawTemplate), bodyParameters: 1 }] } };
  const principal = (id, keyId, k) => ({ id, keyId, enabled: true, maxPerMinute: 60, publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }) });
  const grant = { tenantRef: 'clinic:123', connectionRef: binding.connectionRef, assetRef: 'wa-phone:401' };
  const policy = { audience: 'broker:whatsapp-qa', version: 'wa-qa-v1', maxBacklog: 100,
    principals: [principal('staging:whatsapp', 'qa-send', keys), principal('control:whatsapp', 'qa-control', controlKeys)], connections: [binding],
    grants: [{ ...grant, principalId: 'staging:whatsapp', operations: [...C.OPERATIONS] }, { ...grant, principalId: 'control:whatsapp', operations: [C.REVOKE] }] };
  const tokenValue = (read) => ({ version: 1, provider: read ? 'meta_whatsapp_template_reader' : C.PROVIDER, connectionRef: binding.connectionRef,
    appId: '101', subjectId: read ? '202' : '201', wabaId: '301', phoneId: '401', accessToken: read ? READ_TOKEN : SEND_TOKEN,
    expiresAt: null, scopes: [read ? 'whatsapp_business_management' : 'whatsapp_business_messaging'] });
  const values = new Map([[binding.secretArn, tokenValue(false)], [binding.templateReaderSecretArn, tokenValue(true)],
    [binding.clientSecretArn, { version: 1, provider: 'meta-app', appId: '101', appSecret: APP_SECRET }]]);
  const pins = new Map([[binding.secretArn, binding.whatsapp.tokenVersionId], [binding.templateReaderSecretArn, binding.whatsapp.readerVersionId], [binding.clientSecretArn, binding.whatsapp.appVersionId]]);
  const calls = []; let modify = result => result;
  const aws = { async send(command, options) {
    const { SecretId: arn, VersionId, VersionStage } = command.input; calls.push({ name: command.constructor.name, input: command.input, options });
    if (!values.has(arn)) throw Error('UNEXPECTED_SECRET_READ');
    let value;
    if (command.constructor.name === 'DescribeSecretCommand') value = { ARN: arn, KmsKeyId: SECRET_KEY, VersionIdsToStages: { [pins.get(arn)]: ['AWSCURRENT'] } };
    else {
      if (VersionId !== pins.get(arn) || VersionStage !== 'AWSCURRENT') throw Error('UNPINNED_READ');
      value = { ARN: arn, VersionId, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(values.get(arn)) };
    }
    return modify(value, command, options);
  } };
  const inspections = []; let inspectResponse = req => tokenMetadata(req.candidate.toString() === READ_TOKEN);
  const secrets = createWhatsappSecrets({ client: aws, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY,
    inspectCredential: createWhatsappCredentialInspector({ http: async req => { inspections.push(req); return inspectResponse(req); } }) });
  const filename = path.join(dir, 'state.sqlite'); const store = new BrokerStore(filename);
  const command = (overrides = {}) => ({ requestId: randomUUID(), ...grant, operation: C.TEXT,
    payload: { to: '34000000123', body: 'FICTITIOUS_MESSAGE_BODY', previewUrl: false }, ...overrides });
  const sign = (value, control = false) => signRequest(value, { keyId: control ? 'qa-control' : 'qa-send', privateKey: (control ? controlKeys : keys).privateKey, audience: policy.audience });
  const makeBroker = (http, targetStore = store) => new Broker({ store: targetStore, policy, secrets, operations: createWhatsappOperations({ http, secrets }) });
  const execute = (broker, value, control = false) => { const s = sign(value, control); return broker.execute(s.raw, s.headers); };
  const config = { cohort: C.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19091, stateFile: filename,
    tlsCertFile: path.join(dir, 'tls.crt'), tlsKeyFile: path.join(dir, 'tls.key'), policy };
  t.after(() => { secrets.close(); try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, store, keys, controlKeys, binding, policy, config, rawTemplate, values, pins, calls, aws, secrets,
    command, sign, execute, makeBroker, inspections, inspectResponse: fn => { inspectResponse = fn; }, modify: fn => { modify = fn; } };
}
module.exports = { fixture, SEND_TOKEN, READ_TOKEN, APP_SECRET, tokenMetadata };
