'use strict';

const crypto = require('crypto');

const variableSchemaBase = {
  variables: [
    { token: '{{paciente.nombre_completo}}', label: 'Paciente' },
    { token: '{{paciente.documento}}', label: 'Documento' },
    { token: '{{clinica.nombre}}', label: 'Clínica' },
    { token: '{{clinica.direccion}}', label: 'Dirección clínica' },
    { token: '{{tratamiento.nombre}}', label: 'Tratamiento' },
    { token: '{{cita.fecha}}', label: 'Fecha de cita' },
    { token: '{{profesional.nombre}}', label: 'Profesional' },
  ],
};

const consentTemplates = [
  {
    catalog_key: 'cc_base_portal_paciente_usuario_gratuito_v1',
    name: 'Autorización de usuario gratuito para portal del paciente',
    description: 'Permiso separado para crear una cuenta gratuita desde la que consultar citas, presupuestos y documentos.',
    purpose: 'data_protection',
    blocking_policy: 'soft',
    validity_mode: 'manual',
    is_generic: true,
    disciplines: [],
    requires_professional_signature: false,
    automation: { enabled: false, hours_before: 24, channels: [], requires_explanation_statement: false },
    title: 'Autorización de usuario gratuito para portal del paciente',
    body_html: [
      '<h2>Autorización de usuario gratuito para portal del paciente</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Documento:</strong> {{paciente.documento}}</p>',
      '<p><strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Autorizo a la clínica a crear un usuario gratuito asociado a mis datos de paciente para acceder al portal del paciente de ClínicaClick.</p>',
      '<p>Desde este portal podré consultar mis citas, descargar presupuestos, revisar documentación clínica o administrativa disponible y acceder a otras funcionalidades que la clínica active para mejorar mi atención.</p>',
      '<p>La creación de este usuario no implica aceptar comunicaciones comerciales. El tratamiento de datos se limita a la gestión asistencial, administrativa y de acceso al portal, conforme a la información de protección de datos facilitada por la clínica.</p>',
      '<p>Puedo solicitar la baja o el bloqueo del acceso al portal contactando con la clínica.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_estetica_acido_hialuronico_v1',
    name: 'Consentimiento informado de ácido hialurónico',
    description: 'Plantilla para rellenos dérmicos con ácido hialurónico en medicina estética.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['estetica'],
    requires_professional_signature: true,
    automation: { enabled: true, hours_before: 24, channels: ['email'], requires_explanation_statement: true },
    title: 'Consentimiento informado de ácido hialurónico',
    body_html: [
      '<h2>Consentimiento informado de ácido hialurónico</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}}</p>',
      '<p>Se me ha informado de que el tratamiento consiste en la infiltración de ácido hialurónico con finalidad estética o correctora, mediante técnica indicada por el profesional responsable.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> dolor, inflamación, hematoma, asimetría, irregularidades, infección, reacción inflamatoria, nódulos, migración del producto, resultado insuficiente o no esperado y, de forma excepcional, compromiso vascular u otras complicaciones que requieran tratamiento urgente.</p>',
      '<p>Conozco las alternativas, la posibilidad de no realizar el tratamiento, los cuidados posteriores y la necesidad de avisar a la clínica ante dolor intenso, cambios de coloración, fiebre u otros signos de alarma.</p>',
      '<p>Declaro que he podido hacer preguntas, que se me ha explicado el procedimiento y que acepto su realización.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_estetica_toxina_botulinica_v1',
    name: 'Consentimiento informado de toxina botulínica',
    description: 'Plantilla para infiltración de toxina botulínica con finalidad estética o terapéutica.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['estetica'],
    requires_professional_signature: true,
    automation: { enabled: true, hours_before: 24, channels: ['email'], requires_explanation_statement: true },
    title: 'Consentimiento informado de toxina botulínica',
    body_html: [
      '<h2>Consentimiento informado de toxina botulínica</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Se me ha explicado que la toxina botulínica se utiliza para relajar temporalmente determinados músculos y mejorar arrugas dinámicas u otras indicaciones clínicas según valoración profesional.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> dolor local, hematoma, cefalea, sensación de pesadez, asimetría, caída temporal del párpado o ceja, debilidad muscular no deseada, resultado insuficiente, necesidad de retoque y reacciones poco frecuentes.</p>',
      '<p>He comunicado mis antecedentes, medicación, alergias, embarazo o lactancia si procede. Conozco cuidados posteriores y alternativas, incluida la no realización del tratamiento.</p>',
      '<p>Declaro que he recibido información suficiente y autorizo el procedimiento.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_capilar_microinjerto_v1',
    name: 'Consentimiento informado de microinjerto capilar',
    description: 'Plantilla para trasplante capilar FUE/FUT o técnicas equivalentes.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['capilar'],
    requires_professional_signature: true,
    automation: { enabled: true, hours_before: 24, channels: ['email'], requires_explanation_statement: true },
    title: 'Consentimiento informado de microinjerto capilar',
    body_html: [
      '<h2>Consentimiento informado de microinjerto capilar</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Fecha prevista:</strong> {{cita.fecha}}</p>',
      '<p>Se me ha explicado que el microinjerto capilar es un procedimiento quirúrgico o invasivo destinado a redistribuir unidades foliculares desde una zona donante a una zona receptora.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> dolor, inflamación, sangrado, infección, costras, pérdida temporal de pelo, cicatrices, alteraciones de sensibilidad, resultado menor al esperado, baja supervivencia de injertos, necesidad de nuevas sesiones y complicaciones relacionadas con anestesia local o medicación.</p>',
      '<p>Conozco las alternativas, limitaciones, cuidados preoperatorios y postoperatorios, y la posibilidad de revocar este consentimiento antes del procedimiento.</p>',
      '<p>Declaro que he podido plantear dudas, que se me ha explicado el procedimiento y que acepto su realización.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
];

function publicId() {
  return `cadmin_${crypto.randomBytes(10).toString('hex')}`;
}

function buildVariableSchema(template) {
  return {
    ...variableSchemaBase,
    automation: template.automation || { enabled: false, channels: [], hours_before: 24 },
  };
}

async function upsertConsentTemplate(queryInterface, Sequelize, item, now) {
  const existing = await queryInterface.sequelize.query(
    'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key = :catalogKey LIMIT 1',
    {
      replacements: { catalogKey: item.catalog_key },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
  let catalogId = existing[0]?.id || null;
  const row = {
    catalog_key: item.catalog_key,
    name: item.name,
    description: item.description,
    purpose: item.purpose,
    status: 'active',
    blocking_policy: item.blocking_policy,
    validity_mode: item.validity_mode,
    is_generic: item.is_generic,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: item.requires_professional_signature,
    created_by: 1,
    updatedAt: now,
  };
  if (catalogId) {
    await queryInterface.bulkUpdate('ConsentTemplateCatalogs', row, { id: catalogId });
  } else {
    await queryInterface.bulkInsert('ConsentTemplateCatalogs', [{ ...row, public_id: publicId(), createdAt: now }]);
    const created = await queryInterface.sequelize.query(
      'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key = :catalogKey LIMIT 1',
      { replacements: { catalogKey: item.catalog_key }, type: Sequelize.QueryTypes.SELECT }
    );
    catalogId = created[0]?.id || null;
  }
  if (!catalogId) return;

  await queryInterface.bulkDelete('ConsentTemplateCatalogDisciplines', { catalog_id: catalogId });
  if (item.disciplines.length) {
    await queryInterface.bulkInsert('ConsentTemplateCatalogDisciplines', item.disciplines.map((disciplina_code) => ({
      catalog_id: catalogId,
      disciplina_code,
      createdAt: now,
      updatedAt: now,
    })));
  }

  const versions = await queryInterface.sequelize.query(
    'SELECT id FROM ConsentTemplateCatalogVersions WHERE catalog_id = :catalogId AND locale = "es" ORDER BY version DESC, id DESC LIMIT 1',
    { replacements: { catalogId }, type: Sequelize.QueryTypes.SELECT }
  );
  const versionRow = {
    title: item.title,
    body_json: null,
    body_html: item.body_html,
    variable_schema: JSON.stringify(buildVariableSchema(item)),
    status: 'published',
    published_at: now,
    created_by: 1,
    updatedAt: now,
  };
  if (versions[0]?.id) {
    await queryInterface.bulkUpdate('ConsentTemplateCatalogVersions', versionRow, { id: versions[0].id });
  } else {
    await queryInterface.bulkInsert('ConsentTemplateCatalogVersions', [{
      ...versionRow,
      catalog_id: catalogId,
      version: 1,
      locale: 'es',
      createdAt: now,
    }]);
  }
}

async function upsertWhatsappTemplate(queryInterface, Sequelize, now) {
  const name = 'clinicaclick_envio_consentimiento_firma';
  const existing = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    { replacements: { name }, type: Sequelize.QueryTypes.SELECT }
  );
  const bodyText = 'Hola {{1}}, tienes documentación pendiente para {{2}} en {{3}}. Puedes revisarla y firmarla aquí: {{4}}';
  const row = {
    name,
    display_name: 'Envío de consentimiento para firma',
    category: 'UTILITY',
    body_text: bodyText,
    variables: JSON.stringify([
      { position: 1, name: 'paciente' },
      { position: 2, name: 'tratamiento' },
      { position: 3, name: 'clinica' },
      { position: 4, name: 'enlace_consentimiento' },
    ]),
    components: JSON.stringify([{ type: 'BODY', text: bodyText, example: { body_text: [['María', 'Implante dental', 'Clínica Centro', 'https://tablet.clinicaclick.com/tablet/consentimientos/...']] } }]),
    is_generic: true,
    is_active: true,
    updated_at: now,
  };
  if (existing[0]?.id) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', row, { id: existing[0].id });
  } else {
    await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{ ...row, created_at: now }]);
  }
}

async function updateConsentAutomationTemplate(queryInterface, Sequelize, now) {
  const nodes = [
    { id: 'N1', type: 'trigger/consent_required', config: { min_hours_before: 24 }, outputs: { on_success: 'N2' }, position: { x: 100, y: 120 } },
    { id: 'N2', type: 'action/send_email', config: { subject: 'Consentimientos pendientes para tu cita', body_html: '<p>Hola {{paciente.nombre}}, revisa y firma tu documentación pendiente: {{consentimiento.enlace_publico}}</p><p>Este nodo queda preparado hasta conectar el proveedor real de email.</p>' }, outputs: { on_success: 'N3', on_fail: 'N3' }, position: { x: 100, y: 260 } },
    { id: 'N3', type: 'action/send_whatsapp', config: { template_name: 'clinicaclick_envio_consentimiento_firma', public_link_variable: 'consentimiento.enlace_publico', mock_until_provider_ready: true }, outputs: { on_success: 'N4', on_fail: 'N4' }, position: { x: 100, y: 400 } },
    { id: 'N4', type: 'action/send_system_notification', config: { title: 'Consentimientos pendientes', message: 'La cita de {{paciente.nombre}} tiene consentimientos pendientes.' }, outputs: { on_success: null, on_fail: null }, position: { x: 100, y: 540 } },
  ];
  await queryInterface.sequelize.query(
    'UPDATE AutomationFlowTemplatesV2 SET description = :description, nodes = :nodes, trigger_config = :triggerConfig, updated_at = :updatedAt WHERE template_key = :templateKey',
    {
      replacements: {
        templateKey: 'system_consentimientos_necesarios',
        description: 'Automatización base para enviar consentimientos 24h antes por email y/o WhatsApp. Email queda como stub hasta conectar proveedor real.',
        nodes: JSON.stringify(nodes),
        triggerConfig: JSON.stringify({ min_hours_before: 24, supports_channels: ['email', 'whatsapp'] }),
        updatedAt: now,
      },
    }
  );
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    for (const item of consentTemplates) {
      await upsertConsentTemplate(queryInterface, Sequelize, item, now);
    }
    await upsertWhatsappTemplate(queryInterface, Sequelize, now);
    await updateConsentAutomationTemplate(queryInterface, Sequelize, now);
  },

  async down(queryInterface, Sequelize) {
    const keys = consentTemplates.map((item) => item.catalog_key);
    const catalogs = await queryInterface.sequelize.query(
      'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key IN (:keys)',
      { replacements: { keys }, type: Sequelize.QueryTypes.SELECT }
    );
    const ids = catalogs.map((item) => item.id);
    if (ids.length) {
      await queryInterface.bulkDelete('ConsentTemplateCatalogDisciplines', { catalog_id: ids });
      await queryInterface.bulkDelete('ConsentTemplateCatalogTreatments', { catalog_id: ids });
      await queryInterface.bulkDelete('ConsentTemplateCatalogVersions', { catalog_id: ids });
      await queryInterface.bulkDelete('ConsentTemplateCatalogs', { id: ids });
    }
    await queryInterface.bulkDelete('WhatsappTemplateCatalog', { name: 'clinicaclick_envio_consentimiento_firma' });
  },
};
