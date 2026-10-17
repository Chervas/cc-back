'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const branding = require('../../lib/consent-document-branding');
const config = require('../../lib/registration-privacy-configuration');
const clinic = { id_clinica: 72, nombre_clinica: 'BS Medical', grupoClinicaId: 50,
  url_avatar: 'https://cdn.clinicaclick.com/medical.png' };
const configured = value => ({ ...clinic, configuracion: { patient_intake: { tablet_branding: value } } });
test('tablet uses one own clinic logo, not the two-document snapshot marks', () => {
  assert.deepEqual(branding.resolveTabletBranding(clinic), { display_name: 'BS Medical', source: 'clinic',
    logo_url: clinic.url_avatar, logo_background: 'light' });
  const fallback = branding.resolveTabletBranding({ ...clinic, url_avatar: null });
  assert.equal(fallback.logo_url, null, 'A missing live avatar is not replaced by the low-resolution Word mark');
  assert.equal(fallback.logo_background, 'light');
  for (const id_clinica of [66, 72, 999]) {
    assert.equal(branding.resolveTabletBranding({ ...clinic, id_clinica, url_avatar: null }).logo_url, null);
  }
});
test('a manual tablet logo wins, clearing it returns to the effective clinic avatar without mutating it', () => {
  const manual = 'https://cdn.clinicaclick.com/manual-tablet.png';
  const input = configured({ source: 'clinic', logo_url: manual, logo_background: 'dark' });
  const before = JSON.stringify(input);
  assert.deepEqual(branding.resolveTabletBranding(input), { display_name: clinic.nombre_clinica,
    source: 'clinic', logo_url: manual, logo_background: 'dark' });
  assert.equal(JSON.stringify(input), before, 'Presentation must not persist the manual image as the clinic avatar');
  const cleared = configured({ source: 'clinic', logo_url: null, logo_background: 'light' });
  assert.deepEqual(branding.resolveTabletBranding(cleared), { display_name: clinic.nombre_clinica,
    source: 'clinic', logo_url: clinic.url_avatar, logo_background: 'light' });
});
test('unsafe or unavailable live avatars produce an icon rather than a historical Word fallback', () => {
  for (const url_avatar of [null, '', 'javascript:alert(1)', 'http://127.0.0.1/logo',
    'https://localhost/logo', 'https://cdn.clinicaclick.com/logo#token']) {
    assert.deepEqual(branding.resolveTabletBranding({ ...clinic, url_avatar }), {
      display_name: clinic.nombre_clinica, source: 'clinic', logo_url: null, logo_background: 'light',
    });
  }
});
test('group identity requires actual membership and never borrows another clinic logo', () => {
  const input = configured({ source: 'group', logo_url: null, logo_background: 'light' });
  const group = { id_grupo: 50, nombre_grupo: 'BS Medical & Capilar' };
  assert.deepEqual(branding.resolveTabletBranding(input, group), { display_name: group.nombre_grupo,
    source: 'group', logo_url: null, logo_background: 'light' });
  assert.equal(branding.resolveTabletBranding({ ...input, url_avatar: branding.SOURCE_LOGOS[0].url }, group).logo_url,
    null, 'A group without its own image cannot borrow either live or Word clinic logos');
  const manual = configured({ source: 'group', logo_url: 'https://cdn.clinicaclick.com/group.png', logo_background: 'dark' });
  assert.deepEqual(branding.resolveTabletBranding(manual, group), { display_name: group.nombre_grupo,
    source: 'group', logo_url: 'https://cdn.clinicaclick.com/group.png', logo_background: 'dark' });
  for (const foreign of [null, { ...group, id_grupo: 99 }]) {
    const result = branding.resolveTabletBranding(manual, foreign);
    assert.equal(result.source, 'clinic'); assert.equal(result.display_name, clinic.nombre_clinica);
    assert.equal(result.logo_url, clinic.url_avatar);
  }
});
test('new identity configuration validates URLs and participates in the same optimistic lock', () => {
  const value = { source: 'group', logo_url: 'https://cdn.clinicaclick.com/group.png', logo_background: 'dark' };
  assert.deepEqual(config.validate({ tablet_branding: value }), { tablet_branding: value });
  assert.notEqual(config.version(clinic), config.version(configured(value)));
  for (const invalid of [null, [], {}, { ...value, extra: true }, { ...value, source: 'other' },
    { ...value, logo_background: 'red' }, { ...value, logo_url: 'http://127.0.0.1/logo' },
    { ...value, logo_url: 'javascript:alert(1)' }, { ...value, logo_url: 'https://cdn.clinicaclick.com/logo#token' }]) {
    assert.throws(() => config.validate({ tablet_branding: invalid }), /tablet_branding_invalid/);
  }
});
test('live tablet identity leaves historical document branding byte-for-byte intact', () => {
  const document = { snapshot_json: { document_branding: branding.buildDocumentBranding(clinic, { purpose: 'data_protection' }) } };
  const before = JSON.stringify(document);
  const changed = configured({ source: 'group', logo_url: 'https://cdn.clinicaclick.com/group.png', logo_background: 'dark' });
  branding.resolveTabletBranding(changed, { id_grupo: 50, nombre_grupo: 'Nuevo nombre' });
  assert.equal(JSON.stringify(document), before);
  assert.equal(branding.brandingFromSnapshot(document).logos.length, 2);
});

test('settings defaults resolve live clinic/group sources without the persisted override or mutating the input', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../controllers/patientIntakeSettings.controller'), 'utf8');
  const block = source.slice(source.indexOf('async function previewBranding('), source.indexOf('\nasync function authorize('));
  assert(block.startsWith('async function previewBranding('));
  const preview = vm.runInNewContext(block + '\npreviewBranding', { config, documentBranding: branding, process: { env: {} },
    require: name => {
      assert.equal(name, '../services/consentTabletBranding.service');
      return { effectiveClinicAvatar: async value => ({ ...value, url_avatar: branding.safeLogoUrl(value?.url_avatar) }) };
    } });
  const input = configured({ source: 'group', logo_url: 'https://cdn.clinicaclick.com/override.png', logo_background: 'dark' });
  const group = { id_grupo: 50, nombre_grupo: 'Grupo de prueba' }, before = JSON.stringify(input);
  const resolved = await preview(input, group);
  assert.equal(resolved.tablet_branding.logo_url, 'https://cdn.clinicaclick.com/override.png');
  assert.deepEqual(JSON.parse(JSON.stringify(resolved.tablet_branding_defaults)), {
    clinic: { display_name: clinic.nombre_clinica, source: 'clinic', logo_url: clinic.url_avatar, logo_background: 'light' },
    group: { display_name: group.nombre_grupo, source: 'group', logo_url: null, logo_background: 'light' },
  });
  assert.equal(JSON.stringify(input), before);
  assert.equal((await preview({ ...input, grupoClinicaId: null }, null)).tablet_branding_defaults.group, null);
  assert.deepEqual(JSON.parse(JSON.stringify((await preview({ ...input, url_avatar: null }, group)).tablet_branding_defaults.clinic)), {
    display_name: clinic.nombre_clinica, source: 'clinic', logo_url: null, logo_background: 'light',
  }, 'A cleared clinic avatar must not expose the Word source image as its Settings default');
});
