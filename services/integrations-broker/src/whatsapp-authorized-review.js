'use strict';
// Administrator-only read-only preflight. It neither starts the broker API nor
// executes any send operation, writes a ledger, promotes a secret or subscribes.
const fs = require('node:fs'); const https = require('node:https');
const { BrokerError, fail } = require('./errors'); const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract'); const { GRAPH_VERSION } = require('./whatsapp-contract');
const { tokenText } = require('./whatsapp-secrets'); const { createWhatsappAuthorizedHttp } = require('./whatsapp-authorized-http');
const { createWhatsappAuthorizedSecrets } = require('./whatsapp-authorized-secrets');
const { createWhatsappAuthorizedRegistry } = require('./whatsapp-authorized-registry');
const { validateConfig } = require('./whatsapp-authorized-main'); const { validateConfig: validateEnrollmentConfig } = require('./whatsapp-onboarding-main');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const VERIFY_ACTIONS = new Set(['inspect','phones','phone_state','waba_owner']);
const REVIEW_ACTIONS = new Set(['review_phone','review_subscriptions','review_templates']);
const cursor = value => typeof value === 'string' && /^[A-Za-z0-9_+=/-]{1,2048}$/.test(value);
function createReviewHttp({ request = https.request, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_request');
  const verify = createWhatsappAuthorizedHttp({ request, timeoutMs });
  return async input => {
    if (VERIFY_ACTIONS.has(input?.action)) return verify(input);
    if (!C.keys(input, ['action','id','token','proof','signal'], ['after']) || !REVIEW_ACTIONS.has(input.action) || !E.id(input.id)
      || !Buffer.isBuffer(input.token) || !tokenText(input.token.toString('utf8')) || typeof input.proof !== 'string' || !/^[a-f0-9]{64}$/.test(input.proof)
      || input.after !== undefined && (input.action === 'review_phone' || !cursor(input.after))) fail('invalid_request');
    if (input.signal?.aborted) fail('provider_timeout');
    const query = new URLSearchParams({ appsecret_proof: input.proof });
    if (input.action === 'review_phone') query.set('fields', 'id,status,code_verification_status,quality_rating,is_on_biz_app,platform_type');
    if (input.action === 'review_templates') query.set('fields', 'id,name,language,status,components');
    if (input.action !== 'review_phone') query.set('limit', '100');
    if (input.after) query.set('after', input.after);
    const suffix = input.action === 'review_templates' ? '/message_templates' : input.action === 'review_subscriptions' ? '/subscribed_apps' : '';
    return new Promise((resolve, reject) => {
      let req; let timer; let done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); input.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      try {
        req = request({ protocol: 'https:', hostname: 'graph.facebook.com', port: 443, method: 'GET',
          path: `/${GRAPH_VERSION}/${input.id}${suffix}?${query}`, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
          headers: { authorization: 'Bearer ' + input.token.toString('utf8'), accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
          if (String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
            || !['','identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase()) || res.statusCode >= 300 && res.statusCode < 400) {
            finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); return;
          }
          let size = 0; const chunks = [];
          res.on('data', chunk => { size += chunk.length; if (size > 1048576) { finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); }
            else if (!done) chunks.push(chunk); });
          res.on('aborted', () => finish(new BrokerError('provider_failed'))); res.on('error', () => finish(new BrokerError('provider_failed')));
          res.on('end', () => {
            if (done) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if ([190,102].includes(value?.error?.code)) fail('credential_revoked');
              if ([401,403].includes(res.statusCode) || [10,200].includes(value?.error?.code)) fail('provider_unauthorized');
              if (res.statusCode !== 200 || !value || typeof value !== 'object' || Array.isArray(value) || value.error) fail('provider_failed');
              finish(null, value);
            } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('provider_failed')); }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed'))); input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted || done) abort(); else req.end();
      } catch { finish(new BrokerError('provider_failed')); req?.destroy(); }
    });
  };
}
const safeEnum = (value, values) => values.includes(value) ? value : null;
function projectTemplate(raw) {
  if (!E.id(raw?.id) || typeof raw.name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(raw.name)
    || typeof raw.language !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(raw.language)) fail('provider_failed');
  let contentDigest = null;
  try { contentDigest = C.templateDigest(raw); } catch {}
  return { id: raw.id, name: raw.name, language: raw.language,
    status: safeEnum(raw.status, ['APPROVED','PENDING','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED']),
    contentDigest, compatible: contentDigest !== null };
}
async function reviewAuthorization({ binding, registry, secrets, http, now = () => Date.now() }) {
  const initial = registry.review(binding);
  const signal = AbortSignal.timeout(120000);
  const result = await secrets.withSecret(binding, async token => {
    const read = async (action, id, after) => {
      registry.review(binding);
      const proof = secrets.proof(token, binding.connectionRef);
      const value = await http({ action, id, token, proof, signal, ...(after ? { after } : {}) });
      registry.review(binding); secrets.proof(token, binding.connectionRef); return value;
    };
    const pages = async (action, id, project) => {
      const items = []; const cursors = new Set(); let after;
      for (let page = 0; page < 20; page++) {
        const raw = await read(action, id, after);
        if (!raw || raw.error || !Array.isArray(raw.data) || raw.data.length > 100) fail('provider_failed');
        items.push(...raw.data.map(project));
        if (!raw.paging?.next) return items;
        after = raw.paging?.cursors?.after;
        // Never follow Graph paging URLs, which may contain tokens or hosts.
        if (!raw.data.length || !cursor(after) || cursors.has(after)) fail('provider_failed');
        cursors.add(after);
      }
      fail('provider_failed');
    };
    const phone = await read('review_phone', initial.definition.phoneId);
    if (!phone || phone.error || phone.id !== initial.definition.phoneId) fail('scope_denied');
    const appIds = await pages('review_subscriptions', initial.definition.wabaId, raw => {
      const id = raw?.whatsapp_business_api_data?.id;
      if (!E.id(id)) fail('provider_failed'); return id;
    });
    const templates = await pages('review_templates', initial.definition.wabaId, projectTemplate);
    if (new Set(templates.map(t => t.id)).size !== templates.length || new Set(appIds).size !== appIds.length) fail('provider_failed');
    return { status: 'reviewed_not_activated', observedAt: new Date(now()).toISOString(), connectionRef: binding.connectionRef,
      authorizationId: initial.definition.authorizationId, appId: initial.metadata.appId, wabaId: initial.definition.wabaId,
      sendEnabled: initial.definition.enabled === true, appSubscribed: appIds.includes(initial.metadata.appId),
      subscribedAppIds: appIds.sort(),
      phone: { id: phone.id, status: safeEnum(phone.status, ['CONNECTED','DISCONNECTED','BANNED','MIGRATED','PENDING','DELETED']),
        codeVerificationStatus: safeEnum(phone.code_verification_status, ['VERIFIED','NOT_VERIFIED','EXPIRED']),
        qualityRating: safeEnum(phone.quality_rating, ['GREEN','YELLOW','RED','UNKNOWN']),
        isOnBizApp: typeof phone.is_on_biz_app === 'boolean' ? phone.is_on_biz_app : null,
        platformType: safeEnum(phone.platform_type, ['CLOUD_API','ON_PREMISE','NOT_APPLICABLE']) }, templates };
  }, { signal });
  registry.review(binding); return result;
}
async function main(filename, connectionRef, { awsFactory = connectAws, http = createReviewHttp(), now = () => Date.now() } = {}) {
  let raw; let aws; let registry; let secrets;
  try {
    if (typeof connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(connectionRef)) fail('invalid_request');
    raw = privateFile(filename); const config = validateConfig(JSON.parse(raw.toString('utf8'))); raw.fill(0); raw = null;
    const binding = config.policy.connections.find(value => value.connectionRef === connectionRef);
    if (!binding) fail('scope_denied');
    const state = fs.statSync(config.enrollmentStateFile);
    if (fs.realpathSync(config.enrollmentStateFile) !== config.enrollmentStateFile || !state.isFile() || state.mode & 0o077) fail('invalid_request');
    const loadEnrollmentBinding = ref => {
      const body = privateFile(config.enrollmentConfigFile);
      try { const enrollment = validateEnrollmentConfig(JSON.parse(body.toString('utf8')));
        if (enrollment.stateFile !== config.enrollmentStateFile) fail('invalid_request');
        return enrollment.policy.connections.find(value => value.connectionRef === ref);
      } finally { body.fill(0); }
    };
    registry = createWhatsappAuthorizedRegistry({ filename: config.enrollmentStateFile, authorizations: config.authorizations, loadEnrollmentBinding, now });
    registry.review(binding);
    aws = await awsFactory();
    const readOnlyHttp = input => {
      if (!VERIFY_ACTIONS.has(input?.action) && !REVIEW_ACTIONS.has(input?.action)) fail('operation_denied');
      return http(input);
    };
    // Only this CLI injects the paused-review view; runtime assert stays strict.
    secrets = createWhatsappAuthorizedSecrets({ client: aws.secrets, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/',
      kmsKeyArn: SECRET_KEY, registry: { assert: value => registry.review(value) }, http: readOnlyHttp, now });
    return await reviewAuthorization({ binding, registry, secrets, http: readOnlyHttp, now });
  } finally { raw?.fill(0); secrets?.close(); registry?.close(); aws?.close(); }
}
if (require.main === module) main(process.argv[2], process.argv[3]).then(value => {
  process.stdout.write(JSON.stringify(value) + '\n');
}).catch(error => {
  const code = error instanceof BrokerError ? error.code : 'internal_error';
  process.stderr.write(JSON.stringify({ status: 'review_failed', code }) + '\n'); process.exitCode = 1;
});
module.exports = { createReviewHttp, projectTemplate, reviewAuthorization, main };
