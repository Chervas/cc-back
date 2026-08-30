'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';
process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66,group:7';
process.env.MARKETING_WEB_PUBLISHING_SCOPES = 'clinic:66,group:7';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { clinicProjection, compileRevision } = require('../../services/webArtifacts.service');
const { trustedRuntime } = require('../../lib/webMeasurementRuntime');

function row(value) {
  return {
    ...value,
    get: () => ({ ...value }),
  };
}

function fixture({
  existing = null,
  group = false,
  clinicGroupId = 7,
  clinicActive = true,
  clinicOverrides = {},
  businessLocation = null,
} = {}) {
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
          ...clinicOverrides,
        });
      },
    },
    ClinicBusinessLocation: {
      findAll: async (options) => {
        events.push({ event: 'business-location:findAll', options });
        if (!businessLocation) return [];
        if (options.where.id && Number(options.where.id) !== Number(businessLocation.id)) return [];
        return [row(businessLocation)];
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
          && storedArtifact.clinicSnapshotHash === where.clinicSnapshotHash
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

test('completa SEO/Schema con la ficha verificada única sin pisar datos canónicos', async () => {
  const state = fixture({
    clinicOverrides: {
      direccion: 'Dirección canónica 1',
      codigo_postal: '',
      ciudad: null,
      provincia: '',
      pais: 'España',
      horario_atencion: null,
      url_avatar: 'https://media.clinicaclick.com/avatars/clinic-60x60.webp',
    },
    businessLocation: {
      id: 44,
      clinica_id: 66,
      raw_payload: {
        storefrontAddress: {
          addressLines: ['Dirección de Google 9'],
          postalCode: '08022',
          locality: 'Barcelona',
          administrativeArea: 'Catalunya',
          regionCode: 'ES',
        },
        regularHours: {
          periods: [{
            openDay: 'MONDAY',
            openTime: { hours: 9 },
            closeDay: 'MONDAY',
            closeTime: { hours: 18, minutes: 30 },
          }],
        },
        clinicaclick_media_items: [{
          mediaFormat: 'VIDEO',
          googleUrl: 'https://media.clinicaclick.com/google/video-cover.webp',
          locationAssociation: { category: 'COVER' },
        }, {
          mediaFormat: 'PHOTO',
          googleUrl: 'https://media.clinicaclick.com/google/customer-cover.webp',
          locationAssociation: { category: 'COVER' },
          attribution: { profileName: 'Contenido aportado por tercero' },
        }, {
          mediaFormat: 'PHOTO',
          googleUrl: 'https://media.clinicaclick.com/google/tiny-exterior.webp',
          dimensions: { widthPixels: 60, heightPixels: 60 },
          locationAssociation: { category: 'EXTERIOR' },
        }, {
          mediaFormat: 'PHOTO',
          googleUrl: 'https://media.clinicaclick.com/google/interior.webp',
          dimensions: { widthPixels: 1600, heightPixels: 900 },
          locationAssociation: { category: 'INTERIOR' },
          createTime: '2026-07-18T10:00:00Z',
        }, {
          mediaFormat: 'PHOTO',
          googleUrl: 'https://media.clinicaclick.com/google/additional.webp',
          dimensions: { widthPixels: 2400, heightPixels: 1600 },
          locationAssociation: { category: 'ADDITIONAL' },
        }],
      },
    },
  });

  const result = await compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    models: state.models,
    sequelize: state.sequelize,
  });
  const html = result.files['index.html'];
  const structuredData = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1] || '{}');
  const schemaClinic = structuredData['@graph']?.find((entry) => entry['@type'] === 'Dentist');
  const locationLookup = state.events.find((entry) => entry?.event === 'business-location:findAll');
  assert.deepEqual(locationLookup.options.where, {
    clinica_id: 66,
    is_active: true,
    is_verified: true,
    is_suspended: false,
  });
  assert.deepEqual(locationLookup.options.order, [['id', 'ASC']]);
  assert.equal(locationLookup.options.limit, 2);
  assert.deepEqual(schemaClinic.address, {
    '@type': 'PostalAddress',
    streetAddress: 'Dirección canónica 1',
    addressLocality: 'Barcelona',
    addressRegion: 'Catalunya',
    postalCode: '08022',
    addressCountry: 'España',
  });
  assert.deepEqual(schemaClinic.openingHoursSpecification, [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: 'https://schema.org/Monday',
    opens: '09:00',
    closes: '18:30',
  }]);
  assert.equal(schemaClinic.image, undefined);
  assert.doesNotMatch(html, /<meta property="og:image"/);
  assert.doesNotMatch(html, /customer-cover|tiny-exterior|interior\.webp|additional\.webp|video-cover/);
  assert.equal(result.renderer_version, 'clinicaclick-web-renderer/1.16.0');
});

