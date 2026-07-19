'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { compileRevision } = require('../../services/webArtifacts.service');
const { trustedRuntime } = require('../../lib/webMeasurementRuntime');

function row(value) {
  return {
    ...value,
    get: () => ({ ...value }),
  };
}

function fixture({ existing = null, group = false, clinicGroupId = 7, clinicActive = true } = {}) {
  const events = [];
  const document = createBlankWebDocument({ name: 'Landing de prueba', locale: 'es-ES' });
  const project = row({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: group ? 'group' : 'clinic',
    clinicaId: group ? null : 66,
    grupoClinicaId: group ? 7 : null,
    name: 'Landing de prueba',
    locale: 'es-ES',
  });
  const revision = row({
    id: '22222222-2222-4222-8222-222222222222',
    projectId: project.id,
    status: 'approved',
    document,
    documentHash: 'a'.repeat(64),
    contentSnapshot: { schema_version: 1, content_entries: {}, media_assets: {}, live_bindings: [] },
  });
  let storedArtifact = existing;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    WebRevision: {
      findByPk: async (id, options) => {
        events.push(`revision:${options.lock ? 'lock' : 'pointer'}`);
        return id === revision.id ? revision : null;
      },
    },
    WebProject: {
      findByPk: async (id, options) => {
        events.push(`project:${options.lock ? 'lock' : 'read'}`);
        return id === project.id ? project : null;
      },
    },
    Clinica: {
      findAll: async () => [{ id_clinica: 66 }],
      findByPk: async (id) => {
        events.push(`clinic:${id}`);
        if (Number(id) !== 66) return null;
        return row({
          id_clinica: 66,
          grupoClinicaId: clinicGroupId,
          estado_clinica: clinicActive,
          nombre_clinica: 'Clínica segura',
          direccion: 'Carrer de la Salut 1',
          codigo_postal: '08001',
          ciudad: 'Barcelona',
          provincia: 'Barcelona',
          pais: 'España',
          telefono: '+34930000000',
          telefono_fijo: null,
          telefono_movil: null,
          email: 'hola@example.test',
          url_web: 'https://example.test/',
          horario_atencion: 'Lunes a viernes',
        });
      },
    },
    GrupoClinica: {
      findByPk: async (id) => Number(id) === 7 ? { id_grupo: 7 } : null,
    },
    IntakeConfig: {
      findByPk: async (id) => Number(id) === 12 ? {
        id: 12,
        assignment_scope: 'group',
        group_id: 7,
        config: { locations: [{ id: 66 }] },
      } : null,
    },
    WebArtifact: {
      findOne: async ({ where }) => {
        if (!storedArtifact) return null;
        return (
          storedArtifact.revisionId === where.revisionId
          && storedArtifact.rendererVersion === where.rendererVersion
          && storedArtifact.environment === where.environment
          && storedArtifact.baseUrlHash === where.baseUrlHash
          && storedArtifact.runtimeConfigHash === where.runtimeConfigHash
        ) ? storedArtifact : null;
      },
      create: async (values) => {
        events.push('artifact:create');
        storedArtifact = row({ ...values, created_at: '2026-07-17T00:00:00.000Z' });
        return storedArtifact;
      },
    },
    WebAuditEvent: {
      create: async () => { events.push('audit:create'); },
    },
  };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  return { events, models, sequelize, project, revision };
}

test('compila preview aprobado, bloquea en orden proyecto->revisión y audita', async () => {
  const state = fixture();
  const result = await compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    requestId: 'compile:test-123',
    models: state.models,
    sequelize: state.sequelize,
  });
  assert.match(result.artifact_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.environment, 'preview');
  assert.ok(result.files['index.html']);
  assert.match(result.files['index.html'], /"@type":"Dentist"/);
  assert.match(result.files['index.html'], /"@type":"PostalAddress"/);
  assert.match(result.files['index.html'], /"streetAddress":"Carrer de la Salut 1"/);
  assert.match(result.files['index.html'], /"postalCode":"08001"/);
  assert.match(result.files['index.html'], /"addressLocality":"Barcelona"/);
  assert.ok(state.events.indexOf('project:lock') < state.events.indexOf('revision:lock'));
  assert.deepEqual(state.events.slice(-2), ['artifact:create', 'audit:create']);
});

