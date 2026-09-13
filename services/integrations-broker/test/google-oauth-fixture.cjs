'use strict';
const assert = require('node:assert/strict'); const { SCOPE } = require('../src/google-secrets');
const { PROVIDER } = require('../src/google-business-profile-contract');
const { createGoogleOAuthSecrets } = require('../src/google-oauth-secrets');
function oauthSecretsFixture(provider = PROVIDER) {
  const config = { accountId: '137819318729', prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: 'arn:aws:kms:eu-west-3:137819318729:key/15864f4f-2db5-485b-a49f-303c57eedc59' };
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-google-abcdef';
  const appArn = secretArn.replace('fictitious-google', 'fictitious-client');
  const binding = { connectionRef: 'connection:test', provider, secretArn, clientSecretArn: appArn,
    oauth: { subject: '123456789', redirectUri: 'https://auth.example.invalid/oauth/google/callback', scopes: ['openid','email','profile',SCOPE] } };
  if (provider !== PROVIDER) {
    binding.googleSubject = binding.oauth.subject;
    const contract = require(provider === 'google_search_console' ? '../src/google-search-console-contract' : provider === 'google_ads' ? '../src/google-ads-contract' : '../src/google-analytics-contract');
    binding.oauth.scopes[3] = provider === 'google_ads' ? contract.SCOPES[0] : contract.SCOPES.find(s => s.endsWith('.readonly'));
    if (provider === 'google_search_console') { const site = contract.site('sc-domain:example.invalid'); binding.searchConsoleSites = [{ siteUrl: site.siteUrl, assetRef: site.assetRef }]; }
    else if (provider === 'google_ads') { binding.googleAdsAccounts = [{ customerId: '1234567890', loginCustomerId: '9876543210', assetRef: 'ads:1234567890' }]; binding.developerSecretArn = secretArn.replace('fictitious-google', 'fictitious-developer'); }
    else binding.analyticsProperties = [{ propertyName: 'properties/123', assetRef: 'ga4:123' }];
  }
  const app = { version: 1, provider: 'google-oauth-client', clientId: 'fictitious.apps.googleusercontent.com', clientSecret: 'FICTITIOUS_CLIENT_SECRET' };
  const value = { version: 3, provider, connectionRef: binding.connectionRef, googleUserId: binding.oauth.subject,
    clientId: app.clientId, refreshToken: 'FICTITIOUS_NEW_REFRESH', scopes: [...binding.oauth.scopes] };
  const baseline = provider === PROVIDER ? { version: 2, provider, connectionRef: binding.connectionRef, refreshToken: 'FICTITIOUS_OLD_REFRESH', scopes: [SCOPE] }
    : { ...value, refreshToken: 'FICTITIOUS_OLD_REFRESH', scopes: [binding.oauth.scopes[3]] };
  const records = new Map([[secretArn, new Map([['baseline', { body: JSON.stringify(baseline), stages: new Set(['AWSCURRENT']) }]])],
    [appArn, new Map([['app-current', { body: JSON.stringify(app), stages: new Set(['AWSCURRENT']) }]])]]);
  const state = { calls: [], records, kms: config.kmsKeyArn, lostStage: false, lostActivate: false };
  const client = { async send(command) {
    const input = command.input; const kind = command.constructor.name; state.calls.push({ kind, input });
    assert(records.has(input.SecretId), 'Only the bound preallocated secret/app can be reached');
    const versions = records.get(input.SecretId);
    if (kind === 'DescribeSecretCommand') return { ARN: input.SecretId, KmsKeyId: state.kms };
    if (kind === 'GetSecretValueCommand') {
      const entry = input.VersionId ? [...versions].find(([id]) => id === input.VersionId) : [...versions].find(([,v]) => v.stages.has(input.VersionStage));
      if (!entry) throw Object.assign(Error('FICTITIOUS_AWS_INTERNAL'), { name: 'ResourceNotFoundException' });
      return { ARN: input.SecretId, VersionId: entry[0], VersionStages: [...entry[1].stages], SecretString: entry[1].body };
    }
    if (kind === 'PutSecretValueCommand') {
      await state.beforeStage?.();
      const old = versions.get(input.ClientRequestToken); if (old && old.body !== input.SecretString) throw Error('FICTITIOUS_IMMUTABLE_VERSION');
      if (!old) { for (const value of versions.values()) value.stages.delete('AWSPENDING'); versions.set(input.ClientRequestToken, { body: input.SecretString, stages: new Set(input.VersionStages) }); }
      if (state.lostStage) { state.lostStage = false; throw Error('FICTITIOUS_LOST_STAGE_ACK'); }
      return { ARN: input.SecretId, VersionId: input.ClientRequestToken, VersionStages: ['AWSPENDING'] };
    }
    assert.equal(kind, 'UpdateSecretVersionStageCommand');
    await state.beforeActivate?.();
    assert.equal(input.VersionStage, 'AWSCURRENT');
    const old = versions.get(input.RemoveFromVersionId); if (!old?.stages.has('AWSCURRENT')) throw Error('FICTITIOUS_CAS_CONFLICT');
    old.stages.delete('AWSCURRENT'); old.stages.add('AWSPREVIOUS'); versions.get(input.MoveToVersionId).stages.add('AWSCURRENT');
    if (state.lostActivate) { state.lostActivate = false; throw Error('FICTITIOUS_LOST_ACTIVATE_ACK'); }
    return { ARN: input.SecretId };
  } };
  return { config, binding, app, value, baseline, state, client, secrets: createGoogleOAuthSecrets({ client, ...config }) };
}
module.exports = { oauthSecretsFixture };