test('los campos canónicos explícitos prevalecen y un horario textual solo usa periodos Google verificados para Schema', () => {
  const projection = clinicProjection({
    id_clinica: 66,
    nombre_clinica: 'Clínica canónica',
    direccion: 'Calle Propia 1',
    codigo_postal: '28001',
    ciudad: 'Madrid',
    provincia: 'Madrid',
    pais: 'España',
    url_avatar: 'https://media.clinicaclick.com/clinics/photo-1200.webp',
    horario_atencion: 'Lunes a viernes de 9:00 a 18:00',
    estado_clinica: true,
  }, {
    raw_payload: {
      storefrontAddress: {
        addressLines: ['Calle Google 2'],
        postalCode: '08001',
        locality: 'Barcelona',
        administrativeArea: 'Catalunya',
        regionCode: 'ES',
      },
      regularHours: {
        periods: [{
          openDay: 'MONDAY',
          openTime: { hours: 8 },
          closeDay: 'MONDAY',
          closeTime: { hours: 20 },
        }],
      },
      clinicaclick_media_items: [{
        mediaFormat: 'PHOTO',
        googleUrl: 'https://media.clinicaclick.com/google/cover.webp',
        locationAssociation: { category: 'COVER' },
      }],
    },
  });

  assert.deepEqual(projection.address, {
    street_address: 'Calle Propia 1',
    locality: 'Madrid',
    region: 'Madrid',
    postal_code: '28001',
    country: 'España',
  });
  assert.equal(projection.image, 'https://media.clinicaclick.com/clinics/photo-1200.webp');
  assert.equal(projection.hours, 'Lunes a viernes de 9:00 a 18:00');
  assert.deepEqual(projection.opening_hours, [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: 'https://schema.org/Monday',
    opens: '08:00',
    closes: '20:00',
  }]);

  const structuredProjection = clinicProjection({
    id_clinica: 66,
    nombre_clinica: 'Clínica canónica',
    horario_atencion: {
      periods: [{
        openDay: 'TUESDAY',
        openTime: { hours: 10 },
        closeDay: 'TUESDAY',
        closeTime: { hours: 14 },
      }],
    },
  }, {
    raw_payload: {
      regularHours: {
        periods: [{
          openDay: 'MONDAY',
          openTime: { hours: 8 },
          closeDay: 'MONDAY',
          closeTime: { hours: 20 },
        }],
      },
    },
  });
  assert.deepEqual(structuredProjection.opening_hours, [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: 'https://schema.org/Tuesday',
    opens: '10:00',
    closes: '14:00',
  }]);
});

test('SEO usa la ficha primaria configurada y no la sincronizada más recientemente', async () => {
  const state = fixture({
    clinicOverrides: {
      direccion: '',
      codigo_postal: '',
      ciudad: '',
      provincia: '',
      horario_atencion: null,
    },
  });
  const locations = [{
    id: 44,
    clinica_id: 66,
    last_synced_at: '2026-07-19T12:00:00.000Z',
    raw_payload: {
      storefrontAddress: { addressLines: ['Ficha reciente incorrecta 44'] },
    },
  }, {
    id: 45,
    clinica_id: 66,
    last_synced_at: '2026-07-18T12:00:00.000Z',
    raw_payload: {
      storefrontAddress: {
        addressLines: ['Ficha primaria correcta 45'],
        postalCode: '08045',
        locality: 'Barcelona',
        administrativeArea: 'Catalunya',
        regionCode: 'ES',
      },
    },
  }];
  state.models.GrupoClinica.findByPk = async () => ({
    id_grupo: 7,
    business_profile_assignment_mode: 'group',
    business_profile_primary_location_id: 45,
  });
  state.models.ClinicBusinessLocation.findAll = async (options) => {
    assert.equal(options.where.id, 45);
    return locations.filter((location) => Number(location.id) === Number(options.where.id)).map(row);
  };
  const result = await compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    models: state.models,
    sequelize: state.sequelize,
  });
  assert.match(result.files['index.html'], /Ficha primaria correcta 45/);
  assert.doesNotMatch(result.files['index.html'], /Ficha reciente incorrecta 44/);
});