test('una segunda compilación del mismo target es idempotente', async () => {
  const state = fixture();
  const payload = {
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    models: state.models,
    sequelize: state.sequelize,
  };
  const first = await compileRevision(payload);
  const second = await compileRevision(payload);
  assert.equal(second.id, first.id);
  assert.equal(state.events.filter((event) => event === 'artifact:create').length, 1);
});

test('producción permanece cerrada mientras el gate de publicación está apagado', async () => {
  const state = fixture();
  await assert.rejects(
    () => compileRevision({
      actorId: 1,
      revisionId: state.revision.id,
      body: { environment: 'production', base_url: 'https://landing.example.test' },
      models: state.models,
      sequelize: state.sequelize,
    }),
    (error) => error.code === 'web_publishing_disabled' && error.status === 503
  );
  assert.equal(state.events.includes('artifact:create'), false);
});

test('un proyecto de grupo no puede compilar con una clínica ajena', async () => {
  const state = fixture({ group: true, clinicGroupId: 8 });
  await assert.rejects(
    () => compileRevision({
      actorId: 1,
      revisionId: state.revision.id,
      body: {
        environment: 'preview',
        base_url: 'https://preview.sites.clinicaclick.com',
        clinic_id: 66,
      },
      models: state.models,
      sequelize: state.sequelize,
    }),
    (error) => error.code === 'web_artifact_clinic_not_found' && error.status === 404
  );
});

test('un proyecto de grupo solo compila una clínica activa incluida explícitamente en locations', async () => {
  const eligible = fixture({ group: true });
  eligible.revision.document.integrations.intake_config_id = '12';
  eligible.revision.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'group', id: 7, inherited: false },
  };
  await assert.doesNotReject(() => compileRevision({
    actorId: 1,
    revisionId: eligible.revision.id,
    body: {
      environment: 'preview',
      base_url: 'https://preview.sites.clinicaclick.com',
      clinic_id: 66,
    },
    models: eligible.models,
    sequelize: eligible.sequelize,
  }));

  const excluded = fixture({ group: true });
  excluded.revision.document.integrations.intake_config_id = '12';
  excluded.revision.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'group', id: 7, inherited: false },
  };
  excluded.models.IntakeConfig.findByPk = async () => ({
    id: 12,
    assignment_scope: 'group',
    group_id: 7,
    config: { locations: [{ id: 55 }] },
  });
  await assert.rejects(
    () => compileRevision({
      actorId: 1,
      revisionId: excluded.revision.id,
      body: {
        environment: 'preview',
        base_url: 'https://preview.sites.clinicaclick.com',
        clinic_id: 66,
      },
      models: excluded.models,
      sequelize: excluded.sequelize,
    }),
    (error) => error.code === 'web_artifact_group_clinic_not_configured' && error.status === 409
  );

  const inactive = fixture({ group: true, clinicActive: false });
  inactive.revision.document.integrations.intake_config_id = '12';
  inactive.revision.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'group', id: 7, inherited: false },
  };
  await assert.rejects(
    () => compileRevision({
      actorId: 1,
      revisionId: inactive.revision.id,
      body: {
        environment: 'preview',
        base_url: 'https://preview.sites.clinicaclick.com',
        clinic_id: 66,
      },
      models: inactive.models,
      sequelize: inactive.sequelize,
    }),
    (error) => error.code === 'web_artifact_clinic_inactive' && error.status === 409
  );
});

