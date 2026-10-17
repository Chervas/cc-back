'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const branding = require('../../lib/consent-document-branding');
const sharedAvatar = require('../../services/clinicBranding.service');
const tabletAvatar = () => require('../../services/consentTabletBranding.service');
const clinic = { id_clinica: 72, nombre_clinica: 'BS Medical', grupoClinicaId: 50, url_avatar: null,
  configuracion: { timezone: 'Europe/Madrid', private_value: 'not a public DTO' } };
const group = { id_grupo: 50, nombre_grupo: 'BS Medical & Capilar' };
const configured = value => ({ ...clinic, configuracion: { ...clinic.configuracion,
  patient_intake: { tablet_branding: value } } });
const googleUrl = 'https://cdn.clinicaclick.com/effective-google-avatar.png';
function localSharedResolver() {
  const reads = [];
  return { reads, resolveAvatar: input => sharedAvatar.resolveClinicAvatar(input, {
    resolveEffectiveLocations: async id => {
      reads.push(id);
      return { locations: [{ raw_payload: { clinicaclick_media_items: [
        { category: 'COVER', googleUrl: 'https://cdn.clinicaclick.com/not-the-logo.png' },
        { locationAssociation: { category: 'LOGO' }, googleUrl },
      ] } }] };
    },
  }) };
}

test('tablet and clinic list share the effective local avatar resolver, without persisting the fallback', async () => {
  const f = localSharedResolver(), before = JSON.stringify(clinic);
  const effective = await tabletAvatar().effectiveClinicAvatar(clinic, f);
  assert.notEqual(effective, clinic); assert.equal(effective.url_avatar, googleUrl);
  assert.equal(JSON.stringify(clinic), before);
  assert.deepEqual(f.reads, [72], 'Only the effective assignment for this clinic is consulted');
  const expected = branding.resolveTabletBranding(effective, group);
  const resolved = await tabletAvatar().resolveTabletBrandingForClinic(clinic, group, f);
  assert.deepEqual(resolved, expected); assert.equal(resolved.logo_url, googleUrl);
  assert.equal(resolved.logo_background, 'light');
  assert.equal(JSON.stringify(clinic), before);
});

test('an explicitly configured clinic avatar remains the exact default used by the tablet', async () => {
  const f = localSharedResolver(), input = { ...clinic, url_avatar: 'https://cdn.clinicaclick.com/custom-avatar.png' };
  const result = await tabletAvatar().resolveTabletBrandingForClinic(input, group, f);
  assert.equal(result.logo_url, input.url_avatar); assert.deepEqual(f.reads, [], 'No Google lookup is needed for a configured avatar');
});

test('valid manual tablet override short-circuits avatar lookup; clearing it restores the live default', async () => {
  const f = localSharedResolver(), manual = 'https://cdn.clinicaclick.com/manual-tablet-logo.png';
  const input = configured({ source: 'clinic', logo_url: manual, logo_background: 'dark' }), before = JSON.stringify(input);
  const result = await tabletAvatar().resolveTabletBrandingForClinic(input, group, f);
  assert.equal(result.logo_url, manual); assert.equal(result.logo_background, 'dark'); assert.deepEqual(f.reads, []);
  assert.equal(JSON.stringify(input), before);
  const cleared = configured({ source: 'clinic', logo_url: null, logo_background: 'light' });
  assert.equal((await tabletAvatar().resolveTabletBrandingForClinic(cleared, group, f)).logo_url, googleUrl);
  assert.deepEqual(f.reads, [72]);
});

test('a group identity never reads or borrows a member clinic avatar, even when one exists', async () => {
  const f = localSharedResolver(), input = { ...configured({ source: 'group', logo_url: null, logo_background: 'light' }),
    url_avatar: 'https://cdn.clinicaclick.com/clinic-only.png' };
  assert.deepEqual(await tabletAvatar().resolveTabletBrandingForClinic(input, group, f), {
    source: 'group', display_name: group.nombre_grupo, logo_url: null, logo_background: 'light',
  });
  input.configuracion.patient_intake.tablet_branding.logo_url = 'https://cdn.clinicaclick.com/group-only.png';
  assert.equal((await tabletAvatar().resolveTabletBrandingForClinic(input, group, f)).logo_url,
    input.configuracion.patient_intake.tablet_branding.logo_url);
  assert.deepEqual(f.reads, []);
});

test('a stale or foreign group configuration returns to the authorized clinic live avatar, never the group override', async () => {
  for (const foreign of [null, { id_grupo: 999, nombre_grupo: 'Foreign group' }]) {
    const f = localSharedResolver(), input = configured({ source: 'group',
      logo_url: 'https://cdn.clinicaclick.com/group-only.png', logo_background: 'dark' });
    const result = await tabletAvatar().resolveTabletBrandingForClinic(input, foreign, f);
    assert.equal(result.source, 'clinic'); assert.equal(result.display_name, clinic.nombre_clinica);
    assert.equal(result.logo_url, googleUrl); assert.deepEqual(f.reads, [72]);
  }
});

test('unavailable avatars stay absent on tablets without importing the historical Word logo', async () => {
  for (const url of [null, 'javascript:alert(1)', 'http://127.0.0.1/logo', 'https://localhost/logo']) {
    const result = await tabletAvatar().resolveTabletBrandingForClinic(clinic, group,
      { resolveAvatar: async () => ({ url, source: url ? 'google_business_profile' : null }) });
    assert.equal(result.logo_url, null); assert.equal(result.logo_background, 'light');
  }
  const unavailable = await tabletAvatar().resolveTabletBrandingForClinic(clinic, group,
    { resolveAvatar: async () => { throw Error('owned inventory unavailable'); } });
  assert.equal(unavailable.logo_url, null, 'Missing local branding cannot prevent the consent from opening');
});

test('an unsafe legacy manual logo cannot hide the valid effective clinic avatar', async () => {
  const f = localSharedResolver(), input = configured({ source: 'clinic',
    logo_url: 'javascript:alert(1)', logo_background: 'light' });
  const result = await tabletAvatar().resolveTabletBrandingForClinic(input, group, f);
  assert.equal(result.logo_url, googleUrl); assert.deepEqual(f.reads, [72]);
});

test('Sequelize-backed input and frozen signed document branding remain byte-for-byte unchanged', async () => {
  const document = { snapshot_hash: 'frozen', snapshot_json: {
    document_branding: branding.buildDocumentBranding(clinic, { purpose: 'data_protection' }) } };
  const before = JSON.stringify({ clinic, document }), f = localSharedResolver();
  const model = { toJSON: () => clinic };
  const result = await tabletAvatar().resolveTabletBrandingForClinic(model, group, f);
  assert.equal(result.logo_url, googleUrl);
  assert.equal(JSON.stringify({ clinic, document }), before);
  assert.equal(document.snapshot_json.document_branding.logos.length, 2, 'Frozen legal evidence keeps both original source marks');
});
