#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const { Op } = require('sequelize');

const db = require('../../../models');
const jobRequestsService = require('../../services/jobRequests.service');
const whatsappController = require('../../controllers/whatsapp.controller');
const whatsappTemplatesService = require('../../services/whatsappTemplates.service');
const {
  shouldKeepRemoteTemplateActive,
} = require('../../lib/whatsapp-template-pending-resubmission');

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('la retirada manual escribe un tombstone auditable distinto del estado remoto', async () => {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindByPk: db.WhatsappTemplate.findByPk,
    marketingListCount: db.MarketingPatientList.count,
  };
  const updates = [];
  const row = {
    id: 801,
    is_active: true,
    clinic_id: 56,
    waba_id: 'waba-propdental',
    status: 'APPROVED',
    catalog_template_id: null,
    origin: 'custom',
    created_by_user_id: 76,
    get() { return { ...this }; },
    async update(values) {
      updates.push(values);
      Object.assign(this, values);
      return this;
    },
  };

  db.UsuarioClinica.findAll = async () => [{
    id_clinica: 56,
    rol_clinica: 'propietario',
    estado_invitacion: 'aceptada',
  }];
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'clinic',
    clinicaId: 56,
    grupoClinicaId: 5,
    wabaId: 'waba-propdental',
    metaConnection: { userId: 76 },
  });
  db.WhatsappTemplate.findByPk = async () => row;
  db.MarketingPatientList.count = async () => 0;

  try {
    const res = responseRecorder();
    await whatsappController.deleteTemplate({
      params: { id: '801' },
      query: {},
      body: {},
      userData: { userId: 76 },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, id: 801 });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].is_active, false);
    assert.equal(updates[0].retired_by_user_id, 76);
    assert.ok(updates[0].retired_at instanceof Date);
    assert.equal(row.status, 'APPROVED', 'retirar no falsifica el estado devuelto por Meta');
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findByPk = originals.templateFindByPk;
    db.MarketingPatientList.count = originals.marketingListCount;
  }
});

test('reemplazar una plantilla enlaza de forma durable la versión anterior con la nueva', async () => {
  const originals = {
    templateFindByPk: db.WhatsappTemplate.findByPk,
    templateCreate: db.WhatsappTemplate.create,
    templateUpdate: db.WhatsappTemplate.update,
    marketingListFindAll: db.MarketingPatientList.findAll,
    enqueueUniqueJobRequest: jobRequestsService.enqueueUniqueJobRequest,
    axiosPost: axios.post,
  };
  const replacementUpdates = [];
  const source = {
    id: 901,
    is_active: true,
    clinic_id: null,
    waba_id: 'waba-propdental',
    display_name: 'Confirmación propia',
    created_by_user_id: 76,
  };
  const created = {
    id: 902,
    clinic_id: 56,
    waba_id: 'waba-propdental',
    name: 'cc_confirmacion_propia_new',
    display_name: 'Confirmación propia',
    language: 'es',
    status: 'PENDING',
    components: [{ type: 'BODY', text: 'Hola, te confirmamos la cita.' }],
    variables: [],
  };

  db.WhatsappTemplate.findByPk = async (id) => (Number(id) === source.id ? source : null);
  db.WhatsappTemplate.create = async (values) => {
    Object.assign(created, values);
    return created;
  };
  db.WhatsappTemplate.update = async (values, options) => {
    replacementUpdates.push({ values, options });
    return [1];
  };
  db.MarketingPatientList.findAll = async () => [];
  jobRequestsService.enqueueUniqueJobRequest = async () => ({ job: { id: 9902 } });
  axios.post = async () => ({ data: { id: 'meta-template-902' } });

  try {
    const result = await whatsappTemplatesService.createCustomTemplateForClinic({
      clinicId: 56,
      wabaId: 'waba-propdental',
      accessToken: 'test-token-not-real',
      displayName: 'Confirmación propia',
      bodyText: 'Hola, te confirmamos la cita.',
      replaceTemplateId: source.id,
      createdByUserId: 76,
    });

    assert.equal(result.submitted, true);
    assert.equal(result.row.id, 902);
    assert.equal(replacementUpdates.length, 1);
    assert.deepEqual(replacementUpdates[0].values, {
      is_active: false,
      superseded_by_template_id: 902,
    });
    assert.equal(replacementUpdates[0].options.where.waba_id, 'waba-propdental');
    assert.equal(replacementUpdates[0].options.where.created_by_user_id, 76);
    assert.equal(replacementUpdates[0].options.where.clinic_id, undefined);
    assert.ok(
      replacementUpdates[0].options.where[Op.or].some((selector) => selector.id === 901),
      'la fila compartida elegida debe retirarse aunque clinic_id sea NULL',
    );
    assert.ok(
      replacementUpdates[0].options.where[Op.or].some(
        (selector) => selector.display_name === 'Confirmación propia' && selector.clinic_id === 56,
      ),
      'el barrido de versiones homónimas debe permanecer limitado a la clínica editada',
    );
  } finally {
    db.WhatsappTemplate.findByPk = originals.templateFindByPk;
    db.WhatsappTemplate.create = originals.templateCreate;
    db.WhatsappTemplate.update = originals.templateUpdate;
    db.MarketingPatientList.findAll = originals.marketingListFindAll;
    jobRequestsService.enqueueUniqueJobRequest = originals.enqueueUniqueJobRequest;
    axios.post = originals.axiosPost;
  }
});

