'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attribute, snippetTagsInHtml, detectGoogleTags, readStoredWebEvidence, buildWebDiagnostics } = require('../../lib/intake-web-diagnostics');
const Op = { in: Symbol('in'), or: Symbol('or'), between: Symbol('between') };
const nowMs = Date.parse('2026-10-28T12:00:00Z');
const checkedUrl = 'https://example.test/';
const ownAsset = (src) => new URL(src, checkedUrl).hostname === 'crm.clinicaclick.com';
const loader = '<script src="https://crm.clinicaclick.com/assets/loader.js" data-group-id="5" data-event-bridge-url="/_clinicaclick/events"></script>';
const params = { Op, scopeType: 'group', scopeId: 5, clinicId: null, domain: 'www.example.test', locationIds: [19, 35, 56, 58, 59], nowMs };

test('GA4 directo y tres contenedores: referencias, nunca duplicados confirmados', () => {
  const d = detectGoogleTags(`
    <script src="https://www.googletagmanager.com/gtag/js?id=G-ABCD1234"></script>
    <script>gtag('config', 'G-ABCD1234'); gtag('config', 'AW-123456789');</script>
    <script>(function(w,d,s,l,i){j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-WVTTNV35');</script>
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-NBG5MD56"></script>
    <script src="//www.googletagmanager.com/gtm.js?id=GTM-WKVGKK8"></script>
  `, checkedUrl);
  assert.deepEqual(d.gtm_container_ids, ['GTM-NBG5MD56', 'GTM-WKVGKK8', 'GTM-WVTTNV35']);
  assert.deepEqual(d.ga4_measurement_ids, ['G-ABCD1234']);
  assert.deepEqual(d.ads_tag_ids, ['AW-123456789']);
  assert.equal(d.overlap_review_recommended, true);
  assert.equal(d.duplication, 'not_assessed');
  assert.equal(d.execution, 'not_verified');
  assert.equal(d.ga4_bridge, 'not_configured');
});

test('IDs editoriales, comentarios, JSON, plantillas, dominios parecidos y consent no son instalaciones', () => {
  const d = detectGoogleTags(`
    <p>GTM-ABCD1234 G-ABCD1234</p>
    <!-- <script>gtag('config', 'G-COMMENT');</script> -->
    <template><script>gtag('config', 'G-TEMPLATE');</script></template>
    <script type="application/ld+json">{"example":"gtag('config', 'G-JSON1234')"}</script>
    <script>// gtag('config', 'G-COMMENT');
      /* gtag('config', 'G-COMMENT'); */
      const example = "gtag('config', 'G-QUOTED1234')";
      window.dataLayer=[]; gtag('consent', 'default', {analytics_storage:'denied'});
    </script>
    <script src="https://www.googletagmanager.com.evil.test/gtm.js?id=GTM-EVIL1234"></script>
    <script src="https://example.test/gtag/js?id=G-ABCD1234"></script>
  `, checkedUrl);
  assert.deepEqual(d.gtm_container_ids, []);
  assert.deepEqual(d.ga4_measurement_ids, []);
  assert.equal(d.overlap_review_recommended, false);
});

test('etiquetas diferidas y Google tag genérico conservan incertidumbre', () => {
  const d = detectGoogleTags('<script type="text/plain" data-src="https://www.googletagmanager.com/gtag/js?l=custom&amp;id=GT-ABCD1234"></script>', checkedUrl);
  assert.deepEqual(d.google_tag_ids, ['GT-ABCD1234']);
  assert.equal(d.deferred_tags_present, true);
  assert.equal(d.execution, 'not_verified');
});

test('snippet exige src real, origen propio y script ejecutable; ID exacto, no prefijo', () => {
  const fake = loader.replace('data-group-id="5"', 'data-group-id="56"');
  const tags = snippetTagsInHtml(`<!--${loader}--><template>${loader}</template>
    ${loader.replace('src=', 'data-src=')}${loader.replace('crm.clinicaclick.com', 'other.test')}
    ${loader.replace('<script ', '<script type="text/plain" ')}${fake}`, checkedUrl, ownAsset);
  assert.equal(tags.length, 1);
  assert.equal(attribute(tags[0], 'data-group-id'), '56');
  assert.equal(attribute('<script data-src="fake" src=real data-group-id=5>', 'src'), 'real');
});

