'use strict';

const BASE_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';

const BODY = [
  '¡Hola {{1}}! ¿Cómo valorarías tu experiencia en {{2}}?',
  '',
  'Responde con un número:',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
  '',
  'Tu opinión nos ayuda mucho.',
].join('\n');

const VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
    template_usage: 'solicitud_resena',
  },
  {
    position: 2,
    name: 'nombre_clinica',
    example: 'Clínica Dental Centro',
    description: 'Nombre visible de la clínica',
    template_usage: 'solicitud_resena',
  },
];

const BODY_COMPONENT = {
  type: 'BODY',
  text: BODY,
  example: {
    body_text: [['María', 'Clínica Dental Centro']],
  },
};

const PHOTO_HEADER_COMPONENT = {
  type: 'HEADER',
  format: 'IMAGE',
  example: {
    header_handle: [
      process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE
        || process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE
        || 'https://media.clinicaclick.com/templates/reviews/team-example.jpg',
    ],
  },
};

const BASE_COMPONENTS = [BODY_COMPONENT];
const PHOTO_COMPONENTS = [PHOTO_HEADER_COMPONENT, BODY_COMPONENT];

async function upsertCatalogTemplate(queryInterface, { name, displayName, components }) {
  const now = new Date();
  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  const payload = {
    display_name: displayName,
    category: 'MARKETING',
    body_text: BODY,
    variables: JSON.stringify(VARIABLES),
    components: JSON.stringify(components),
    is_generic: true,
    is_active: true,
    propagation_state: null,
    updated_at: now,
  };
  if (rows[0]) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { id: rows[0].id });
    return rows[0].id;
  }
  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
    name,
    ...payload,
    created_at: now,
  }]);
  const created = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  return created[0]?.id || null;
}

async function updateEditableOperationalTemplates(queryInterface, { catalogId, name, components }) {
  if (!catalogId) return;
  await queryInterface.sequelize.query(
    `
    UPDATE WhatsappTemplates
    SET components = :components,
        variables = :variables,
        updatedAt = NOW()
    WHERE (
        catalog_template_id = :catalogId
        OR name = :name
        OR name LIKE :familyName
      )
      AND (
        status <> 'APPROVED'
        OR meta_template_id IS NULL
        OR meta_template_id = ''
      )
    `,
    {
      replacements: {
        catalogId,
        name,
        familyName: `${name}_v%`,
        components: JSON.stringify(components),
        variables: JSON.stringify(VARIABLES),
      },
    }
  );
}

module.exports = {
  async up(queryInterface) {
    const baseCatalogId = await upsertCatalogTemplate(queryInterface, {
      name: BASE_TEMPLATE_NAME,
      displayName: 'Solicitud de valoración 1-5',
      components: BASE_COMPONENTS,
    });
    const photoCatalogId = await upsertCatalogTemplate(queryInterface, {
      name: PHOTO_TEMPLATE_NAME,
      displayName: 'Solicitud de valoración 1-5 con foto',
      components: PHOTO_COMPONENTS,
    });

    await updateEditableOperationalTemplates(queryInterface, {
      catalogId: baseCatalogId,
      name: BASE_TEMPLATE_NAME,
      components: BASE_COMPONENTS,
    });
    await updateEditableOperationalTemplates(queryInterface, {
      catalogId: photoCatalogId,
      name: PHOTO_TEMPLATE_NAME,
      components: PHOTO_COMPONENTS,
    });
  },

  async down() {
    // No-op: no revertimos plantillas ya enviadas a revisión o aprobadas por Meta.
  },
};
