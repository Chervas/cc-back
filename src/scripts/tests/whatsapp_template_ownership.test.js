'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Op } = require('sequelize');
const db = require('../../../models');
const whatsappController = require('../../controllers/whatsapp.controller');

const {
  canUserAccessWhatsappTemplateAsset,
  canUserSelectWhatsappTemplate,
  filterWhatsappTemplatesForUser,
  isLegacyUnassignedWhatsappTemplate,
  isSystemWhatsappTemplate,
  isWhatsappTemplateOwnedByUser,
} = require('../../lib/whatsapp-template-ownership');
const { getAccessibleMarketingClinicIds } = require('../../lib/marketingScopeAccess');
const { STAFF_ROLES } = require('../../lib/role-helpers');

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

test('el catálogo de sistema sigue visible para cualquier usuario', () => {
  const catalog = { id: 1, catalog_template_id: 9, origin: 'external' };
  const catalogByOrigin = { id: 2, catalog_template_id: null, origin: 'catalog' };
  const legacySystem = { id: 5, catalog_template_id: null, origin: 'external', name: 'clinicaclick_recordatorio_mismo_dia' };
  const untrustedPrefix = { id: 6, catalog_template_id: null, origin: 'external', name: 'clinicaclick_plantilla_creada_fuera' };

  assert.equal(isSystemWhatsappTemplate(catalog), true);
  assert.equal(canUserSelectWhatsappTemplate(catalog, 44), true);
  assert.equal(canUserSelectWhatsappTemplate(catalogByOrigin, 77), true);
  assert.equal(canUserSelectWhatsappTemplate(legacySystem, 77), true);
  assert.equal(isSystemWhatsappTemplate(untrustedPrefix), false);
  assert.equal(isLegacyUnassignedWhatsappTemplate(untrustedPrefix), true);
  assert.equal(canUserSelectWhatsappTemplate(untrustedPrefix, 77), true);
});

test('una plantilla personal solo pertenece al usuario creador', () => {
  const personal = {
    id: 3,
    catalog_template_id: null,
    origin: 'custom',
    created_by_user_id: 76,
  };

  assert.equal(isWhatsappTemplateOwnedByUser(personal, 76), true);
  assert.equal(canUserSelectWhatsappTemplate(personal, 76), true);
  assert.equal(canUserSelectWhatsappTemplate(personal, 77), false);
});

test('la sincronización puede cambiar origin sin perder la propiedad funcional', () => {
  const syncedPersonal = {
    id: 4,
    catalog_template_id: null,
    origin: 'external',
    created_by_user_id: 76,
  };

  assert.equal(canUserSelectWhatsappTemplate(syncedPersonal, 76), true);
  assert.equal(canUserSelectWhatsappTemplate(syncedPersonal, 77), false);
});

test('las filas históricas sin autor se conservan como anteriores, sin atribuirlas a la cuenta Meta', () => {
  const rows = [
    { id: 1, catalog_template_id: 9, origin: 'catalog' },
    { id: 2, catalog_template_id: null, origin: 'custom', created_by_user_id: 76 },
    { id: 3, catalog_template_id: null, origin: 'custom', created_by_user_id: 77 },
    { id: 4, catalog_template_id: null, origin: 'external', created_by_user_id: null },
  ];

  assert.deepEqual(
    filterWhatsappTemplatesForUser(rows, 76).map((row) => row.id),
    [1, 2, 4]
  );
  assert.equal(isLegacyUnassignedWhatsappTemplate(rows[3]), true);
  assert.equal(isWhatsappTemplateOwnedByUser(rows[3], 76), false);
  assert.equal(isLegacyUnassignedWhatsappTemplate(rows[1]), false);
});

test('ser propietario local no convierte un activo ajeno en acceso global', () => {
  const clinicAsset = { assignmentScope: 'clinic', clinicaId: 57 };
  const groupAsset = { assignmentScope: 'group', grupoClinicaId: 5 };
  const ownUnassigned = { assignmentScope: 'unassigned', metaConnection: { userId: 76 } };

  assert.equal(canUserAccessWhatsappTemplateAsset({
    asset: clinicAsset,
    userId: 76,
    accessibleClinicIds: [56],
    accessibleGroupIds: [5],
  }), false);
  assert.equal(canUserAccessWhatsappTemplateAsset({
    asset: groupAsset,
    userId: 76,
    accessibleClinicIds: [56],
    accessibleGroupIds: [5],
  }), true);
  assert.equal(canUserAccessWhatsappTemplateAsset({ asset: ownUnassigned, userId: 76 }), true);
  assert.equal(canUserAccessWhatsappTemplateAsset({
    asset: clinicAsset,
    userId: 1,
    isGlobalAdmin: true,
  }), true);
});

