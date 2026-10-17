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
  assert.equal(fallback.logo_url, branding.SOURCE_LOGOS.find(row => row.clinic_id === 72).url);
  assert.equal(fallback.logo_background, 'dark');
});
test('group identity requires actual membership and never borrows another clinic logo', () => {
  const input = configured({ source: 'group', logo_url: null, logo_background: 'light' });
  const group = { id_grupo: 50, nombre_grupo: 'BS Medical & Capilar' };
  assert.deepEqual(branding.resolveTabletBranding(input, group), { display_name: group.nombre_grupo,
    source: 'group', logo_url: null, logo_background: 'light' });
  for (const foreign of [null, { ...group, id_grupo: 99 }]) {
    const result = branding.resolveTabletBranding(input, foreign);
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
