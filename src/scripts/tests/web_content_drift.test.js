'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';

const assert = require('node:assert/strict');
const {
  compareFrozenResourceSnapshots,
  getWebProjectContentDrift,
} = require('../../services/webContentDrift.service');
const { snapshotContent } = require('../../services/webResourceResolver.service');

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
  };
}

function content(id, version, summary) {
  return row({
    id,
    version,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'published',
    type: 'value_proposition',
    locale: 'es-ES',
    title: 'Implantes',
    content: { summary },
    sources: [],
    contentHash: String(version).repeat(64),
  });
}

function snapshotWith(entry) {
  return {
    schema_version: 1,
    content_entries: entry ? { [entry.id]: snapshotContent(entry, false) } : {},
    media_assets: {},
    live_bindings: [],
    treatments: {},
    professionals: {},
    intake_config: { id: 'old-intake-that-must-be-ignored' },
  };
}

function testDeterministicComparisonIgnoresIntakeAndLiveBindings() {
  const oldEntry = content('content_1', 1, 'Texto aprobado');
  const approved = snapshotWith(oldEntry);
  const reordered = {
    ...snapshotWith(oldEntry),
    live_bindings: [{ source: 'clinic', source_id: '66', field: 'phone' }],
    intake_config: { id: 'new-intake-that-must-be-ignored' },
  };
  const current = {
    snapshot: reordered,
    unresolved: [],
  };
  const comparison = compareFrozenResourceSnapshots(approved, current);
  assert.equal(comparison.status, 'current');
  assert.equal(comparison.has_changes, false);
  assert.equal(comparison.approved_snapshot_hash, comparison.current_snapshot_hash);

  current.snapshot.content_entries.content_1 = snapshotContent(content('content_1', 2, 'Texto nuevo'), false);
  const updated = compareFrozenResourceSnapshots(approved, current);
  assert.equal(updated.status, 'changed');
  assert.deepEqual(updated.changes, [{ kind: 'content_entry', id: 'content_1', change: 'updated' }]);

  current.unresolved = [{ kind: 'content_entry', id: 'content_1', reason: 'field_unavailable' }];
  const unavailable = compareFrozenResourceSnapshots(approved, current);
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.changes, [{
    kind: 'content_entry', id: 'content_1', change: 'unavailable', reason: 'field_unavailable',
  }]);
}

async function testProjectCheckReResolvesOnlyFrozenResourcesInsideScope() {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const revisionId = '22222222-2222-4222-8222-222222222222';
  const oldEntry = content('content_1', 1, 'Texto aprobado');
  const currentEntry = content('content_1', 2, 'Texto actualizado');
  const document = {
    integrations: { intake_config_id: '99' },
    seo: { default_social_asset_id: null },
    pages: [],
    nodes: {},
    bindings: {
      binding_1: {
        source: 'content_entry',
        source_id: 'content_1',
        field: 'description',
      },
    },
  };
  const project = row({
    id: projectId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
  });
  const revision = row({
    id: revisionId,
    projectId,
    revisionNumber: 4,
    status: 'approved',
    document,
    contentSnapshot: snapshotWith(oldEntry),
  });
  let intakeQueries = 0;
  const models = {
    Clinica: {
      findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 7 }),
      findAll: async () => [],
    },
    GrupoClinica: {},
    WebProject: { findByPk: async () => project },
    WebRevision: {
      findOne: async () => revision,
      findByPk: async () => revision,
    },
    WebPublication: { findOne: async () => null },
    WebContentEntry: { findAll: async () => [currentEntry] },
    WebMediaAsset: { findAll: async () => [] },
    IntakeConfig: {
      findAll: async () => { intakeQueries += 1; throw new Error('Intake no forma parte de este drift'); },
    },
  };
  const result = await getWebProjectContentDrift({
    actorId: 1,
    projectId,
    models,
    assertFeatureAccess: async () => true,
  });
  assert.equal(intakeQueries, 0);
  assert.equal(result.status, 'changed');
  assert.equal(result.revision_id, revisionId);
  assert.equal(result.revision_number, 4);
  assert.equal(result.basis, 'approved');
  assert.deepEqual(result.changes, [{ kind: 'content_entry', id: 'content_1', change: 'updated' }]);

  revision.status = 'superseded';
  models.WebPublication.findOne = async ({ where }) => (
    where.activeRevisionId === revisionId ? { id: 'publication_1', activeRevisionId: revisionId } : null
  );
  const published = await getWebProjectContentDrift({
    actorId: 1,
    projectId,
    revisionId,
    models,
    assertFeatureAccess: async () => true,
  });
  assert.equal(published.basis, 'published');

  models.WebPublication.findOne = async () => null;
  await assert.rejects(
    () => getWebProjectContentDrift({
      actorId: 1,
      projectId,
      revisionId,
      models,
      assertFeatureAccess: async () => true,
    }),
    (error) => error.code === 'revision_not_approved_or_published' && error.status === 409
  );
}

async function main() {
  testDeterministicComparisonIgnoresIntakeAndLiveBindings();
  await testProjectCheckReResolvesOnlyFrozenResourcesInsideScope();
  console.log('web content drift: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