test('el scope de plantillas exige staff activo y excluye paciente o invitación no aceptada', async () => {
  let capturedWhere = null;
  const membershipModel = {
    async findAll({ where }) {
      capturedWhere = where;
      return [{ id_clinica: 56 }];
    },
  };
  const accessible = await getAccessibleMarketingClinicIds({
    userId: 76,
    clinicIds: [56, 57],
    access: 'read',
    membershipModel,
    globalAdminCheck: () => false,
  });

  assert.deepEqual(accessible, [56]);
  assert.deepEqual(capturedWhere.rol_clinica[Op.in], STAFF_ROLES);
  assert.equal(capturedWhere.rol_clinica[Op.in].includes('paciente'), false);
  assert.deepEqual(
    capturedWhere[Op.or],
    [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }],
  );
});

test('listar una clínica ajena responde 403 antes de consultar plantillas', async () => {
  const originalMembershipFindAll = db.UsuarioClinica.findAll;
  const originalTemplateFindAll = db.WhatsappTemplate.findAll;
  let templateReads = 0;
  db.UsuarioClinica.findAll = async ({ where }) => {
    if (where.id_clinica) return [];
    return [{ id_clinica: 56, rol_clinica: 'propietario' }];
  };
  db.WhatsappTemplate.findAll = async () => {
    templateReads += 1;
    return [];
  };

  try {
    const res = responseRecorder();
    await whatsappController.listTemplatesForClinic({
      query: { clinic_id: '57' },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'whatsapp_template_clinic_scope_forbidden' });
    assert.equal(templateReads, 0);
  } finally {
    db.UsuarioClinica.findAll = originalMembershipFindAll;
    db.WhatsappTemplate.findAll = originalTemplateFindAll;
  }
});

test('un phone_number_id ajeno no permite leer plantillas aunque el actor sea propietario local', async () => {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
  };
  let templateReads = 0;
  db.UsuarioClinica.findAll = async ({ where }) => {
    if (where.id_clinica) return [{ id_clinica: 56 }];
    return [{ id_clinica: 56, rol_clinica: 'propietario' }];
  };
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'clinic',
    clinicaId: 57,
    grupoClinicaId: 5,
    wabaId: 'waba-other-clinic',
    metaConnection: { userId: 91 },
  });
  db.WhatsappTemplate.findAll = async () => {
    templateReads += 1;
    return [];
  };

  try {
    const res = responseRecorder();
    await whatsappController.listTemplatesForClinic({
      query: { phone_number_id: 'phone-other-clinic' },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
    assert.equal(templateReads, 0);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
  }
});

test('sync y creación rechazan la clínica ajena antes de resolver activos', async () => {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
  };
  let assetReads = 0;
  db.UsuarioClinica.findAll = async ({ where }) => {
    if (where.id_clinica) return [];
    return [{ id_clinica: 56, rol_clinica: 'propietario' }];
  };
  db.ClinicMetaAsset.findOne = async () => {
    assetReads += 1;
    return null;
  };

  const cases = [
    ['sync', whatsappController.syncTemplates, { query: { clinic_id: '57' } }],
    ['catalog', whatsappController.createTemplatesFromCatalog, { query: { clinic_id: '57' } }],
    ['custom', whatsappController.createCustomTemplate, { query: {}, body: { clinic_id: 57 } }],
  ];
  try {
    for (const [label, handler, request] of cases) {
      const res = responseRecorder();
      await handler({ ...request, userData: { userId: 76 } }, res);
      assert.equal(res.statusCode, 403, label);
      assert.equal(res.body?.error, 'whatsapp_template_clinic_scope_forbidden', label);
    }
    assert.equal(assetReads, 0);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
  }
});

