'use strict';
const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager'); const { createHmac } = require('node:crypto');
const E = require('./whatsapp-onboarding-contract'); const { BrokerError, fail } = require('./errors');
const { createWhatsappOnboardingSecrets } = require('./whatsapp-onboarding-secrets');
const { createWhatsappCustomerVerifier } = require('./whatsapp-customer-verifier'); const { createWhatsappPhoneVerifier } = require('./whatsapp-phone-verifier');
function createWhatsappAuthorizedSecrets({ client, accountId, prefix, kmsKeyArn, registry, http, now = () => Date.now() }) {
  if (!registry?.assert || typeof http !== 'function') fail('invalid_request');
  const enrollment = createWhatsappOnboardingSecrets({ client, accountId, prefix, kmsKeyArn });
  const active = new Map(); const proofs = new WeakMap(); const generations = new Map(); let closed = false;
  function invalidate(ref) { generations.set(ref, (generations.get(ref) || 0) + 1); for (const token of active.get(ref) || []) { token.fill(0); proofs.delete(token); } }
  return Object.freeze({
    async withSecret(binding, work, { signal } = {}) {
      let token; let body; let applicationToken; let abort; let rawValue;
      const ref = binding.connectionRef; const generation = generations.get(ref) || 0;
      const check = () => { if (closed || signal?.aborted || generation !== (generations.get(ref) || 0)) fail('connection_blocked'); return registry.assert(binding); };
      try {
        const before = check(); const { enrollmentBinding: original, row, metadata } = before;
        await enrollment.candidate(original, row, row.secret_digest, signal); check();
        const result = await client.send(new GetSecretValueCommand({ SecretId: original.secretArn, VersionId: row.id }), { abortSignal: signal }); check();
        // Historical exact versions may have no label after a later enrollment.
        const stages = result.VersionStages === undefined ? [] : result.VersionStages;
        if (result.ARN !== original.secretArn || result.VersionId !== row.id || !Array.isArray(stages)
          || stages.some(s => ['AWSCURRENT','AWSPREVIOUS'].includes(s)) || typeof result.SecretString !== 'string'
          || Buffer.byteLength(result.SecretString) > 32768) fail('secret_unavailable');
        body = Buffer.from(result.SecretString); if (E.hash(body) !== row.secret_digest) fail('secret_unavailable');
        rawValue = JSON.parse(body.toString('utf8')); token = Buffer.from(rawValue.accessToken || ''); delete rawValue.accessToken;
        const encoded = enrollment.encode(original, row, metadata, token);
        try { if (!encoded.body.equals(body)) fail('secret_unavailable'); } finally { encoded.body.fill(0); body.fill(0); body = null; }
        const tokens = active.get(ref) || new Set(); tokens.add(token); active.set(ref, tokens);
        abort = () => { token.fill(0); proofs.delete(token); }; signal?.addEventListener('abort', abort, { once: true }); check();
        const guardedHttp = async input => { check(); const value = await http(input); check(); return value; };
        const customer = createWhatsappCustomerVerifier({ http: guardedHttp, now }); const phone = createWhatsappPhoneVerifier({ http: guardedHttp });
        return await enrollment.withApplication(original, async appSecret => {
          check(); const proof = createHmac('sha256', appSecret).update(token).digest('hex'); proofs.set(token, { ref, proof, check });
          applicationToken = Buffer.concat([Buffer.from(metadata.appId + '|'), appSecret]);
          let response; try { response = await guardedHttp({ action: 'inspect', id: metadata.appId, token: applicationToken, candidate: token, signal }); }
          finally { applicationToken.fill(0); }
          check(); const b = E.bindingFor(original);
          const grant = await customer({ response, token, proof, signal, expected: { ...b.customer, appId: b.appId, scopes: b.scopes,
            businessId: metadata.businessId, wabaIds: metadata.grantedWabaIds, selectedWabaId: metadata.wabaId } }); check();
          if (grant.subjectId !== metadata.subjectId || grant.tokenType !== metadata.tokenType || grant.businessId !== metadata.businessId
            || JSON.stringify(grant.wabaIds) !== JSON.stringify(metadata.grantedWabaIds)) fail('scope_denied');
          await phone({ wabaId: metadata.wabaId, phoneId: metadata.phoneId, token, proof, signal }); check();
          const checkGrant = () => { check(); if ([grant.expiresAt, grant.dataAccessExpiresAt].some(v => v !== null && v <= now())) fail('credential_revoked'); };
          proofs.set(token, { ref, proof, check: checkGrant }); checkGrant();
          const value = await work(token); checkGrant();
          if (JSON.stringify(value)?.includes(token.toString('utf8'))) fail('provider_failed');
          await enrollment.candidate(original, row, row.secret_digest, signal); checkGrant(); return value;
        }, signal);
      } catch (e) { throw new BrokerError(e instanceof BrokerError ? e.code : 'secret_unavailable'); }
      finally {
        if (abort) signal?.removeEventListener('abort', abort); token?.fill(0); body?.fill(0); applicationToken?.fill(0);
        if (token) proofs.delete(token); const tokens = active.get(ref); tokens?.delete(token); if (!tokens?.size) active.delete(ref);
      }
    },
    proof(token, ref) { const v = proofs.get(token); if (!v || v.ref !== ref) fail('secret_unavailable'); v.check(); return v.proof; },
    invalidate,
    close() { closed = true; for (const ref of active.keys()) invalidate(ref); },
  });
}
module.exports = { createWhatsappAuthorizedSecrets };
