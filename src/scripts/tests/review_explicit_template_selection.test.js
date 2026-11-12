'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');

const body = 'Hola {{1}}, soy {{2}} de {{3}}. ¿Cómo valorarías tu experiencia?\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐';
const photo = 'https://images.example.invalid/fictitious-team.jpg';
const scope = { scope: 'clinic', clinicIds: [1] };
const reachedAudience = Object.assign(Error('CLOSED_TEST_AUDIENCE_BOUNDARY'), { code: 'CLOSED_TEST_AUDIENCE_BOUNDARY' });
const capturedListUpdate = Object.assign(Error('CLOSED_TEST_LIST_UPDATE_BOUNDARY'), { code: 'CLOSED_TEST_LIST_UPDATE_BOUNDARY' });

function fixture() {
  const templates = [
    { id: 6055, name: 'clinicaclick_solicitar_resena_fictitious', catalog_template_id: 9 },
    { id: 6071, name: 'clinicaclick_solicitar_resena_foto_fictitious', catalog_template_id: 34, image: true },
    { id: 6134, name: 'cc_custom_fictitious_review', origin: 'custom', clinic_id: 1, image: true },
  ].map(t => ({
    clinic_id: null, origin: 'catalog', created_by_user_id: 1, status: 'APPROVED', is_active: true,
    category: 'MARKETING', waba_id: 'fictitious-waba-A', language: 'es', ...t,
    components: [...(t.image ? [{ type: 'HEADER', format: 'IMAGE' }] : []), { type: 'BODY', text: body }],
    variables: ['nombre_paciente', 'firma_resenas', 'nombre_clinica'].map((name, index) => ({
      position: index + 1, name, template_usage: 'solicitud_resena',
    })),
    catalog: t.catalog_template_id ? { id: t.catalog_template_id, name: t.name, body_text: body } : null,
  }));
  const f = { templates, lookups: [], resolutions: [], writes: 0, candidates: 0, audienceReads: 0, allowCriteriaUpdate: false };
  f.list = { id: 99, objective_id: 'mass_sends', clinica_id: 1, status: 'draft', channel: 'whatsapp',
    criteria: { template_usage: 'solicitud_resena', whatsapp_template_id: 6134,
      review_team_photo_url: photo, review_sender_name: 'Equipo ficticio' },
    template_snapshot: { id: 6071 }, template_id: 6055,
    update: async patch => {
      f.writes++;
      if (f.captureListUpdate) { f.lastPatch = patch; throw capturedListUpdate; }
      if (!f.allowCriteriaUpdate) throw Error('PERSISTENCE_FORBIDDEN_IN_SELECTION_TEST');
      Object.assign(f.list, patch); return f.list;
    },
  };
  const model = {
    findByPk: async id => { f.lookups.push(Number(id)); return templates.find(t => t.id === Number(id)) || null; },
    findOne: async ({ where }) => templates.find(t => Object.entries(where).every(([key, value]) => t[key] === value)) || null,
    findAll: async () => { f.candidates++; return templates; },
  };
  const db = { WhatsappTemplate: model, WhatsappTemplateCatalog: {},
    MarketingPatientList: { findByPk: async () => f.list, findAll: async () => [] },
    MarketingPatientListItem: { findAll: async () => { f.audienceReads++; if (f.allowEmptyAudience) return []; throw reachedAudience; },
      findOne: async () => { f.audienceReads++; throw reachedAudience; } },
    AutomationFlowTemplateV2: { findOne: async () => null },
    sequelize: { transaction: async callback => callback({}) },
  };
  const wabaScope = loadDiscoverySource('services/whatsappTemplateScope.service.js', {
    sequelize, '../../models': db,
    '../lib/whatsapp-template-scope': require('../../lib/whatsapp-template-scope'),
  });
  const service = loadDiscoverySource('services/marketingBulkSends.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': db,
    './whatsapp.service': { getClinicConfig: async clinicId => ({ wabaId: clinicId === 2 ? 'fictitious-waba-B' : 'fictitious-waba-A' }) },
    './whatsappTemplateScope.service': { resolveTemplateInWaba: async input => {
      f.resolutions.push({ id: input.template.id, clinicId: input.clinicId });
      return wabaScope.resolveTemplateInWaba(input);
    } },
    '../lib/whatsapp-template-contract': require('../../lib/whatsapp-template-contract'),
    '../lib/review-template-media': require('../../lib/review-template-media'),
    '../lib/review-sender-policy': require('../../lib/review-sender-policy'),
    '../lib/review-automation-config': require('../../lib/review-automation-config'),
    '../lib/role-helpers': require('../../lib/role-helpers'),
    './publicMediaPersonalization.service': { normalizeHexColor: value => value || null },
  });
  f.service = { ...service, sendTest: (targetScope, id, body = {}, options) =>
    service.sendTest(targetScope, id, { item_id: 12345, ...body }, options) };
  f.find = (id, options, targetScope = scope) => service.__testing.findApprovedReviewWhatsappTemplate(targetScope, id, options);
  return f;
}