test('el autor tampoco puede retirar una plantilla si ya no tiene acceso a su activo', async () => {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindByPk: db.WhatsappTemplate.findByPk,
  };
  let templateUpdated = false;
  db.UsuarioClinica.findAll = async ({ where }) => {
    if (where.id_clinica) return [{ id_clinica: 56 }];
    return [{ id_clinica: 56, rol_clinica: 'propietario' }];
  };
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'clinic',
    clinicaId: 57,
    grupoClinicaId: 5,
    wabaId: 'waba-other-clinic',
    metaConnection: { userId: 91 },
  });
  db.WhatsappTemplate.findByPk = async () => ({
    id: 800,
    is_active: true,
    clinic_id: 57,
    waba_id: 'waba-other-clinic',
    catalog_template_id: null,
    origin: 'custom',
    created_by_user_id: 76,
    get() { return { ...this }; },
    async update() { templateUpdated = true; },
  });

  try {
    const res = responseRecorder();
    await whatsappController.deleteTemplate({
      params: { id: '800' },
      query: {},
      body: {},
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.error, 'template_scope_forbidden');
    assert.equal(templateUpdated, false);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findByPk = originals.templateFindByPk;
  }
});

test('el envío directo bloquea texto libre desde una clínica ajena antes de resolver activos', async () => {
const whatsappService = require('../../services/whatsapp.service');
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    getClinicConfig: whatsappService.getClinicConfig,
    sendMessage: whatsappService.sendMessage,
  };
  let configReads = 0;
  let sends = 0;
  db.UsuarioClinica.findAll = async () => [];
  whatsappService.getClinicConfig = async () => {
    configReads += 1;
    return null;
  };
  whatsappService.sendMessage = async () => {
    sends += 1;
    return {};
  };

  try {
    const res = responseRecorder();
    await whatsappController.sendMessage({
      body: { clinic_id: 57, to: '+34600000000', message: 'Hola' },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.error, 'whatsapp_template_clinic_scope_forbidden');
    assert.equal(configReads, 0);
    assert.equal(sends, 0);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    whatsappService.sendMessage = originals.sendMessage;
  }
});

test('el envío directo de plantilla usa nombre e idioma canónicos del WABA', async () => {
  const whatsappService = require('../../services/whatsapp.service');
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
    normalizePhoneNumber: whatsappService.normalizePhoneNumber,
    getClinicConfig: whatsappService.getClinicConfig,
    sendMessage: whatsappService.sendMessage,
  };
  const sentPayloads = [];
  let capturedAssetWhere = null;
  let capturedTemplateWhere = null;
  db.UsuarioClinica.findAll = async () => [{ id_clinica: 56, rol_clinica: 'propietario' }];
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async ({ where }) => {
    capturedAssetWhere = where;
    return {
      assignmentScope: 'group',
      clinicaId: null,
      grupoClinicaId: 5,
      phoneNumberId: 'phone-56',
      wabaId: 'waba-5',
      waAccessToken: 'scoped-token',
      metaConnection: { userId: 91 },
    };
  };
  db.WhatsappTemplate.findAll = async ({ where }) => {
    capturedTemplateWhere = where;
    return [{
      id: 901,
      waba_id: 'waba-5',
      clinic_id: 56,
      name: 'nombre_canonico',
      language: 'es',
      status: 'APPROVED',
      is_active: true,
      origin: 'custom',
      catalog_template_id: null,
      created_by_user_id: 76,
      get() { return { ...this }; },
    }];
  };
  whatsappService.normalizePhoneNumber = () => '34600000000';
  whatsappService.getClinicConfig = async () => ({
    phoneNumberId: 'phone-56',
    accessToken: 'scoped-token',
    wabaId: 'waba-5',
  });
  whatsappService.sendMessage = async (payload) => {
    sentPayloads.push(payload);
    return { messages: [{ id: 'wamid.1' }] };
  };

  try {
    const res = responseRecorder();
    await whatsappController.sendMessage({
      body: {
        clinic_id: 56,
        to: '+34600000000',
        useTemplate: true,
        templateId: 901,
        templateName: 'nombre_manipulado',
        templateLanguage: 'en_US',
      },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.messageId, 'wamid.1');
    assert.equal(capturedAssetWhere.isActive, true);
    assert.equal(capturedAssetWhere.phoneNumberId, 'phone-56');
    assert.equal(capturedAssetWhere.wabaId, 'waba-5');
    assert.equal(capturedTemplateWhere.waba_id, 'waba-5');
    assert.equal(capturedTemplateWhere.id, 901);
    assert.equal(capturedTemplateWhere.status, 'APPROVED');
    assert.equal(capturedTemplateWhere.is_active, true);
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].templateName, 'nombre_canonico');
    assert.equal(sentPayloads[0].templateLanguage, 'es');
    assert.equal(sentPayloads[0].clinicConfig.phoneNumberId, 'phone-56');
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
    whatsappService.normalizePhoneNumber = originals.normalizePhoneNumber;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    whatsappService.sendMessage = originals.sendMessage;
  }
});

