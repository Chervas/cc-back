'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';

const assert = require('node:assert/strict');
const {
  WebContentMediaServiceError,
  assertPublicMediaUsable,
  assertOwnerOrReviewer,
  assertResourceScopeAccess,
  cleanupExpiredQuarantinedMedia,
  createContent,
  registerMedia,
  serializeMediaAsset,
  updateContent,
} = require('../../services/webContentMedia.service');
const {
  resolveWebDocumentResources,
  snapshotContent,
} = require('../../services/webResourceResolver.service');

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
    setDataValue(key, value) { this[key] = value; },
  };
}

function baseModels() {
  return {
    Clinica: { findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 4 }) },
    GrupoClinica: {},
  };
}

async function testCreatePersistsVersionAndAudit() {
  const writes = { versions: [], audits: [] };
  const models = {
    ...baseModels(),
    WebContentEntry: {
      create: async (values) => row({
        ...values,
        created_at: new Date('2026-07-17T18:00:00Z'),
        updated_at: new Date('2026-07-17T18:00:00Z'),
      }),
    },
    WebContentEntryVersion: { create: async (values) => writes.versions.push(values) },
    WebAuditEvent: { create: async (values) => writes.audits.push(values) },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const created = await createContent({
    actorId: 1,
    body: {
      scope_type: 'clinic',
      scope_id: 66,
      type: 'faq',
      locale: 'es-ES',
      title: '¿Cómo pedir cita?',
      content: { question: '¿Cómo pedir cita?', answer: 'Déjanos tus datos y te llamaremos.' },
      sources: [],
    },
    requestId: 'content:create:123',
    models,
    sequelize,
  });
  assert.equal(created.scope.type, 'clinic');
  assert.equal(created.version, 1);
  assert.equal(writes.versions.length, 1);
  assert.equal(writes.versions[0].contentHash, created.content_hash);
  assert.equal(writes.audits[0].eventType, 'web.content.created');
}

async function testContentCasConflict() {
  let changed = false;
  const entry = row({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    type: 'faq',
    locale: 'es-ES',
    title: 'FAQ',
    content: { question: 'Pregunta', answer: 'Respuesta' },
    sources: [],
    contentHash: 'a'.repeat(64),
    status: 'draft',
    version: 4,
    update: async () => { changed = true; },
  });
  const models = {
    ...baseModels(),
    WebContentEntry: { findByPk: async () => entry },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  await assert.rejects(
    () => updateContent({
      actorId: 1,
      contentId: entry.id,
      body: { version: 3, title: 'Otro título' },
      models,
      sequelize,
    }),
    (error) => error instanceof WebContentMediaServiceError
      && error.code === 'content_conflict'
      && error.details.current_version === 4
  );
  assert.equal(changed, false);
}

async function testRegisterMediaWrapsWithoutLeakingStorageInternals() {
  const publicAsset = row({
    id: 91,
    scope_type: 'clinic',
    clinica_id: 66,
    grupo_clinica_id: null,
    public_url: 'https://media.example.com/v/asset.webp',
    content_type: 'image/webp',
    size_bytes: 12000,
    status: 'quarantine',
    sensitivity: 'internal',
    purpose: 'web_editor_media',
    created_by: 1,
    bucket: 'never-return-this',
    object_key: 'secret/internal/path',
    metadata: {
      non_clinical_asserted: true,
      quarantine_expires_at: new Date(Date.now() + 60_000).toISOString(),
      image: { width: 1200, height: 800 },
      hmac_key: 'never-return-this-either',
    },
    update: async function update(values) { Object.assign(this, values); },
  });
  const audits = [];
  const models = {
    ...baseModels(),
    PublicMediaAsset: { findByPk: async () => publicAsset },
    WebMediaAsset: {
      findOne: async () => null,
      create: async (values) => row({
        ...values,
        created_at: new Date('2026-07-17T18:00:00Z'),
        updated_at: new Date('2026-07-17T18:00:00Z'),
      }),
    },
    WebAuditEvent: { create: async (values) => audits.push(values) },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const media = await registerMedia({
    actorId: 1,
    body: {
      scope_type: 'clinic',
      scope_id: 66,
      public_media_asset_id: 91,
      title: 'Recepción',
      alt_text: 'Recepción de la clínica',
      decorative: false,
      focal_points: { desktop: { x: 50, y: 50 } },
      rights: { origin: 'owned' },
    },
    requestId: 'media:register:123',
    models,
    sequelize,
  });
  assert.equal(media.public_media.url, publicAsset.public_url);
  assert.equal(media.metadata.width, 1200);
  assert.equal(JSON.stringify(media).includes('bucket'), false);
  assert.equal(JSON.stringify(media).includes('object_key'), false);
  assert.equal(JSON.stringify(media).includes('hmac_key'), false);
  assert.equal(audits[0].eventType, 'web.media.registered');
  assert.equal(publicAsset.status, 'active');
  assert.equal(publicAsset.sensitivity, 'public');
}

function testMediaProjectionRedactsLegacyInternalFields() {
  const projected = serializeMediaAsset(row({
    id: '99999999-9999-4999-8999-999999999999',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    title: 'Legacy',
    kind: 'image',
    status: 'ready',
    altText: 'Imagen',
    decorative: false,
    focalPoints: {},
    rights: { origin: 'owned', hmac_key: 'secret' },
    variants: [{
      key: 'unsafe',
      url: 'https://media.example.com/a.webp?token=secret',
      content_type: 'image/webp',
    }],
    mediaMetadata: { width: 10, hmac_key: 'secret', bucket: 'private' },
    version: 1,
    publicMediaAsset: row({
      id: 9,
      public_url: 'https://media.example.com/a.webp?token=secret',
      content_type: 'image/webp',
      size_bytes: 10,
    }),
  }), { requestedScope: { type: 'clinic', id: 66 } });
  assert.equal(projected.public_media, null);
  assert.deepEqual(projected.variants, []);
  assert.equal(JSON.stringify(projected).includes('hmac_key'), false);
  assert.equal(JSON.stringify(projected).includes('bucket'), false);
}

function testContentSnapshotRemovesInternalConsentReference() {
  const snapshot = snapshotContent({
    id: '9b213458-e919-4738-9cf3-3e72d77c239b',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    version: 2,
    type: 'testimonial',
    locale: 'es-ES',
    title: 'Testimonio',
    content: {
      quote: 'Me atendieron muy bien.',
      attribution: 'Paciente verificado',
      consent_reference: 'internal-consent-record-91',
    },
    sources: [],
    contentHash: 'a'.repeat(64),
  }, false);
  assert.deepEqual(snapshot.content, {
    quote: 'Me atendieron muy bien.',
    attribution: 'Paciente verificado',
  });
  assert.equal(JSON.stringify(snapshot).includes('internal-consent-record-91'), false);
}

function testPublicMediaScopeDoesNotRevealOtherTenantIds() {
  for (const candidate of [
    null,
    { id: 10, scope_type: 'clinic', clinica_id: 99 },
  ]) {
    assert.throws(
      () => assertPublicMediaUsable(candidate, { type: 'clinic', id: 66 }),
      (error) => error.code === 'public_media_not_accessible' && error.status === 404
    );
  }
}

function mediaRow({ id, scopeType, scopeId }) {
  return row({
    id,
    scopeType,
    clinicaId: scopeType === 'clinic' ? scopeId : null,
    grupoClinicaId: scopeType === 'group' ? scopeId : null,
    title: 'Imagen',
    kind: 'image',
    status: 'ready',
    altText: 'Imagen informativa',
    decorative: false,
    focalPoints: {},
    rights: { origin: 'owned' },
    variants: [],
    mediaMetadata: {},
    version: 2,
    publicMediaAsset: row({
      id: 10,
      scope_type: scopeType,
      clinica_id: scopeType === 'clinic' ? scopeId : null,
      grupo_clinica_id: scopeType === 'group' ? scopeId : null,
      public_url: 'https://media.example.com/image.webp',
      content_type: 'image/webp',
      size_bytes: 1000,
      sensitivity: 'public',
      status: 'active',
      metadata: { non_clinical_asserted: true, hmac_key: 'must-not-leak' },
    }),
  });
}

async function testResolverAllowsExplicitClinicToGroupInheritanceButNeverReverse() {
  const clinicMedia = mediaRow({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    scopeId: 66,
  });
  const groupMedia = mediaRow({
    id: '22222222-2222-4222-8222-222222222222',
    scopeType: 'group',
    scopeId: 4,
  });
  groupMedia.rights = {
    origin: 'licensed',
    license_reference: 'internal-contract-42',
    consent_reference: 'internal-consent-42',
    license_url: 'https://example.com/license',
    credit: 'Proveedor',
  };
  const groupContent = row({
    id: '33333333-3333-4333-8333-333333333333',
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 4,
    type: 'faq',
    locale: 'es-ES',
    title: 'FAQ grupal',
    content: { question: 'Pregunta', answer: 'Respuesta grupal' },
    sources: [],
    contentHash: 'b'.repeat(64),
    status: 'published',
    version: 3,
  });
  const models = {
    Clinica: {
      findByPk: async () => ({ grupoClinicaId: 4 }),
      findAll: async () => [{ id_clinica: 66, grupoClinicaId: 4 }],
    },
    PublicMediaAsset: {},
    WebMediaAsset: { findAll: async () => [clinicMedia, groupMedia] },
    WebContentEntry: { findAll: async () => [groupContent] },
  };
  const document = {
    seo: { default_social_asset_id: groupMedia.id },
    pages: [{ seo: { social_asset_id: clinicMedia.id } }],
    nodes: {},
    bindings: {
      faq: {
        source: 'content_entry',
        source_id: groupContent.id,
        field: 'description',
      },
      treatment: {
        source: 'treatment',
        source_id: 'treatment_1',
        field: 'title',
      },
    },
    integrations: { intake_config_id: 'intake_1' },
  };
  const clinicResult = await resolveWebDocumentResources({
    document,
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });
  assert.equal(clinicResult.resolved.some((item) => item.id === groupMedia.id && item.inherited), true);
  assert.equal(clinicResult.resolved.some((item) => item.id === groupContent.id && item.inherited), true);
  assert.equal(clinicResult.unresolved.some((item) => item.kind === 'treatment'), true);
  assert.equal(clinicResult.unresolved.some((item) => item.kind === 'intake_config'), true);
  assert.equal(JSON.stringify(clinicResult.snapshot).includes('hmac_key'), false);
  assert.equal(JSON.stringify(clinicResult.snapshot).includes('internal-contract-42'), false);
  assert.equal(JSON.stringify(clinicResult.snapshot).includes('internal-consent-42'), false);
  const inheritedProjection = serializeMediaAsset(groupMedia, {
    requestedScope: { type: 'clinic', id: 66 },
  });
  assert.equal(inheritedProjection.scope.inherited, true);
  assert.equal(inheritedProjection.read_only, true);

  const groupResult = await resolveWebDocumentResources({
    document: {
      seo: { default_social_asset_id: clinicMedia.id },
      pages: [],
      nodes: {},
      bindings: {},
      integrations: {},
    },
    scope: { type: 'group', id: 4 },
    models,
    allowGroupInheritance: true,
  });
  assert.equal(groupResult.resolved.length, 0);
  assert.equal(groupResult.unresolved[0].reason, 'not_accessible_or_unavailable');

  const wrongClinic = await resolveWebDocumentResources({
    document: {
      seo: {},
      pages: [],
      nodes: {},
      bindings: {
        clinic: { source: 'clinic', source_id: '77', field: 'name' },
      },
      integrations: {},
    },
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });
  assert.equal(wrongClinic.resolved.length, 0);
  assert.equal(wrongClinic.unresolved[0].kind, 'clinic');

  const implicitClinic = await resolveWebDocumentResources({
    document: {
      seo: {},
      pages: [],
      nodes: {},
      bindings: {
        clinic: { source: 'clinic', source_id: null, field: 'phone' },
      },
      integrations: {},
    },
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });
  assert.equal(implicitClinic.unresolved.length, 0);
  assert.equal(implicitClinic.snapshot.live_bindings[0].implicit_scope, true);

  const explicitGroupClinic = await resolveWebDocumentResources({
    document: {
      seo: {},
      pages: [],
      nodes: {},
      bindings: {
        clinic: { source: 'clinic', source_id: '66', field: 'name' },
      },
      integrations: {},
    },
    scope: { type: 'group', id: 4 },
    models,
    allowGroupInheritance: true,
  });
  assert.equal(explicitGroupClinic.resolved[0].kind, 'clinic');
  assert.equal(explicitGroupClinic.snapshot.live_bindings[0].resolver, 'clinic_public_v1');
}

async function testResolverFreezesCanonicalTreatmentProfessionalAndIntake() {
  const treatment = row({
    id_tratamiento: 7,
    nombre: 'Implantes dentales',
    descripcion: 'Valoración, planificación y tratamiento personalizado.',
    precio_base: '1200.00',
    activo: true,
    origen: 'grupo',
    clinica_id: null,
    grupo_clinica_id: 4,
    eliminado_por_clinica: [],
  });
  const professional = row({
    id: 9,
    doctor_id: 90,
    clinica_id: 66,
    rol_en_clinica: 'Odontóloga',
    activo: true,
    doctor: row({
      id_usuario: 90,
      nombre: 'Dévora',
      apellidos: 'Prueba',
      cargo_usuario: 'Odontóloga',
      isProfesional: true,
      estado_cuenta: 'activo',
    }),
  });
  const intake = row({
    id: 12,
    assignment_scope: 'group',
    clinic_id: null,
    group_id: 4,
    config: {
      locations: [{ id: 66 }],
      hmac_key: 'must-never-be-frozen',
      internal_token: 'must-never-be-frozen-either',
    },
    hmac_key: 'must-never-be-frozen',
  });
  const models = {
    Clinica: {
      findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 4 }),
      findAll: async () => [{ id_clinica: 66, grupoClinicaId: 4 }],
    },
    PublicMediaAsset: {},
    WebMediaAsset: { findAll: async () => [] },
    WebContentEntry: { findAll: async () => [] },
    Tratamiento: { findAll: async () => [treatment] },
    Usuario: {},
    DoctorClinica: { findAll: async () => [professional] },
    IntakeConfig: { findAll: async () => [intake] },
  };
  const result = await resolveWebDocumentResources({
    document: {
      seo: {},
      pages: [],
      nodes: {},
      bindings: {
        treatment: { source: 'treatment', source_id: '7', field: 'title' },
        professional: { source: 'professional', source_id: '9', field: 'name' },
      },
      integrations: { intake_config_id: '12' },
    },
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.snapshot.treatments['7'].fields.title, 'Implantes dentales');
  assert.equal(result.snapshot.professionals['9'].fields.name, 'Dévora Prueba');
  assert.equal(result.snapshot.intake_config.id, '12');
  assert.equal(result.snapshot.intake_config.scope.inherited, true);
  const serialized = JSON.stringify(result.snapshot);
  assert.equal(serialized.includes('hmac_key'), false);
  assert.equal(serialized.includes('internal_token'), false);
  assert.equal(serialized.includes('must-never-be-frozen'), false);
}

async function testNonAdminOwnershipAndUniformNotFound() {
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
  };
  const allowEditDenyReview = async ({ featureKey }) => {
    if (featureKey === 'marketing.web.edit') return true;
    const error = new Error('forbidden');
    error.status = 403;
    throw error;
  };
  await assert.rejects(
    () => assertOwnerOrReviewer(77, 88, { type: 'clinic', id: 66 }, {
      models,
      assertFeatureAccess: allowEditDenyReview,
    }),
    (error) => error.code === 'web_resource_author_forbidden' && error.status === 403
  );
  assert.equal(await assertOwnerOrReviewer(77, 77, { type: 'clinic', id: 66 }, { models }), true);
  await assert.rejects(
    () => assertResourceScopeAccess(
      77,
      { type: 'clinic', id: 66 },
      'marketing.web.edit',
      'content_not_found',
      'La entrada no existe.',
      {
        models,
        assertFeatureAccess: async () => {
          const error = new Error('forbidden');
          error.status = 403;
          throw error;
        },
      }
    ),
    (error) => error.code === 'content_not_found' && error.status === 404
  );
}

async function testQuarantineOwnershipAndCleanup() {
  const future = new Date(Date.now() + 60_000).toISOString();
  const candidate = {
    id: 91,
    scope_type: 'clinic',
    clinica_id: 66,
    purpose: 'web_editor_media',
    status: 'quarantine',
    sensitivity: 'internal',
    created_by: 77,
    public_url: 'https://media.example.com/quarantine.webp',
    content_type: 'image/webp',
    metadata: { non_clinical_asserted: true, quarantine_expires_at: future },
  };
  assert.equal(assertPublicMediaUsable(candidate, { type: 'clinic', id: 66 }, { actorId: 77 }).id, 91);
  assert.throws(
    () => assertPublicMediaUsable(candidate, { type: 'clinic', id: 66 }, { actorId: 88 }),
    (error) => error.code === 'web_resource_author_forbidden'
  );

  const updates = [];
  const deleted = [];
  const expired = row({
    ...candidate,
    object_key: 'marketing/web-editor/clinic-66/2026/07/file.webp',
    metadata: { ...candidate.metadata, quarantine_expires_at: '2026-07-17T00:00:00.000Z' },
    update: async function update(values) { updates.push(values); Object.assign(this, values); },
  });
  const models = {
    PublicMediaAsset: {
      findAll: async () => [expired],
      findByPk: async () => expired,
    },
    WebMediaAsset: { findOne: async () => null },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const result = await cleanupExpiredQuarantinedMedia({
    now: new Date('2026-07-18T00:00:00.000Z'),
    models,
    sequelize,
    storage: { deleteWebEditorMediaObject: async (key) => deleted.push(key) },
  });
  assert.equal(result.archived, 1);
  assert.equal(updates[0].status, 'cleanup_pending');
  assert.equal(updates[1].status, 'archived');
  assert.equal(deleted.length, 1);
}

async function testCleanupRevalidatesAfterConcurrentRegistration() {
  let releaseCandidateRead;
  let candidateRead;
  const candidateReadPromise = new Promise((resolve) => { candidateRead = resolve; });
  const releaseCandidatePromise = new Promise((resolve) => { releaseCandidateRead = resolve; });
  const publicAsset = row({
    id: 92,
    scope_type: 'clinic',
    clinica_id: 66,
    grupo_clinica_id: null,
    purpose: 'web_editor_media',
    status: 'quarantine',
    sensitivity: 'internal',
    created_by: 1,
    public_url: 'https://media.example.com/concurrent.webp',
    object_key: 'marketing/web-editor/clinic-66/2026/07/concurrent.webp',
    content_type: 'image/webp',
    size_bytes: 1200,
    metadata: {
      non_clinical_asserted: true,
      quarantine_expires_at: new Date(Date.now() + 60_000).toISOString(),
      image: { width: 800, height: 600 },
    },
    update: async function update(values) { Object.assign(this, values); },
  });
  let registered = null;
  const deleted = [];
  const models = {
    ...baseModels(),
    PublicMediaAsset: {
      findAll: async () => {
        const staleCandidate = row({ ...publicAsset });
        candidateRead();
        await releaseCandidatePromise;
        return [staleCandidate];
      },
      findByPk: async () => publicAsset,
    },
    WebMediaAsset: {
      findOne: async () => registered,
      create: async (values) => {
        registered = row({ ...values, created_at: new Date(), updated_at: new Date() });
        return registered;
      },
    },
    WebAuditEvent: { create: async () => null },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const cleanupPromise = cleanupExpiredQuarantinedMedia({
    now: new Date(Date.now() + 120_000),
    models,
    sequelize,
    storage: { deleteWebEditorMediaObject: async (key) => deleted.push(key) },
  });
  await candidateReadPromise;
  await registerMedia({
    actorId: 1,
    body: {
      scope_type: 'clinic',
      scope_id: 66,
      public_media_asset_id: 92,
      title: 'Recepción',
      alt_text: 'Recepción de la clínica',
      decorative: false,
      focal_points: { desktop: { x: 50, y: 50 } },
      rights: { origin: 'owned' },
    },
    models,
    sequelize,
  });
  releaseCandidateRead();
  const cleanup = await cleanupPromise;
  assert.equal(publicAsset.status, 'active');
  assert.ok(registered);
  assert.equal(cleanup.archived, 0);
  assert.deepEqual(cleanup.failed, []);
  assert.deepEqual(deleted, []);
}

async function testCleanupRestoresQuarantineWhenObjectDeleteFails() {
  const expired = row({
    id: 93,
    purpose: 'web_editor_media',
    status: 'quarantine',
    sensitivity: 'internal',
    object_key: 'marketing/web-editor/clinic-66/2026/07/retry.webp',
    metadata: { quarantine_expires_at: '2026-07-17T00:00:00.000Z' },
    update: async function update(values) { Object.assign(this, values); },
  });
  const models = {
    PublicMediaAsset: { findAll: async () => [expired], findByPk: async () => expired },
    WebMediaAsset: { findOne: async () => null },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const result = await cleanupExpiredQuarantinedMedia({
    now: new Date('2026-07-18T00:00:00.000Z'),
    models,
    sequelize,
    storage: {
      deleteWebEditorMediaObject: async () => {
        const error = new Error('provider detail must not be persisted');
        error.code = 'AccessDenied';
        throw error;
      },
    },
  });
  assert.equal(result.archived, 0);
  assert.deepEqual(result.failed, [{ id: 93, code: 'AccessDenied' }]);
  assert.equal(expired.status, 'quarantine');
  assert.equal(expired.metadata.quarantine_cleanup_claim_id, undefined);
  assert.equal(expired.metadata.quarantine_cleanup_error, 'AccessDenied');
  assert.equal(JSON.stringify(expired.metadata).includes('provider detail'), false);
}

async function main() {
  await testCreatePersistsVersionAndAudit();
  await testContentCasConflict();
  await testRegisterMediaWrapsWithoutLeakingStorageInternals();
  testMediaProjectionRedactsLegacyInternalFields();
  testContentSnapshotRemovesInternalConsentReference();
  testPublicMediaScopeDoesNotRevealOtherTenantIds();
  await testResolverAllowsExplicitClinicToGroupInheritanceButNeverReverse();
  await testResolverFreezesCanonicalTreatmentProfessionalAndIntake();
  await testNonAdminOwnershipAndUniformNotFound();
  await testQuarantineOwnershipAndCleanup();
  await testCleanupRevalidatesAfterConcurrentRegistration();
  await testCleanupRestoresQuarantineWhenObjectDeleteFails();
  console.log('web content/media service: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
