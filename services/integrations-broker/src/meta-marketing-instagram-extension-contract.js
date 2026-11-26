'use strict';

const { schema } = require('./contracts');
const { fail } = require('./errors');
const C = require('./meta-marketing-oauth-contract');
const M = require('./meta-marketing-contract');
const E = require('./meta-marketing-enrollment-contract');
const { scopeKey: validScope } = require('./meta-marketing-admission-contract');

const OPERATIONS = Object.freeze(Object.fromEntries(['begin', 'finish', 'status', 'confirm', 'abort']
  .map(name => [name, 'meta.marketing.instagram.extension.' + name + '.v1'])));
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const id = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const state = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const pins = { enrollmentId: uuid, parentPageId: id, assetSetDigest: digest, epoch: integer, versionId: uuid, credentialDigest: digest };
const validators = {
  begin: schema({ ...pins, state, expiresAt: integer }),
  finish: schema({ flowId: uuid, state, code: { type: 'string', pattern: '^[\\x21-\\x7e]{1,4096}$' } }),
  status: schema({ flowId: uuid }),
  confirm: schema({ flowId: uuid, candidateDigest: digest, instagramId: id }),
  abort: schema({ flowId: uuid }),
};

function clinicId(scopeKey) {
  const id = typeof scopeKey === 'string' && /^clinic:[1-9][0-9]{0,9}$/.test(scopeKey) ? Number(scopeKey.slice(7)) : 0;
  if (id < 1 || id > 2147483647) fail('invalid_request');
  return id;
}

function config(value, environment, account) {
  if (!C.exact(value, 'scopeKey,parentPageId,secretArn,slotVersionId,expiresAt')
      || !['dev', 'staging'].includes(environment) || !/^\d{12}$/.test(account)
      || !validScope(value.scopeKey) || !M.graphId(value.parentPageId) || !/^[A-Za-z0-9-]{32,64}$/.test(value.slotVersionId)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) fail('invalid_request');
  const owner = value.scopeKey.replace(':', '-');
  const prefix = 'arn:aws:secretsmanager:eu-west-3:' + account + ':secret:/clinicaclick/integrations/prod/meta-marketing/'
    + environment + '/instagram-extension/' + owner;
  const paths = [prefix + '/page-' + value.parentPageId + '/candidate-'];
  if (value.scopeKey.startsWith('clinic:')) paths.push(prefix + '/candidate-');
  if (typeof value.secretArn !== 'string' || !paths.some(path => value.secretArn.startsWith(path)
      && /^[A-Za-z0-9]{6}$/.test(value.secretArn.slice(path.length)))) {
    fail('invalid_request');
  }
  return Object.freeze({ ...value });
}

function targets(value, environment, account) {
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.length || entries.length > 1000) fail('invalid_request');
  const checked = entries.map(entry => config(entry, environment, account));
  if (new Set(checked.map(entry => entry.secretArn)).size !== checked.length
      || new Set(checked.map(entry => entry.parentPageId)).size !== checked.length) fail('invalid_request');
  return checked;
}

function derive(base, settings) {
  const original = C.bindingFor(base);
  if (original.scopeKey !== settings.scopeKey || !original.scopes.includes('pages_read_engagement')
      || [base.secretArn, base.clientSecretArn].includes(settings.secretArn)) fail('scope_denied');
  const binding = { ...base, secretArn: settings.secretArn, expiresAt: Math.min(base.expiresAt, settings.expiresAt),
    metaMarketingOAuth: { ...original, slotVersionId: settings.slotVersionId, scopes: [...new Set([...original.scopes, 'instagram_basic'])].sort() } };
  C.bindingFor(binding);
  return binding;
}

function authorize({ request, principal, binding }, environment, settings) {
  const roles = E.roles(environment);
  const active = C.bindingFor(binding);
  if (active.scopeKey !== settings?.scopeKey || request.tenantRef !== 'clinic:' + active.clinicIds[0]
      || request.assetRef !== 'meta-enroll:' + settings.scopeKey || request.connectionRef !== binding.connectionRef
      || (principal.id !== roles.gateway && !(principal.id === roles.control && [OPERATIONS.abort, OPERATIONS.status].includes(request.operation)))) {
    fail('scope_denied');
  }
}

module.exports = { OPERATIONS, validators, clinicId, config, targets, derive, authorize };