test('una plantilla anterior aprobada sigue enviable en su scope sin adjudicar autoría', async () => {
  const whatsappService = require('../../services/whatsapp.service');
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
    normalizePhoneNumber: whatsappService.normalizePhoneNumber,
    getClinicConfig: whatsappService.getClinicConfig,
    sendMessage: whatsappService.sendMessage,
  };
  let sends = 0;
  db.UsuarioClinica.findAll = async () => [{ id_clinica: 56, rol_clinica: 'personaldeclinica' }];
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'group',
    grupoClinicaId: 5,
    phoneNumberId: 'phone-56',
    wabaId: 'waba-5',
    waAccessToken: 'scoped-token',
    metaConnection: { userId: 91 },
  });
  db.WhatsappTemplate.findAll = async () => [{
    id: 904,
    waba_id: 'waba-5',
    clinic_id: 56,
    name: 'plantilla_anterior',
    language: 'es_ES',
    status: 'APPROVED',
    is_active: true,
    origin: 'external',
    catalog_template_id: null,
    created_by_user_id: null,
    get() { return { ...this }; },
  }];
  whatsappService.normalizePhoneNumber = () => '34600000000';
  whatsappService.getClinicConfig = async () => ({
    phoneNumberId: 'phone-56',
    accessToken: 'scoped-token',
    wabaId: 'waba-5',
  });
  whatsappService.sendMessage = async (payload) => {
    sends += 1;
    assert.equal(payload.templateName, 'plantilla_anterior');
    assert.equal(payload.templateLanguage, 'es_ES');
    return { messages: [{ id: 'wamid.legacy' }] };
  };

  try {
    const res = responseRecorder();
    await whatsappController.sendMessage({
      body: { clinic_id: 56, to: '+34600000000', useTemplate: true, templateId: 904 },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.messageId, 'wamid.legacy');
    assert.equal(sends, 1);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
    whatsappService.normalizePhoneNumber = originals.normalizePhoneNumber;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    whatsappService.sendMessage = originals.sendMessage;
  }
});

test('el listado etiqueta una histórica como Anterior, enviable y de solo lectura', async () => {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
    flowFindAll: db.AutomationFlowTemplateV2.findAll,
    treatmentFindAll: db.Tratamiento.findAll,
  };
  let templateQuery = 0;
  db.UsuarioClinica.findAll = async () => [{ id_clinica: 56, rol_clinica: 'personaldeclinica' }];
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'group',
    grupoClinicaId: 5,
    phoneNumberId: 'phone-56',
    wabaId: 'waba-5',
    waAccessToken: 'scoped-token',
    metaConnection: { userId: 91 },
  });
  db.WhatsappTemplate.findAll = async () => {
    templateQuery += 1;
    if (templateQuery === 1) return [];
    return [{
      id: 905,
      waba_id: 'waba-5',
      clinic_id: 56,
      name: 'historica_scope',
      language: 'es',
      status: 'APPROVED',
      is_active: true,
      origin: 'external',
      catalog_template_id: null,
      created_by_user_id: null,
      toJSON() { return { ...this, toJSON: undefined }; },
    }];
  };
  db.AutomationFlowTemplateV2.findAll = async () => [];
  db.Tratamiento.findAll = async () => [];

  try {
    const res = responseRecorder();
    await whatsappController.listTemplatesForClinic({
      query: { clinic_id: '56', for_sending: '1' },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].is_system, false);
    assert.equal(res.body[0].is_owned_by_current_user, false);
    assert.equal(res.body[0].is_legacy_unassigned, true);
    assert.equal(res.body[0].ownership_scope, 'legacy_unassigned');
    assert.equal(res.body[0].can_send_by_current_user, true);
    assert.equal(res.body[0].can_manage_by_current_user, false);
    assert.equal(Object.hasOwn(res.body[0], 'created_by_user_id'), false);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
    db.AutomationFlowTemplateV2.findAll = originals.flowFindAll;
    db.Tratamiento.findAll = originals.treatmentFindAll;
  }
});

