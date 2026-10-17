'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const branding = require('../../lib/consent-document-branding');
const clinic = (id = 72) => ({ id_clinica: id, nombre_clinica: id === 72 ? 'BS Medical' : 'BS Capilar',
  url_web: 'https://bsmedical.es/', direccion: 'Dirección de la clínica', email: 'recepcion@clinica.es',
  configuracion: { patient_intake: { privacy_controller: { legal_name: 'INSTITUTO OBES ALICANTE S.L.',
    tax_id: 'B54847090', address: 'C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE', phone: '966283955',
    email: 'info@bsmedical.es', dpo_email: 'dpo@bsmedical.es' } } } });
test('new LOPD uses both exact standalone source logos, not a screenshot of the document', () => {
  assert.equal(branding.SOURCE_DOCUMENT_SHA256, 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f');
  for (const id of [66, 72]) {
    const result = branding.buildDocumentBranding(clinic(id), { purpose: 'data_protection' });
    assert.deepEqual(result.logos.map(logo => logo.alt), ['BS Medical', 'BS Capilar']);
    assert.deepEqual(result.logos.map(logo => logo.background), ['dark', 'light']);
  }
  for (const logo of branding.SOURCE_LOGOS) {
    const bytes = Buffer.from(logo.url.split(',')[1], 'base64');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), logo.source_image_sha256);
    assert(bytes.length < 2000);
  }
});
test('other documents use their own registered logo or their exact BS source fallback', () => {
  for (const id of [66, 72]) {
    assert.deepEqual(branding.buildDocumentBranding(clinic(id), { purpose: 'other' }).logos.map(logo => logo.alt),
      [id === 72 ? 'BS Medical' : 'BS Capilar']);
  }
  const custom = { ...clinic(), id_clinica: 99, nombre_clinica: 'Otra clínica', url_avatar: 'https://cdn.clinicaclick.com/own/logo.png' };
  assert.equal(branding.buildDocumentBranding(custom).logos[0].url, custom.url_avatar);
  assert.equal(branding.buildDocumentBranding({ ...custom, url_avatar: null }).logos.length, 0);
});
test('footer is public clinic/controller data and never invents new legal clauses or patient information', () => {
  const result = branding.buildDocumentBranding({ ...clinic(), paciente: { nombre: 'Do not publish me' },
    datos_fiscales_clinica: { iban: 'Do not publish this either' } });
  assert.deepEqual(result.footer_lines, ['INSTITUTO OBES ALICANTE S.L. · CIF / NIF: B54847090',
    'C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE', '966283955 · info@bsmedical.es', 'DPO: dpo@bsmedical.es', 'https://bsmedical.es/']);
  assert(!JSON.stringify(result).includes('Do not publish'));
});
test('logo and footer can be hidden, while name remains an honest identity fallback', () => {
  const configuration = { schema_version: branding.SCHEMA, show_logo: false, show_footer: false };
  const result = branding.buildDocumentBranding(clinic(), { configuration, purpose: 'data_protection' });
  assert.equal(result.clinic_name, 'BS Medical'); assert.deepEqual(result.logos, []); assert.deepEqual(result.footer_lines, []);
  for (const invalid of [{}, { ...configuration, logo_url: 'https://untrusted.com/image.png' },
    { ...configuration, show_logo: 'yes' }, [], false]) assert.throws(() => branding.validateDocumentBrandingConfig(invalid), /branding_invalid/);
});
test('logo URLs reject active data, local networks, relative host escapes, credentials and nonstandard ports', () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,arbitrary',
    'http://cdn.clinicaclick.com/logo.png', 'https://localhost/logo.png', 'https://127.0.0.1/logo.png',
    'https://2130706433/logo.png', 'https://0x7f000001/logo.png', 'https://10.0.0.1/a', 'https://172.19.0.1/a',
    'https://192.168.1.1/a', 'https://169.254.169.254/latest', 'https://100.64.0.1/a', 'https://[::1]/a',
    'https://cdn.clinicaclick.com:3001/logo.png', 'https://user:secret@cdn.clinicaclick.com/a', '//evil.com/a',
    'https://cdn.clinicaclick.com/a#fragment', '/\\evil.com/a']) assert.equal(branding.safeLogoUrl(url), null, url);
  assert.equal(branding.safeLogoUrl('/uploads/logos/own.png', 'https://crm.clinicaclick.com'), 'https://crm.clinicaclick.com/uploads/logos/own.png');
  assert.equal(branding.safeLogoUrl('/uploads/logos/own.png', 'http://localhost:4203'), null);
  assert.equal(branding.safeLogoUrl('https://encrypted-tbn0.gstatic.com/images?q=registered'), 'https://encrypted-tbn0.gstatic.com/images?q=registered');
});
test('historical snapshots without a branding DTO are not reinterpreted from current clinic data', () => {
  assert.equal(branding.brandingFromSnapshot({ snapshot_json: { context: { clinica: clinic() } } }), null);
  const frozen = branding.buildDocumentBranding(clinic(), { purpose: 'data_protection' });
  const doc = { snapshot_json: { document_branding: frozen }, clinica: { ...clinic(), nombre_clinica: 'Changed now' } };
  assert.deepEqual(branding.brandingFromSnapshot(doc), frozen);
  const copy = branding.brandingFromSnapshot(doc); copy.logos[0].alt = 'Changed'; copy.footer_lines[0] = 'Changed';
  assert.notEqual(frozen.logos[0].alt, 'Changed'); assert.notEqual(frozen.footer_lines[0], 'Changed');
});
test('HTML renders semantic safe header/footer and validates frozen URLs again on read', () => {
  const source = branding.buildDocumentBranding({ ...clinic(), nombre_clinica: '<script>bad</script>' }, { purpose: 'other' });
  source.footer_lines = ['<img src=x onerror=alert(1)>'];
  assert.match(branding.renderDocumentBrandingHtml(source), /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(branding.renderDocumentBrandingHtml(source), /consent-clinic-logo-frame on-dark/);
  assert.match(branding.renderDocumentBrandingHtml(source, 'footer'), /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(branding.renderDocumentBrandingHtml(source, 'other'), '');
  source.logos[0].url = 'javascript:alert(1)';
  assert.equal(branding.normalizeDocumentBranding(source), null); assert.equal(branding.renderDocumentBrandingHtml(source), '');
});
