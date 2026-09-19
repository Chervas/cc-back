'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { BrokerStore } = require('../src/store'), { Broker } = require('../src/broker'), { signRequest } = require('../src/auth');
const { createMetaMarketingSecrets } = require('../src/meta-marketing-secrets');
const { createMetaMarketingOperations } = require('../src/meta-marketing-operations');
const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
const C = require('../src/meta-marketing-contract');
const TOKEN = 'FICTITIOUS_META_MARKETING_TOKEN', APP = '0123456789abcdef'.repeat(2);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-meta-marketing-qa-')); fs.chmodSync(dir, 0o700);
  const keys = generateKeyPairSync('ed25519'), controlKeys = generateKeyPairSync('ed25519');
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/meta-marketing/staging/`;
  const binding = { connectionRef: 'connection:meta-qa', provider: C.PROVIDER, initialState: 'active', expiresAt: Date.now() + 3600000,
    secretArn: prefix + 'token-abcdef', clientSecretArn: prefix + 'app-abcdef',
    metaMarketing: { appId: '101', subjectId: '201', tokenVersionId: 't'.repeat(32), appVersionId: 'a'.repeat(32),
      scopes: ['ads_read', 'pages_read_engagement', 'instagram_basic'], assets: [
        { assetRef: 'meta-ad_account:301', id: '301', kind: 'ad_account', parentPageId: null },
        { assetRef: 'meta-facebook_page:401', id: '401', kind: 'facebook_page', parentPageId: null },
        { assetRef: 'meta-instagram_business:501', id: '501', kind: 'instagram_business', parentPageId: '401' },
      ] } };
  const principal = (id, keyId, k) => ({ id, keyId, enabled: true, maxPerMinute: 60, publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }) });
  const grants = binding.metaMarketing.assets.flatMap(asset => [
    { principalId: 'staging:meta-marketing', tenantRef: 'clinic:59', connectionRef: binding.connectionRef, assetRef: asset.assetRef, operations: [...C.OPERATIONS] },
    { principalId: 'control:staging:meta-marketing', tenantRef: 'clinic:59', connectionRef: binding.connectionRef, assetRef: asset.assetRef, operations: [C.REVOKE] },
  ]);
  const policy = { audience: 'broker:meta-marketing-qa', version: 'meta-marketing-qa-v1', maxBacklog: 200,
    principals: [principal('staging:meta-marketing', 'qa-read', keys), principal('control:staging:meta-marketing', 'qa-control', controlKeys)], connections: [binding], grants };
  const values = new Map([[binding.secretArn, { version: 1, provider: C.PROVIDER, connectionRef: binding.connectionRef, appId: '101', subjectId: '201',
    accessToken: TOKEN, expiresAt: null, scopes: [...binding.metaMarketing.scopes] }], [binding.clientSecretArn, { version: 1, provider: 'meta-app', appId: '101', appSecret: APP }]]);
  const pins = new Map([[binding.secretArn, binding.metaMarketing.tokenVersionId], [binding.clientSecretArn, binding.metaMarketing.appVersionId]]);
  const state = { aws: [], http: [], awsHook: null, httpHook: null, inspect: null, asset: null };
  const aws = { async send(command, options) {
    state.aws.push({ name: command.constructor.name, arn: command.input.SecretId });
    const { SecretId: arn, VersionId, VersionStage } = command.input; assertKnown(arn);
    let result = command.constructor.name === 'DescribeSecretCommand'
      ? { ARN: arn, KmsKeyId: SECRET_KEY, VersionIdsToStages: { [pins.get(arn)]: ['AWSCURRENT'] } }
      : { ARN: arn, VersionId, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(values.get(arn)) };
    if (command.constructor.name === 'GetSecretValueCommand' && (VersionId !== pins.get(arn) || VersionStage !== 'AWSCURRENT')) throw Error('UNPINNED_TEST_READ');
    return await state.awsHook?.(result, command, options) || result;
  } };
  function assertKnown(arn) { if (!values.has(arn)) throw Error('UNEXPECTED_TEST_SECRET'); }
  const inspect = () => ({ data: { app_id: '101', user_id: '201', type: 'USER', is_valid: true,
    expires_at: Math.floor(Date.now() / 1000) + 3600, data_access_expires_at: 0, scopes: [...binding.metaMarketing.scopes],
    granular_scopes: [{ scope: 'ads_read', target_ids: ['301'] }, { scope: 'pages_read_engagement', target_ids: ['401'] }, { scope: 'instagram_basic', target_ids: ['401'] }] } });
  const http = async req => {
    state.http.push({ action: req.action, id: req.id }); await state.httpHook?.(req);
    if (req.action === 'inspect') {
      if (req.token.toString() !== '101|' + APP || req.candidate.toString() !== TOKEN) throw Error('WRONG_TEST_CREDENTIAL');
      return state.inspect?.(req) || inspect();
    }
    if (req.token.toString() !== TOKEN || !/^[a-f0-9]{64}$/.test(req.proof)) throw Error('WRONG_TEST_PROOF');
    if (state.asset) return state.asset(req);
    return req.action === 'ad_account' ? { id: 'act_301', account_id: '301', name: 'FICTITIOUS_ACCOUNT', account_status: 1, currency: 'EUR', timezone_name: 'Europe/Madrid', access_token: TOKEN }
      : req.action === 'facebook_page' ? { id: '401', name: 'FICTITIOUS_PAGE', access_token: TOKEN }
      : req.action === 'instagram_parent' ? { id: '401', instagram_business_account: { id: '501' } }
      : { id: '501', name: 'FICTITIOUS_INSTAGRAM', username: 'fictitious_instagram', access_token: TOKEN };
  };
  const secrets = createMetaMarketingSecrets({ client: aws, http, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/meta-marketing/staging/', kmsKeyArn: SECRET_KEY });
  const filename = path.join(dir, 'state.sqlite'), store = new BrokerStore(filename);
  const broker = new Broker({ store, policy, secrets, operations: createMetaMarketingOperations({ http, secrets }) });
  const command = (overrides = {}) => ({ requestId: randomUUID(), tenantRef: 'clinic:59', connectionRef: binding.connectionRef,
    assetRef: 'meta-ad_account:301', operation: C.ASSET, payload: {}, ...overrides });
  const sign = (value, control = false) => signRequest(value, { keyId: control ? 'qa-control' : 'qa-read', privateKey: (control ? controlKeys : keys).privateKey, audience: policy.audience });
  const execute = (value = command(), control = false, target = broker) => { const signed = sign(value, control); return target.execute(signed.raw, signed.headers); };
  const config = { cohort: C.COHORT, enabled: true, environment: 'staging', listenAddress: '127.0.0.1', port: 19092,
    stateFile: path.join(dir, 'runtime.sqlite'), tlsCertFile: path.join(dir, 'tls.crt'), tlsKeyFile: path.join(dir, 'tls.key'), policy };
  t.after(() => { secrets.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, binding, policy, config, keys, controlKeys, values, pins, state, aws, http, secrets, store, broker, command, sign, execute, inspect };
}
module.exports = { fixture, TOKEN, APP };