test('una plantilla personalizada de reseñas conserva la cabecera de imagen preparada para Meta', async () => {
  const originals = {
    templateCreate: db.WhatsappTemplate.create,
    enqueueUniqueJobRequest: jobRequestsService.enqueueUniqueJobRequest,
    axiosGet: axios.get,
    axiosPost: axios.post,
    reviewHeaderHandle: process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE,
    genericHeaderHandle: process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE,
  };
  const created = [];
  let postIndex = 0;

  delete process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE;
  delete process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE;
  db.WhatsappTemplate.create = async (values) => {
    const row = { id: 903, ...values };
    created.push(row);
    return row;
  };
  jobRequestsService.enqueueUniqueJobRequest = async () => ({ job: { id: 9903 } });
  axios.get = async () => ({
    data: Buffer.from('valid-public-image-sample'),
    headers: { 'content-type': 'image/jpeg' },
  });
  axios.post = async () => {
    postIndex += 1;
    if (postIndex === 1) return { data: { id: 'upload-session-903' } };
    if (postIndex === 2) return { data: { h: 'meta-image-handle-903' } };
    return { data: { id: 'meta-template-903' } };
  };

  try {
    const result = await whatsappTemplatesService.createCustomTemplateForClinic({
      clinicId: 57,
      wabaId: 'waba-propdental',
      accessToken: 'test-token-not-real',
      displayName: 'Solicitud de opinión personalizada',
      bodyText: [
        '¡Hola {{nombre_paciente}}! Soy {{firma_resenas}} de {{nombre_clinica}}.',
        'Responde con un número para indicar tu valoración:',
        '5 ⭐⭐⭐⭐⭐',
        '4 ⭐⭐⭐⭐',
        '3 ⭐⭐⭐',
        '2 ⭐⭐',
        '1 ⭐',
      ].join('\n'),
      headerImageUrl: 'https://media.clinicaclick.com/templates/reviews/team-example.jpg',
      category: 'MARKETING',
      templateUsage: 'solicitud_resena',
      createdByUserId: 1,
    });

    assert.equal(result.submitted, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].category, 'MARKETING');
    assert.equal(created[0].components[0].type, 'HEADER');
    assert.equal(created[0].components[0].format, 'IMAGE');
    assert.deepEqual(created[0].components[0].example.header_handle, ['meta-image-handle-903']);
    assert.equal(created[0].components[1].type, 'BODY');
  } finally {
    db.WhatsappTemplate.create = originals.templateCreate;
    jobRequestsService.enqueueUniqueJobRequest = originals.enqueueUniqueJobRequest;
    axios.get = originals.axiosGet;
    axios.post = originals.axiosPost;
    if (originals.reviewHeaderHandle === undefined) {
      delete process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE;
    } else {
      process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE = originals.reviewHeaderHandle;
    }
    if (originals.genericHeaderHandle === undefined) {
      delete process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE;
    } else {
      process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE = originals.genericHeaderHandle;
    }
  }
});