test('el envío directo no permite una plantilla personal de otro autor', async () => {
  const whatsappService = require('../../services/whatsapp.service');
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    clinicFindOne: db.Clinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    assetFindOne: db.ClinicMetaAsset.findOne,
    templateFindAll: db.WhatsappTemplate.findAll,
    normalizePhoneNumber: whatsappService.normalizePhoneNumber,
    getClinicConfig: whatsappService.getClinicConfig,
    sendMessage: whatsappService.sendMessage,
  };
  let sends = 0;
  db.UsuarioClinica.findAll = async () => [{ id_clinica: 56, rol_clinica: 'propietario' }];
  db.Clinica.findOne = async () => ({ grupoClinicaId: 5 });
  db.Clinica.findAll = async () => [{ grupoClinicaId: 5 }];
  db.ClinicMetaAsset.findOne = async () => ({
    assignmentScope: 'group',
    grupoClinicaId: 5,
    phoneNumberId: 'phone-56',
    wabaId: 'waba-5',
    waAccessToken: 'scoped-token',
    metaConnection: { userId: 91 },
  });
  db.WhatsappTemplate.findAll = async () => [{
    id: 902,
    name: 'plantilla_ajena',
    language: 'es',
    origin: 'custom',
    catalog_template_id: null,
    created_by_user_id: 77,
    get() { return { ...this }; },
  }];
  whatsappService.normalizePhoneNumber = () => '34600000000';
  whatsappService.getClinicConfig = async () => ({
    phoneNumberId: 'phone-56',
    accessToken: 'scoped-token',
    wabaId: 'waba-5',
  });
  whatsappService.sendMessage = async () => {
    sends += 1;
    return {};
  };

  try {
    const res = responseRecorder();
    await whatsappController.sendMessage({
      body: { clinic_id: 56, to: '+34600000000', useTemplate: true, templateId: 902 },
      userData: { userId: 76 },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.error, 'whatsapp_template_owner_forbidden');
    assert.equal(sends, 0);
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Clinica.findOne = originals.clinicFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.WhatsappTemplate.findAll = originals.templateFindAll;
    whatsappService.normalizePhoneNumber = originals.normalizePhoneNumber;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    whatsappService.sendMessage = originals.sendMessage;
  }
});