test('new explicit default selection cannot be replaced by a preferred custom copy when its media is incompatible', async () => {
  const f = fixture();
  assert.equal(await f.find(6055, { preferPhoto: true, strictExplicitSelection: true }), null);
  assert.equal(f.candidates, 0, 'incompatible explicit copy cannot trigger automatic discovery');
  assert.equal(f.writes, 0);
});

test('compatible explicit default photo, custom photo and text-only selections keep their exact approved identity', async () => {
  for (const [id, preferPhoto] of [[6071, true], [6134, true], [6055, false]]) {
    const f = fixture();
    assert.equal((await f.find(id, { preferPhoto, strictExplicitSelection: true })).id, id);
    assert.deepEqual(f.lookups, [id]);
    assert.equal(f.candidates, 0);
  }
});

test('a group may resolve the selected contract in another WABA, but a different copy is rejected', async () => {
  const f = fixture();
  const source = f.templates.find(t => t.id === 6071);
  const replica = { ...structuredClone(source), id: 7071, waba_id: 'fictitious-waba-B' };
  f.templates.push(replica);
  const group = { scope: 'group', groupId: 9, clinicIds: [2, 1] };
  assert.equal((await f.find(6071, { preferPhoto: true, strictExplicitSelection: true }, group)).id, 7071);
  replica.components.find(c => c.type === 'BODY').text += ' A different wording.';
  assert.equal(await f.find(6071, { preferPhoto: true, strictExplicitSelection: true }, group), null);
  assert.equal(f.writes, 0);
});

test('stored references and automatic maintenance keep their historical template-resolution behavior', async () => {
  const f = fixture();
  assert.equal((await f.find(6055, { preferPhoto: true })).id, 6134);
  assert.equal((await f.find(null, { preferPhoto: true })).id, 6134);
});

test('photo selection distinguishes an omitted field from an explicit clear accompanying a new template', () => {
  const choose = fixture().service.__testing.resolveReviewTeamPhotoSelection;
  assert.equal(choose({ whatsapp_template_id: 6055 }, photo), photo);
  for (const clear of ['', null]) {
    assert.equal(choose({ whatsapp_template_id: 6055, review_team_photo_url: clear }, photo), null);
    assert.equal(choose({ template_id: 6055, reviewTeamPhotoUrl: clear }, photo), null);
    assert.equal(choose({ whatsapp_template_id: 6055, review_team_photo_url: clear }, null, photo), null);
  }
  assert.equal(choose({ review_team_photo_url: '' }, photo), photo, 'requests without a new selection keep the historical fallback');
  assert.equal(choose({ whatsapp_template_id: 6071, review_team_photo_url: photo }), photo);
});

test('saving review configuration with an explicit incompatible ID fails before changing configuration', async () => {
  const f = fixture();
  await assert.rejects(f.service.setReviewRequestAutomation(scope, {
    save_configuration: true, whatsapp_template_id: 6055, review_team_photo_url: photo,
  }, 1), error => error.status === 409 && error.code === 'review_whatsapp_template_ineligible');
  assert.equal(f.writes, 0); assert.equal(f.list.criteria.whatsapp_template_id, 6134);
});