test('una reconciliación durable puede precompilar una clínica nueva del target antes de promover IntakeConfig', async () => {
  const state = fixture({ group: true });
  state.revision.document.integrations.intake_config_id = '12';
  state.revision.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'group', id: 7, inherited: false },
  };
  state.models.IntakeConfig.findByPk = async () => ({
    id: 12,
    assignment_scope: 'group',
    group_id: 7,
    config: { locations: [{ id: 55 }] },
  });
  const normalizedRuntime = trustedRuntime({}, { environment: 'preview' });
  const staged = {
    id: '99999999-9999-4999-8999-999999999999',
    generation: 4,
    status: 'preparing',
    scopeType: 'group',
    scopeId: 7,
    targetRuntimeHash: normalizedRuntime.runtime_config_hash,
    targetConfigPatch: {
      locations: { present: true, value: [{ id: 55 }, { id: 66 }] },
    },
  };
  state.models.WebIntakeRuntimeReconciliation = {
    findByPk: async (id) => id === staged.id ? staged : null,
  };
  await assert.doesNotReject(() => compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: {
      environment: 'preview',
      base_url: 'https://preview.sites.clinicaclick.com',
      clinic_id: 66,
    },
    runtimeReconciliation: { id: staged.id, generation: 4 },
    models: state.models,
    sequelize: state.sequelize,
  }));
  await assert.rejects(
    () => compileRevision({
      actorId: 1,
      revisionId: state.revision.id,
      body: {
        environment: 'preview',
        base_url: 'https://preview.sites.clinicaclick.com',
        clinic_id: 66,
      },
      runtimeReconciliation: { id: staged.id, generation: 5 },
      models: state.models,
      sequelize: state.sequelize,
    }),
    (error) => error.code === 'web_artifact_runtime_reconciliation_invalid'
  );
});

test('el body del editor no puede inyectar el runtime interno de medición', async () => {
  const state = fixture();
  const result = await compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: {
      environment: 'preview',
      base_url: 'https://preview.sites.clinicaclick.com',
      trustedRuntime: {
        measurement: {
          enabled: true,
          scope_type: 'clinic',
          scope_id: 66,
          api_url: 'https://evil.example.test',
          hmac_key: '0123456789abcdef0123456789abcdef',
          consent_provider: 'clinicaclick',
        },
      },
    },
    models: state.models,
    sequelize: state.sequelize,
  });
  assert.doesNotMatch(result.files['index.html'], /evil\.example\.test|data-hmac-key/);
});

test('producción con formularios falla cerrado si no existe medición segura', async () => {
  const state = fixture();
  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'true';
  try {
    await assert.rejects(
      () => compileRevision({
        actorId: 1,
        revisionId: state.revision.id,
        body: { environment: 'production', base_url: 'https://landing.example.test' },
        models: state.models,
        sequelize: state.sequelize,
      }),
      (error) => error.code === 'web_artifact_measurement_required' && error.status === 409
    );
  } finally {
    process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';
  }
});

test('rotar HMAC genera un artefacto nuevo para el mismo target', async () => {
  const state = fixture();
  state.revision.document.integrations.intake_config_id = '12';
  state.revision.document.consent = {
    provider: 'clinicaclick',
    preview_mode: false,
    privacy_policy_url: 'https://example.test/privacidad/',
    privacy_policy_version: '2026-07',
    privacy_consent_text: 'Acepto la política de privacidad.',
  };
  state.revision.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'clinic', id: 66, inherited: false },
  };
  const runtime = (hmac) => ({
    measurement: {
      enabled: true,
      scope_type: 'clinic',
      scope_id: 66,
      api_url: 'https://crm.clinicaclick.com',
      loader_path: '/assets/loader.js',
      hmac_key: hmac,
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
    },
  });
  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'true';
  try {
    const base = {
      actorId: 1,
      revisionId: state.revision.id,
      body: { environment: 'production', base_url: 'https://landing.example.test' },
      models: state.models,
      sequelize: state.sequelize,
    };
    const first = await compileRevision({ ...base, trustedRuntime: runtime('0123456789abcdef0123456789abcdef') });
    const second = await compileRevision({ ...base, trustedRuntime: runtime('abcdef0123456789abcdef0123456789') });
    assert.notEqual(first.runtime_config_hash, second.runtime_config_hash);
    assert.notEqual(first.artifact_hash, second.artifact_hash);
    assert.equal(state.events.filter((event) => event === 'artifact:create').length, 2);
  } finally {
    process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';
  }
});
