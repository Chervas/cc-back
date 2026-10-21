'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const K = require('../../lib/clinical-template-catalog-contract'), T = require('../../lib/clinical-template-contract');
test('catalog separates real medical areas from rendering area and requires explicit unique onboarding selections', () => {
  const value = { definition: T.builtin('general'), kind: 'initial', all_medical_areas: false, medical_area_codes: ['cirugia_digestiva'] };
  assert.equal(K.definition(value).definition.area_key, 'general');
  assert.deepEqual(K.definition(value).medical_area_codes, ['cirugia_digestiva']);
  const structured = K.definition({ ...value, definition: T.builtin('facial') });
  assert.equal(structured.definition.form_schema.kind, 'initial');
  assert.throws(() => K.definition({ ...value, all_medical_areas: true }), { code: 'clinical_catalog_areas_invalid' });
  assert.throws(() => K.definition({ ...value, medical_area_codes: ['invented space'] }), { code: 'clinical_catalog_areas_invalid' });
  assert.deepEqual(K.selections(undefined), []);
  assert.throws(() => K.selections([{ id: 'same', version: 1 }, { id: 'same', version: 1 }]), { code: 'clinical_catalog_selection_invalid' });
  assert.throws(() => K.selections([{ id: 'same', version: 1, apply_automatically: true }]), { code: 'clinical_catalog_selection_invalid' });
});
test('catalog controller blocks publication by clinic roles and adoption outside exact clinic clinical/settings ACL', async () => {
  const { createClinicalTemplateCatalogController } = require('../../controllers/clinicalTemplateCatalog.controller');
  let calls = 0;
  const catalog = Object.fromEntries(['list', 'get', 'create', 'save', 'adopt', 'presets', 'versions'].map(key => [key, async () => { calls++; return { items: [] }; }]));
  const controller = createClinicalTemplateCatalogController({ catalog, globalAdmin: id => id === 1,
    canAccess: async ({ actorId, clinicId, featureKey }) => actorId === 7 && clinicId === 72 && featureKey !== 'clinical.reports.manage' });
  const response = () => ({ code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  for (const [handler, actor, query, expected] of [
    ['list', null, { clinic_id: 72 }, 401], ['list', 7, {}, 403], ['list', 7, { clinic_id: 72, admin: 'true' }, 403],
    ['create', 7, {}, 403], ['save', 7, { clinic_id: 72 }, 403], ['presets', 7, {}, 403], ['versions', 7, {}, 403],
    ['list', 7, { clinic_id: 73 }, 403], ['adopt', 7, { clinic_id: 72 }, 403],
  ]) {
    const res = response(); await controller[handler]({ userData: { userId: actor }, params: { id: 'x' }, query, body: {} }, res);
    assert.equal(res.code, expected); assert.equal(calls, 0);
  }
  await controller.list({ userData: { userId: 7 }, params: {}, query: { clinic_id: 72 } }, response()); assert.equal(calls, 1);
  await controller.list({ userData: { userId: 1 }, params: {}, query: { admin: 'true' } }, response()); assert.equal(calls, 2);
});
test('source preparation is explicit and keeps existing customized publications without adopting into clinics', async () => {
  const { prepare } = require('../prepare-clinical-template-catalog');
  const created = [], originals = [{ catalog_key: 'source-existing', id: 'retained', published_version: 4 }];
  const catalog = { presets: async () => ({ items: [{ catalog_key: 'source-existing' }, { catalog_key: 'source-new' }] }),
    list: async ({ admin }) => { assert.equal(admin, true); return { items: originals, next_cursor: null }; },
    create: async ({ actorId, payload }) => { assert.equal(actorId, 1); assert.equal(payload.publish, true); created.push(payload); return { created: true, item: { ...payload, id: 'new', version: 1 } }; },
    adopt: () => assert.fail('Preparing source definitions must not create clinic copies') };
  const result = await prepare({ catalog, actorId: 1 });
  assert.equal(created.length, 1); assert.equal(created[0].catalog_key, 'source-new');
  assert.equal(result[0].source_version, 4); assert.equal(result[0].retained, true);
});
test('operator source preparation refuses unbound targets, dirty sources, wrong SQL identity/fixture and missing actors before writes', async () => {
  const { argumentsFor, assertSource, assertTarget, verifyDatabase } = require('../prepare-clinical-template-catalog');
  const args = ['--apply-source-presets', '--target=dev', '--actor-id=1']; assert.equal(argumentsFor(args).actorId, 1);
  for (const bad of [args.filter(value => value !== '--target=dev'), args.map(value => value.replace('target=dev', 'target=crm')), args.map(value => value.replace('actor-id=1', 'actor-id=7'))]) assert.throws(() => argumentsFor(bad), /CLINICAL_CATALOG_/);
  const source = { cwd: '/home/ubuntu/wt/back-dev', sourceRoot: '/home/ubuntu/wt/back-dev', branch: 'dev', dirty: false };
  assertSource(source); assert.throws(() => assertSource({ ...source, dirty: true }), /CANONICAL_DEV_SOURCE/); assert.throws(() => assertSource({ ...source, branch: 'staging' }), /CANONICAL_DEV_SOURCE/);
  const config = { host: 'localhost', port: 3306, database: 'clinicaclick_dev_isolated', user: 'cc_dev_api' };
  assertTarget('dev', config); assert.throws(() => assertTarget('crm', config), /ISOLATED_DEV_TARGET/); assert.throws(() => assertTarget('dev', { ...config, database: 'clinicaclick' }), /ISOLATED_DEV_TARGET/);
  function sql({ wrongIdentity = false, anchor = 1, actor = 1 } = {}) {
    return { query: async (text, options) => {
      assert.match(text, /^SELECT /); assert.doesNotMatch(text, /INSERT|UPDATE|DELETE/i);
      if (text.includes('CURRENT_USER')) return [[{ database_name: wrongIdentity ? 'clinicaclick' : config.database, database_user: 'cc_dev_api@localhost', server_port: 3306 }]];
      if (text.includes('fictional_anchor')) return [[{ fictional_anchor: anchor }]];
      assert.equal(options.replacements.actorId, 1); return [[{ actor_exists: actor }]];
    } };
  }
  await verifyDatabase(sql(), config, 1);
  await assert.rejects(verifyDatabase(sql({ wrongIdentity: true }), config, 1), /DATABASE_IDENTITY/);
  await assert.rejects(verifyDatabase(sql({ anchor: 0 }), config, 1), /FICTIONAL_ANCHOR/);
  await assert.rejects(verifyDatabase(sql({ actor: 0 }), config, 1), /ACTOR_NOT_PRESENT/);
});