test('updating a draft persists the newly selected text identity and its explicit photo clear together', async () => {
  for (const clear of ['', null]) {
    const f = fixture(); f.allowEmptyAudience = true; f.captureListUpdate = true;
    await assert.rejects(f.service.updateCampaign(scope, 99, { whatsapp_template_id: 6055, review_team_photo_url: clear }),
      error => error === capturedListUpdate);
    assert.equal(f.lastPatch.criteria.whatsapp_template_id, 6055);
    assert.equal(f.lastPatch.criteria.review_team_photo_url, null);
    assert.equal(f.lastPatch.template_snapshot.id, 6055);
  }
  const f = fixture(); f.allowEmptyAudience = true; f.captureListUpdate = true;
  await assert.rejects(f.service.updateCampaign(scope, 99, { whatsapp_template_id: 6055 }), error => error === capturedListUpdate);
  assert.equal(f.lastPatch.criteria.review_team_photo_url, photo, 'omitting the field preserves the saved image');
});

test('an invalid test selection leaves sender, review context, image and template snapshot untouched and never reaches dispatch', async () => {
  const f = fixture(); f.allowCriteriaUpdate = true;
  const before = structuredClone({ criteria: f.list.criteria, snapshot: f.list.template_snapshot });
  await assert.rejects(f.service.sendTest(scope, 99, {
    whatsapp_template_id: 6071, review_team_photo_url: null,
    sender_name: 'Nuevo remitente ficticio', review_sender_name: 'Otro equipo ficticio',
    review_display_clinic_name: 'Nueva clínica ficticia', review_team_photo_overlay_color: '#ffaa00',
    review_team_members_text: 'Nuevos miembros ficticios',
  }), error => error.status === 409 && error.code === 'review_whatsapp_template_ineligible');
  assert.equal(f.writes, 0);
  assert.equal(f.audienceReads, 0, 'validation precedes recipient lookup, conversation creation and transport');
  assert.deepEqual({ criteria: f.list.criteria, snapshot: f.list.template_snapshot }, before);
});

for (const operation of ['prepareCampaign', 'sendTest']) {
  test(`${operation} honors body WhatsApp ID over alias, saved criteria, snapshot and legacy ID; incompatible explicit media fails closed`, async () => {
    const f = fixture();
    await assert.rejects(f.service[operation](scope, 99, { whatsapp_template_id: 6055, template_id: 6071 }),
      error => error.status === 409 && error.code === 'review_whatsapp_template_ineligible'
        && error.details.template_id === 6055);
    assert.deepEqual(f.lookups, [6055]); assert.equal(f.writes, 0);
    assert.equal(f.list.criteria.whatsapp_template_id, 6134);
  });

  test(`${operation} carries the compatible explicit selection to the audience boundary without replacing it`, async () => {
    const f = fixture();
    await assert.rejects(f.service[operation](scope, 99, { whatsapp_template_id: 6071, template_id: 6055 }),
      error => error === reachedAudience);
    assert.deepEqual(f.lookups, [6071]);
    assert.deepEqual(f.resolutions, [{ id: 6071, clinicId: 1 }]);
    assert.equal(f.writes, 0);
  });

  for (const clear of ['', null]) test(`${operation} honors an explicit ${JSON.stringify(clear)} photo clear for a new text template`, async () => {
    const f = fixture(); f.allowCriteriaUpdate = true;
    await assert.rejects(f.service[operation](scope, 99, { whatsapp_template_id: 6055, review_team_photo_url: clear }),
      error => error === reachedAudience);
    assert.deepEqual(f.lookups, [6055]);
    assert.deepEqual(f.resolutions, [{ id: 6055, clinicId: 1 }]);
    if (operation === 'sendTest') assert.equal(f.list.criteria.review_team_photo_url, photo,
      'the selected template honors the clear, but saved criteria wait for a valid recipient');
  });

  test(`${operation} rejects an image template when its photo is explicitly removed`, async () => {
    const f = fixture(); f.allowCriteriaUpdate = true;
    await assert.rejects(f.service[operation](scope, 99, { whatsapp_template_id: 6071, review_team_photo_url: null }),
      error => error.status === 409 && error.code === 'review_whatsapp_template_ineligible');
    assert.deepEqual(f.lookups, [6071]); assert.equal(f.resolutions.length, 0);
    assert.equal(f.writes, 0); assert.equal(f.audienceReads, 0);
    assert.equal(f.list.criteria.review_team_photo_url, photo);
  });
}
