'use strict';

const BASE_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';

const BODY = [
  '¡Hola {{1}}! Soy {{3}} de {{2}}. ¿Cómo valorarías tu experiencia con nosotros?',
  '',
  'Responde con un número:',
  '',
  '5 ⭐⭐⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '3 ⭐⭐⭐',
  '2 ⭐⭐',
  '1 ⭐',
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
  {
    position: 3,
    name: 'firma_resenas',
    example: 'Recepción',
    description: 'Remitente que firma la solicitud de reseña',
    template_usage: 'solicitud_resena',
  },
];

const BODY_COMPONENT = {
  type: 'BODY',
  text: BODY,
  example: {
    body_text: [['María', 'Clínica Dental Centro', 'Recepción']],
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

async function findCatalogId(queryInterface, name) {
  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  return rows[0]?.id || null;
}

async function updateCatalogTemplate(queryInterface, { name, displayName, components }) {
  const catalogId = await findCatalogId(queryInterface, name);
  if (!catalogId) return null;
  await queryInterface.bulkUpdate(
    'WhatsappTemplateCatalog',
    {
      display_name: displayName,
      body_text: BODY,
      variables: JSON.stringify(VARIABLES),
      components: JSON.stringify(components),
      propagation_state: null,
      updated_at: new Date(),
    },
    { id: catalogId }
  );
  return catalogId;
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
    const baseComponents = [BODY_COMPONENT];
    const photoComponents = [PHOTO_HEADER_COMPONENT, BODY_COMPONENT];

    const baseCatalogId = await updateCatalogTemplate(queryInterface, {
      name: BASE_TEMPLATE_NAME,
      displayName: 'Solicitud de valoración 5-1',
      components: baseComponents,
    });
    const photoCatalogId = await updateCatalogTemplate(queryInterface, {
      name: PHOTO_TEMPLATE_NAME,
      displayName: 'Solicitud de valoración 5-1 con foto',
      components: photoComponents,
    });

    await updateEditableOperationalTemplates(queryInterface, {
      catalogId: baseCatalogId,
      name: BASE_TEMPLATE_NAME,
      components: baseComponents,
    });
    await updateEditableOperationalTemplates(queryInterface, {
      catalogId: photoCatalogId,
      name: PHOTO_TEMPLATE_NAME,
      components: photoComponents,
    });
  },

  async down() {
    // No-op: no revertimos plantillas ya enviadas a Meta ni copias aprobadas.
  },
};
