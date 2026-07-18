'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  authenticatePublicIntakeRequest,
  createMetaSignatureValidator,
  pickMatchingIntakeConfig,
} = require('../../lib/intakePublicAuthentication');

const BODY = Buffer.from(JSON.stringify({ event_name: 'Lead', clinic_id: 66 }), 'utf8');
const SCOPED_SECRET = 'clinic-scope-secret-0123456789';
const GROUP_SECRET = 'group-scope-secret-0123456789';
const SERVER_SECRET = 'server-intake-secret-0123456789';
const META_SECRET = 'meta-app-secret-0123456789';

function hmac(secret, body = BODY) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function request({ body = BODY, signature = null, headers = {} } = {}) {
  return {
    rawBody: body,
    headers: {
      ...headers,
      ...(signature === null ? {} : { 'x-cc-signature': signature }),
    },
  };
}

test('Meta exige secreto configurado, raw body exacto y x-hub-signature-256 válida', () => {
  const validate = createMetaSignatureValidator({ appSecret: META_SECRET });
  const signature = `sha256=${hmac(META_SECRET)}`;

  assert.equal(validate(request({ headers: { 'x-hub-signature-256': signature } })), true);
  assert.equal(validate(request({ headers: { 'x-hub-signature': signature } })), false);
  assert.equal(validate(request()), false);
  assert.equal(validate(request({ body: Buffer.from('{"changed":true}'), headers: { 'x-hub-signature-256': signature } })), false);
  assert.equal(validate({ headers: { 'x-hub-signature-256': signature } }), false);
  assert.equal(createMetaSignatureValidator({ appSecret: '' })(request({ headers: { 'x-hub-signature-256': signature } })), false);
});

test('Meta solo permite omitir la firma mediante la dependencia de test explícita', () => {
  assert.equal(createMetaSignatureValidator({ allowUnsignedForTests: true })(request()), true);
  assert.equal(createMetaSignatureValidator({ allowUnsignedForTests: 1 })(request()), false);
  assert.equal(createMetaSignatureValidator({ allowUnsignedForTests: 'true' })(request()), false);
});

test('intake acepta la firma HMAC del scope y rechaza firma ausente o incorrecta', () => {
  const config = { id: 1, hmac_key: SCOPED_SECRET };
  assert.deepEqual(
    authenticatePublicIntakeRequest({ req: request({ signature: hmac(SCOPED_SECRET) }), config }),
    { ok: true, source: 'intake_config_hmac' }
  );
  assert.deepEqual(
    authenticatePublicIntakeRequest({
      req: request({ headers: { 'x-cc-signature-sha256': `sha256=${hmac(SCOPED_SECRET)}` } }),
      config,
    }),
    { ok: true, source: 'intake_config_hmac' }
  );
  for (const req of [
    request(),
    request({ signature: hmac('wrong-secret') }),
    { headers: { 'x-cc-signature': hmac(SCOPED_SECRET) } },
  ]) {
    const result = authenticatePublicIntakeRequest({ req, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'intake_signature_invalid');
  }
});

test('intake sin configuración solo acepta el HMAC server-side explícito', () => {
  assert.deepEqual(
    authenticatePublicIntakeRequest({
      req: request({ signature: hmac(SERVER_SECRET) }),
      config: null,
      fallbackSecret: SERVER_SECRET,
    }),
    { ok: true, source: 'server_hmac' }
  );

  const missing = authenticatePublicIntakeRequest({ req: request(), config: null, fallbackSecret: '' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 503);
  assert.equal(missing.code, 'intake_authentication_not_configured');

  const forgedArtifact = authenticatePublicIntakeRequest({
    req: request({ headers: { 'x-clinicaclick-web-artifact': 'a'.repeat(64) } }),
    config: null,
    fallbackSecret: '',
  });
  assert.equal(forgedArtifact.ok, false);
  assert.equal(forgedArtifact.status, 503);
});

test('el secreto global no puede saltarse un HMAC existente del scope', () => {
  const result = authenticatePublicIntakeRequest({
    req: request({ signature: hmac(SERVER_SECRET) }),
    config: { id: 1, hmac_key: SCOPED_SECRET },
    fallbackSecret: SERVER_SECRET,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, 'intake_signature_invalid');
});

test('un registro de clínica sin secreto no oculta un scope de grupo firmado', () => {
  const clinicCfg = { id: 1, assignment_scope: 'clinic', hmac_key: null };
  const groupCfg = { id: 2, assignment_scope: 'group', hmac_key: GROUP_SECRET };

  assert.equal(pickMatchingIntakeConfig({ req: request(), clinicCfg, groupCfg }), groupCfg);
  assert.equal(pickMatchingIntakeConfig({
    req: request({ signature: hmac(GROUP_SECRET) }),
    clinicCfg,
    groupCfg,
  }), groupCfg);

  const auth = authenticatePublicIntakeRequest({
    req: request({ signature: hmac(SERVER_SECRET) }),
    config: pickMatchingIntakeConfig({
      req: request({ signature: hmac(SERVER_SECRET) }),
      clinicCfg,
      groupCfg,
    }),
    fallbackSecret: SERVER_SECRET,
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

test('selecciona el candidato cuya firma coincide y conserva la precedencia sin secretos', () => {
  const clinicCfg = { id: 1, hmac_key: SCOPED_SECRET };
  const groupCfg = { id: 2, hmac_key: GROUP_SECRET };
  assert.equal(pickMatchingIntakeConfig({
    req: request({ signature: hmac(GROUP_SECRET) }),
    clinicCfg,
    groupCfg,
  }), groupCfg);

  const unsignedClinic = { id: 3, hmac_key: null };
  const unsignedGroup = { id: 4, hmac_key: null };
  assert.equal(pickMatchingIntakeConfig({ req: request(), clinicCfg: unsignedClinic, groupCfg: unsignedGroup }), unsignedClinic);
  assert.equal(pickMatchingIntakeConfig({ req: request() }), null);
});

test('los tres handlers públicos aplican el gate y el webhook Meta usa el validador estricto', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8'
  );
  assert.equal(
    (source.match(/authenticatePublicIntakeRequest\(\{/g) || []).length,
    3,
    '/leads, /whatsapp-origin y /events deben aplicar el mismo gate público'
  );
  const handlerBoundaries = [
    ['exports.ingestLead', 'exports.registerWhatsappOrigin'],
    ['exports.registerWhatsappOrigin', 'exports.receiveIntakeEvent'],
    ['exports.receiveIntakeEvent', 'exports.verifyMetaWebhook'],
  ];
  for (const [startMarker, endMarker] of handlerBoundaries) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `${startMarker} no se pudo aislar`);
    assert.match(
      source.slice(start, end),
      /authenticatePublicIntakeRequest\(\{[\s\S]*?fallbackSecret: process\.env\.INTAKE_WEB_SECRET/,
      `${startMarker} debe fallar cerrado con el gate común`
    );
  }
  assert.match(source, /const validateMetaSignature = createMetaSignatureValidator\(\{\s*appSecret: process\.env\.META_APP_SECRET,\s*\}\);/);
  assert.doesNotMatch(source, /allowUnsignedForTests/,
    'el controller real no debe activar el bypass reservado para dependencias de test');
  assert.match(source, /exports\.receiveMetaWebhook[\s\S]*?if \(!validateMetaSignature\(req\)\) \{\s*return res\.status\(401\)/);
});