test('QuickChat solo resuelve plantillas APPROVED al enviar fuera de ventana', async () => {
  const conversationController = require('../../controllers/conversation.controller');
  const whatsappService = require('../../services/whatsapp.service');
  const originals = {
    transaction: db.sequelize.transaction,
    clinicFindAll: db.Clinica.findAll,
    conversationFindByPk: db.Conversation.findByPk,
    patientFindByPk: db.Paciente.findByPk,
    templateFindOne: db.WhatsappTemplate.findOne,
    normalizePhoneNumber: whatsappService.normalizePhoneNumber,
    getClinicConfig: whatsappService.getClinicConfig,
  };
  const transaction = {
    committed: false,
    rolledBack: false,
    async commit() { this.committed = true; },
    async rollback() { this.rolledBack = true; },
  };
  let capturedTemplateWhere = null;
  const conversation = {
    id: 700,
    clinic_id: 56,
    channel: 'whatsapp',
    contact_id: null,
    patient_id: 123,
    lead_id: null,
    last_inbound_at: null,
    async save() {},
  };
  db.sequelize.transaction = async () => transaction;
  db.Clinica.findAll = async () => [{ id_clinica: 56 }];
  db.Conversation.findByPk = async () => conversation;
  db.Paciente.findByPk = async () => ({ telefono_movil: '+34600000000' });
  db.WhatsappTemplate.findOne = async ({ where }) => {
    capturedTemplateWhere = where;
    // Una consulta sin status reproduciría el bug: encontraría una fila pendiente.
    return where.status === 'APPROVED'
      ? null
      : {
          id: 903,
          status: 'PENDING',
          is_active: true,
          created_by_user_id: 1,
        };
  };
  whatsappService.normalizePhoneNumber = () => '34600000000';
  whatsappService.getClinicConfig = async () => ({
    phoneNumberId: 'phone-56',
    accessToken: 'scoped-token',
    wabaId: 'waba-5',
  });

  try {
    const res = responseRecorder();
    await conversationController.postMessage({
      params: { id: '700' },
      body: {
        message: 'Vista previa',
        message_type: 'template',
        useTemplate: true,
        templateId: 903,
      },
      userData: { userId: 1 },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body?.error, 'whatsapp_template_not_available');
    assert.equal(capturedTemplateWhere.status, 'APPROVED');
    assert.equal(capturedTemplateWhere.is_active, true);
    assert.equal(transaction.rolledBack, true);
    assert.equal(transaction.committed, false);
  } finally {
    db.sequelize.transaction = originals.transaction;
    db.Clinica.findAll = originals.clinicFindAll;
    db.Conversation.findByPk = originals.conversationFindByPk;
    db.Paciente.findByPk = originals.patientFindByPk;
    db.WhatsappTemplate.findOne = originals.templateFindOne;
    whatsappService.normalizePhoneNumber = originals.normalizePhoneNumber;
    whatsappService.getClinicConfig = originals.getClinicConfig;
  }
});

test('el contrato persiste autor, filtra el selector y autoriza el envío server-side', () => {
  const root = path.resolve(__dirname, '../../..');
  const service = fs.readFileSync(path.join(root, 'src/services/whatsappTemplates.service.js'), 'utf8');
  const whatsappControllerSource = fs.readFileSync(path.join(root, 'src/controllers/whatsapp.controller.js'), 'utf8');
  const conversationController = fs.readFileSync(path.join(root, 'src/controllers/conversation.controller.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'migrations/20260717113000-add-whatsapp-template-creator.js'), 'utf8');

  assert.match(service, /created_by_user_id:\s*safeCreatedByUserId/g);
  assert.match(whatsappControllerSource, /includeUserAuthoredFromSharedWaba:\s*true/);
  assert.match(whatsappControllerSource, /await assertWhatsappTemplateClinicAccess\(\{ clinicId, userId \}\)/);
  assert.ok(
    whatsappControllerSource.indexOf('await assertWhatsappTemplateClinicAccess({ clinicId, userId })')
      < whatsappControllerSource.indexOf('const overrides = await WhatsappTemplate.findAll'),
    'el scope de clínica debe validarse antes de leer cualquier override',
  );
  assert.doesNotMatch(whatsappControllerSource, /if \(!asset \|\| isAggregateAllowed\)/);
  assert.match(whatsappControllerSource, /whatsapp_template_clinic_scope_forbidden/);
  assert.match(whatsappControllerSource, /createdByUserId:\s*userId/);
  assert.match(whatsappControllerSource, /system_template_read_only/);
  assert.match(whatsappControllerSource, /exports\.sendMessage/);
  assert.match(whatsappControllerSource, /status:\s*'APPROVED'/);
  assert.match(conversationController, /canUserSelectWhatsappTemplate\(templateJson, userId\)/);
  assert.match(conversationController, /status:\s*'APPROVED'/);
  assert.match(conversationController, /whatsapp_template_owner_forbidden/);
  assert.match(conversationController, /templateName:\s*canonicalTemplateName \|\| templateName/);
  assert.match(conversationController, /templateLanguage:\s*canonicalTemplateLanguage \|\| templateLanguage/);
  assert.match(migration, /references:\s*\{ model: 'Usuarios', key: 'id_usuario' \}/);
  assert.doesNotMatch(migration, /UPDATE\s+WhatsappTemplates/i);
});

test('la migración de autoría es aditiva, idempotente y no hace backfill inferido', async () => {
  const migration = require('../../../migrations/20260717113000-add-whatsapp-template-creator');
  const state = { columns: {}, indexes: [] };
  const calls = { addColumn: 0, addIndex: 0 };
  const queryInterface = {
    async describeTable() { return { ...state.columns }; },
    async showIndex() { return state.indexes.map(name => ({ name })); },
    async addColumn(_table, column) {
      calls.addColumn += 1;
      state.columns[column] = { allowNull: true };
    },
    async addIndex(_table, _columns, options) {
      calls.addIndex += 1;
      state.indexes.push(options.name);
    },
  };
  const Sequelize = { INTEGER: 'INTEGER' };

  await migration.up(queryInterface, Sequelize);
  await migration.up(queryInterface, Sequelize);

  assert.equal(calls.addColumn, 1);
  assert.equal(calls.addIndex, 1);
  assert.ok(state.columns.created_by_user_id);
  assert.ok(state.indexes.includes('idx_whatsapp_templates_creator_active'));
});