test('plugin conectado sin loader ni actividad sigue siendo una instalación no visible', async () => {
  const stored = await readStoredWebEvidence({ ...params, models: {
    WebWordpressInstallation: { findAll: async (q) => {
      assert.deepEqual(q.attributes, ['siteUrl', 'status', 'pluginVersion', 'lastSeenAt']);
      assert.deepEqual(q.where, { scopeType: 'group', grupoClinicaId: 5 });
      return [{ siteUrl: checkedUrl, status: 'connected', pluginVersion: '2.0.0-alpha.11', lastSeenAt: new Date(nowMs - 3600000), tokenHash: 'SECRET' }];
    } }, WebEvent: { max: async () => null },
  } });
  const d = buildWebDiagnostics({ html: '<html></html>', checkedUrl, stored, nowMs, isAllowedAssetUrl: ownAsset, expectedAttr: 'data-group-id', expectedId: 5, evaluation: { reason: 'missing_snippet' } });
  assert.equal(d.plugin.status, 'connected');
  assert.equal(d.plugin.recent_contact, true);
  assert.equal(d.installation.loader_visible, false);
  assert.equal(d.runtime.status, 'unverified');
  assert.equal(d.activity.status, 'no_recent_activity');
  assert.doesNotMatch(JSON.stringify(d), /SECRET|tokenHash|siteUrl/);
});

test('actividad agregada por dominio, grupo y sedes configuradas, con fecha de recepción servidor', async () => {
  const stored = await readStoredWebEvidence({ ...params, models: { WebEvent: { max: async (column, { where }) => {
    assert.equal(column, 'created_at');
    assert.equal(where.group_id, 5);
    assert.deepEqual(where.domain[Op.in], ['example.test', 'www.example.test']);
    assert.deepEqual(where[Op.or], [{ clinic_id: null }, { clinic_id: { [Op.in]: [19, 35, 56, 58, 59] } }]);
    assert.equal(where.created_at[Op.between][0].toISOString(), '2026-10-27T12:00:00.000Z');
    assert.ok(where.event_type[Op.in].includes('consent_update'));
    return new Date(nowMs - 1000);
  } } } });
  assert.deepEqual(stored.activity, { status: 'received', window_hours: 24, last_received_at: '2026-10-28T11:59:59.000Z', source: 'stored_web_events' });
});

test('clínica con configuración de grupo no ve actividad de otras sedes', async () => {
  await readStoredWebEvidence({ ...params, clinicId: 56, models: { WebEvent: { max: async (_column, { where }) => {
    assert.equal(where.clinic_id, 56);
    assert.equal(where.group_id, 5);
    assert.equal(where[Op.or], undefined);
    return null;
  } } } });
});

test('scope clínica conserva filtro propio y rechaza scope inválido antes de leer', async () => {
  let calls = 0;
  const models = { WebEvent: { max: async (_column, { where }) => {
    calls++;
    assert.equal(where.clinic_id, 19);
    assert.equal(where.group_id, undefined);
    return null;
  } } };
  await readStoredWebEvidence({ ...params, scopeType: 'clinic', scopeId: 19, clinicId: 19, models });
  await readStoredWebEvidence({ ...params, scopeId: 0, models });
  assert.equal(calls, 1);
});

test('errores de lectura y modelos ausentes son desconocidos, no ausencia', async () => {
  for (const models of [{}, {
    WebEvent: { max: async () => { throw new Error('private query text'); } },
    WebWordpressInstallation: { findAll: async () => { throw new Error('private token'); } },
  }]) {
    const d = await readStoredWebEvidence({ ...params, models });
    assert.equal(d.activity.status, 'unavailable');
    assert.equal(d.plugin.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(d), /private/);
  }
});

test('no confundir instalación de otro dominio, contacto viejo o revocación', async () => {
  for (const [rows, status, recent] of [
    [[{ siteUrl: 'https://other.test', status: 'connected' }], 'not_registered', false],
    [[{ siteUrl: checkedUrl, status: 'connected', lastSeenAt: new Date(nowMs - 2 * 86400000) }], 'connected', false],
    [[{ siteUrl: checkedUrl, status: 'revoked' }], 'revoked', false],
    [[{ siteUrl: checkedUrl, status: 'connected' }, { siteUrl: checkedUrl, status: 'connected' }], 'ambiguous', false],
  ]) {
    const { plugin } = await readStoredWebEvidence({ ...params, models: { WebWordpressInstallation: { findAll: async () => rows } } });
    assert.equal(plugin.status, status);
    assert.equal(plugin.recent_contact, recent);
  }
});

test('runtime compatible sin eventos no acredita ejecución ni conversiones', () => {
  const d = buildWebDiagnostics({ html: loader, checkedUrl, nowMs, stored: { plugin: { status: 'unavailable' }, activity: { status: 'no_recent_activity' } },
    isAllowedAssetUrl: ownAsset, expectedAttr: 'data-group-id', expectedId: 5,
    evaluation: { installed: true, runtime_compatible: true, runtime_version: '3.4.9' } });
  assert.equal(d.installation.loader_visible, true);
  assert.equal(d.installation.transport_configured, true);
  assert.equal(d.runtime.status, 'compatible');
  assert.equal(d.runtime.execution, 'not_verified');
  assert.equal(d.activity.status, 'no_recent_activity');
  assert.equal(d.tags.ga4_bridge, 'not_configured');
  assert.equal(d.conversion, undefined);
});