test('el sync de Meta no reactiva plantillas retiradas ni reemplazadas', async () => {
  const originals = {
    axiosGet: axios.get,
    catalogFindAll: db.WhatsappTemplateCatalog.findAll,
    templateFindOne: db.WhatsappTemplate.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
    assetFindAll: db.ClinicMetaAsset.findAll,
  };
  const rows = new Map([
    ['retirada_manual', {
      id: 1001,
      name: 'retirada_manual',
      language: 'es',
      status: 'APPROVED',
      is_active: false,
      retired_at: new Date('2026-07-17T08:00:00.000Z'),
      retired_by_user_id: 76,
      superseded_by_template_id: null,
    }],
    ['version_reemplazada', {
      id: 1002,
      name: 'version_reemplazada',
      language: 'es',
      status: 'APPROVED',
      is_active: false,
      retired_at: null,
      superseded_by_template_id: 1003,
    }],
    ['rechazada_remota', {
      id: 1004,
      name: 'rechazada_remota',
      language: 'es',
      status: 'PENDING',
      is_active: false,
      retired_at: null,
      superseded_by_template_id: null,
    }],
  ]);
  const updates = new Map();
  for (const row of rows.values()) {
    row.update = async function update(values) {
      updates.set(this.name, values);
      Object.assign(this, values);
      return this;
    };
  }

  axios.get = async () => ({
    data: {
      data: [
        { id: 'meta-1001', name: 'retirada_manual', language: 'es', status: 'APPROVED' },
        { id: 'meta-1002', name: 'version_reemplazada', language: 'es', status: 'APPROVED' },
        { id: 'meta-1004', name: 'rechazada_remota', language: 'es', status: 'REJECTED' },
      ],
    },
  });
  db.WhatsappTemplateCatalog.findAll = async () => [];
  db.WhatsappTemplate.findOne = async ({ where }) => rows.get(where.name) || null;
  db.WhatsappTemplate.findAll = async () => [];
  db.ClinicMetaAsset.findAll = async () => [];

  try {
    await whatsappTemplatesService.syncTemplatesForWaba({
      wabaId: 'waba-propdental',
      accessToken: 'test-token-not-real',
    });

    assert.equal(updates.get('retirada_manual').is_active, false);
    assert.equal(rows.get('retirada_manual').retired_by_user_id, 76);
    assert.equal(updates.get('version_reemplazada').is_active, false);
    assert.equal(rows.get('version_reemplazada').superseded_by_template_id, 1003);
    assert.equal(updates.get('rechazada_remota').is_active, true);
    assert.equal(updates.get('rechazada_remota').status, 'REJECTED');
  } finally {
    axios.get = originals.axiosGet;
    db.WhatsappTemplateCatalog.findAll = originals.catalogFindAll;
    db.WhatsappTemplate.findOne = originals.templateFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
    db.ClinicMetaAsset.findAll = originals.assetFindAll;
  }
});

test('la decisión de activación distingue tombstones de simples estados locales', () => {
  assert.equal(shouldKeepRemoteTemplateActive({
    existing: { is_active: false, retired_at: '2026-07-17T08:00:00.000Z' },
  }), false);
  assert.equal(shouldKeepRemoteTemplateActive({
    existing: { is_active: false, superseded_by_template_id: 1003 },
  }), false);
  assert.equal(shouldKeepRemoteTemplateActive({
    existing: { is_active: false, retired_at: null, superseded_by_template_id: null },
  }), true);
});

test('la migración de retirada es aditiva y no reescribe estados históricos', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260717120000-add-whatsapp-template-manual-retirement.js'),
    'utf8',
  );
  assert.match(migration, /addColumn\(TABLE, 'retired_at'/);
  assert.match(migration, /addColumn\(TABLE, 'retired_by_user_id'/);
  assert.doesNotMatch(migration, /\bUPDATE\s+[`\w]/i);
});