test('SEO no adivina entre dos fichas activas sin una selección única', async () => {
  const state = fixture({
    clinicOverrides: {
      direccion: '',
      codigo_postal: '',
      ciudad: '',
      provincia: '',
      horario_atencion: null,
    },
  });
  state.models.ClinicBusinessLocation.findAll = async () => [row({
    id: 44,
    clinica_id: 66,
    raw_payload: { storefrontAddress: { addressLines: ['Ficha ambigua 44'] } },
  }), row({
    id: 45,
    clinica_id: 66,
    raw_payload: { storefrontAddress: { addressLines: ['Ficha ambigua 45'] } },
  })];
  const result = await compileRevision({
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    models: state.models,
    sequelize: state.sequelize,
  });
  assert.doesNotMatch(result.files['index.html'], /Ficha ambigua 44|Ficha ambigua 45/);
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

test('un proyecto de grupo genera artefactos distintos por clínica y no reutiliza SEO ajeno', async () => {
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
    config: { locations: [{ id: 66 }, { id: 67 }] },
  });
  state.models.Clinica.findByPk = async (id) => row({
    id_clinica: Number(id),
    grupoClinicaId: 7,
    estado_clinica: true,
    nombre_clinica: Number(id) === 66 ? 'Clínica A' : 'Clínica B',
    direccion: Number(id) === 66 ? 'Calle A 1' : 'Calle B 2',
    codigo_postal: Number(id) === 66 ? '08001' : '08002',
    ciudad: 'Barcelona',
    provincia: 'Barcelona',
    pais: 'España',
    telefono: Number(id) === 66 ? '+34930000066' : '+34930000067',
    url_web: 'https://example.test/',
  });
  const base = {
    actorId: 1,
    revisionId: state.revision.id,
    body: {
      environment: 'preview',
      base_url: 'https://preview.sites.clinicaclick.com',
      clinic_id: 66,
    },
    models: state.models,
    sequelize: state.sequelize,
  };
  const first = await compileRevision(base);
  const second = await compileRevision({
    ...base,
    body: { ...base.body, clinic_id: 67 },
  });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.clinic_snapshot_hash, second.clinic_snapshot_hash);
  assert.notEqual(first.artifact_hash, second.artifact_hash);
  assert.match(first.files['index.html'], /Calle A 1/);
  assert.doesNotMatch(first.files['index.html'], /Calle B 2/);
  assert.match(second.files['index.html'], /Calle B 2/);
  assert.doesNotMatch(second.files['index.html'], /Calle A 1/);
  assert.equal(state.events.filter((event) => event === 'artifact:create').length, 2);
});

test('un cambio efectivo de dirección de la ficha crea un artefacto nuevo', async () => {
  const state = fixture({
    clinicOverrides: { direccion: '', codigo_postal: '', ciudad: '', provincia: '' },
    businessLocation: {
      clinica_id: 66,
      raw_payload: {
        storefrontAddress: {
          addressLines: ['Calle Google 1'],
          postalCode: '08001',
          locality: 'Barcelona',
          administrativeArea: 'Catalunya',
          regionCode: 'ES',
        },
      },
    },
  });
  const payload = {
    actorId: 1,
    revisionId: state.revision.id,
    body: { environment: 'preview', base_url: 'https://preview.sites.clinicaclick.com' },
    models: state.models,
    sequelize: state.sequelize,
  };
  const first = await compileRevision(payload);
  state.models.ClinicBusinessLocation.findAll = async () => [row({
    clinica_id: 66,
    raw_payload: {
      storefrontAddress: {
        addressLines: ['Calle Google 99'],
        postalCode: '08099',
        locality: 'Barcelona',
        administrativeArea: 'Catalunya',
        regionCode: 'ES',
      },
    },
  })];
  const second = await compileRevision(payload);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.clinic_snapshot_hash, second.clinic_snapshot_hash);
  assert.match(first.files['index.html'], /Calle Google 1/);
  assert.match(second.files['index.html'], /Calle Google 99/);
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
