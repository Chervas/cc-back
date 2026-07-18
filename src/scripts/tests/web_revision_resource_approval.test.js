'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';

const assert = require('node:assert/strict');
const { assertValidWebDocument } = require('../../lib/webDocument');
const { createBlankWebDocument, transitionRevision } = require('../../services/webProjects.service');

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
  };
}

async function main() {
  const mediaId = '11111111-1111-4111-8111-111111111111';
  const contentId = '22222222-2222-4222-8222-222222222222';
  const projectId = '33333333-3333-4333-8333-333333333333';
  const revisionId = '44444444-4444-4444-8444-444444444444';
  const document = createBlankWebDocument({ name: 'Aprobación W3' });
  const section = document.nodes[document.pages[0].root_node_ids[0]];
  const headingId = section.children.find((id) => document.nodes[id].type === 'heading');
  const textId = section.children.find((id) => document.nodes[id].type === 'text');
  for (const childId of [...section.children]) {
    if (![headingId, textId].includes(childId)) delete document.nodes[childId];
  }
  section.children = [headingId, textId];
  const imageId = 'image_w3';
  document.nodes[imageId] = {
    id: imageId,
    type: 'image',
    version: 1,
    props: {
      asset_id: mediaId,
      alt: 'Recepción de la clínica',
      decorative: false,
      loading: 'eager',
      fit: 'cover',
      aspect_ratio: '4:3',
    },
    children: [],
  };
  section.children.push(imageId);
  document.bindings.content_heading = {
    target_node_id: headingId,
    target_prop: 'text',
    source: 'content_entry',
    source_id: contentId,
    field: 'title',
  };
  document.nodes[headingId].binding_ids = ['content_heading'];
  document.consent = {
    provider: 'inherit',
    preview_mode: false,
    privacy_policy_url: '/privacidad',
    privacy_policy_version: '2026-07-17',
    privacy_consent_text: 'Acepto la política de privacidad.',
  };
  assertValidWebDocument(document);

  const publicMedia = row({
    id: 10,
    scope_type: 'clinic',
    clinica_id: 66,
    grupo_clinica_id: null,
    public_url: 'https://media.example.com/image.webp',
    content_type: 'image/webp',
    size_bytes: 1000,
    sensitivity: 'public',
    status: 'active',
    metadata: { non_clinical_asserted: true, hmac_key: 'never-copy' },
  });
  const media = row({
    id: mediaId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    title: 'Recepción',
    kind: 'image',
    status: 'ready',
    altText: 'Recepción de la clínica',
    decorative: false,
    focalPoints: {},
    rights: { origin: 'owned' },
    variants: [],
    mediaMetadata: {},
    version: 1,
    publicMediaAsset: publicMedia,
  });
  const content = row({
    id: contentId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    type: 'value_proposition',
    locale: 'es-ES',
    title: 'Tu clínica cerca de ti',
    content: { headline: 'Tu clínica cerca de ti', summary: 'Atención clara y cercana.' },
    sources: [],
    contentHash: 'a'.repeat(64),
    status: 'published',
    version: 2,
  });
  const project = row({ id: projectId, scopeType: 'clinic', clinicaId: 66, grupoClinicaId: null });
  let saveOptions = null;
  const revision = row({
    id: revisionId,
    projectId,
    revisionNumber: 1,
    document,
    documentHash: 'b'.repeat(64),
    contentSnapshot: {},
    status: 'review',
    save: async (options) => { saveOptions = options; },
  });
  let revisionReads = 0;
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 4 }) },
    GrupoClinica: {},
    PublicMediaAsset: {},
    WebProject: { findByPk: async () => project },
    WebRevision: {
      findByPk: async () => { revisionReads += 1; return revision; },
      update: async () => {},
    },
    WebMediaAsset: { findAll: async () => [media] },
    WebContentEntry: { findAll: async () => [content] },
    WebAuditEvent: { create: async () => {} },
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  const approved = await transitionRevision({
    actorId: 1,
    revisionId,
    action: 'approve',
    models,
    sequelize,
  });
  assert.equal(revisionReads, 2);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.resolved_references.length, 2);
  assert.deepEqual(approved.unresolved_references, []);
  assert.equal(saveOptions.webContentSnapshotFreeze, true);
  assert.equal(Object.keys(revision.contentSnapshot.content_entries).length, 1);
  assert.equal(Object.keys(revision.contentSnapshot.media_assets).length, 1);
  assert.equal(JSON.stringify(revision.contentSnapshot).includes('hmac_key'), false);
  console.log('web revision resource approval: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
