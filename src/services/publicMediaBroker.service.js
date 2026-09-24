'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const L = require('../../services/integrations-broker/src/public-media-limits');

let cached;

function privateFile(filename) {
  if (!filename || !path.isAbsolute(filename) || !fs.existsSync(filename) || fs.realpathSync(filename) !== filename
    || fs.lstatSync(filename).isSymbolicLink()) {
    throw Object.assign(new Error('public_media_broker_configuration_invalid'), { status: 503 });
  }
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()
    || stat.mode & 0o077 || stat.size < 1 || stat.size > 1048576) {
    throw Object.assign(new Error('public_media_broker_configuration_invalid'), { status: 503 });
  }
  return fs.readFileSync(filename);
}

function config(env = process.env) {
  const enabled = env.PUBLIC_MEDIA_BROKER_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  const environment = String(env.PUBLIC_MEDIA_BROKER_ENVIRONMENT || '').trim();
  const connectionRef = String(env.PUBLIC_MEDIA_BROKER_CONNECTION_REF || '').trim();
  if (!['dev', 'staging', 'prod'].includes(environment) || connectionRef !== `public-media:${environment}`) {
    throw Object.assign(new Error('public_media_broker_configuration_invalid'), { status: 503 });
  }
  return { enabled, environment, connectionRef, origin: env.PUBLIC_MEDIA_BROKER_ORIGIN,
    audience: env.PUBLIC_MEDIA_BROKER_AUDIENCE, keyId: env.PUBLIC_MEDIA_BROKER_KEY_ID,
    keyFile: env.PUBLIC_MEDIA_BROKER_KEY_FILE, caFile: env.PUBLIC_MEDIA_BROKER_CA_FILE };
}

function client(env = process.env) {
  const value = config(env);
  if (!value.enabled) return null;
  if (!cached) cached = createIntegrationsBrokerClient({ origin: value.origin, audience: value.audience, keyId: value.keyId,
    privateKey: privateFile(value.keyFile), ca: privateFile(value.caFile), timeoutMs: 30000, transportProfile: 'public-media' });
  return { value, transport: cached };
}

function scope(input) {
  if (String(input.scope || input.scopeType || '').trim() === 'catalog') {
    if (Number(input.clinicId || input.clinica_id || input.groupId || input.grupo_clinica_id || 0)) {
      throw Object.assign(new Error('public_media_scope_ambiguous'), { status: 400 });
    }
    return { type: 'catalog', id: 1 };
  }
  const clinicId = Number(input.clinicId || input.clinica_id || 0);
  const groupId = Number(input.groupId || input.grupo_clinica_id || 0);
  if (Number.isInteger(clinicId) && clinicId > 0 && !groupId) return { type: 'clinic', id: clinicId };
  if (Number.isInteger(groupId) && groupId > 0 && !clinicId) return { type: 'group', id: groupId };
  throw Object.assign(new Error('public_media_scope_required'), { status: 400 });
}

async function uploadEmailImage(input, { env = process.env, requestId = randomUUID() } = {}) {
  const broker = client(env);
  if (!broker) throw Object.assign(new Error('public_media_broker_required'), { status: 503 });
  if (input.purpose !== 'marketing_image' || !Buffer.isBuffer(input.buffer)) {
    throw Object.assign(new Error('public_media_broker_input_invalid'), { status: 400 });
  }
  const target = scope(input);
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const ref = `${target.type}:${target.id}`;
  const response = await broker.transport.execute({ requestId, operation: L.OPERATIONS.PUT_EMAIL_IMAGE,
    tenantRef: ref, connectionRef: broker.value.connectionRef, assetRef: `public-media:${ref}`, payload: {
      scopeType: target.type, scopeId: target.id, purpose: 'marketing_image', contentType: input.contentType,
      dataBase64: input.buffer.toString('base64'), sha256,
    } }, { timeoutMs: 30000 });
  return response.data;
}

function enabled(env = process.env) { return config(env).enabled; }
function resetForTests() { cached = null; }

module.exports = { enabled, resetForTests, uploadEmailImage, __testing: { scope } };
