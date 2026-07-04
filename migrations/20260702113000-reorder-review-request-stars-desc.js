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

function buildBodyComponent() {
  return {
    type: 'BODY',
    text: BODY,
    example: {
      body_text: [['María', 'Clínica Dental Centro', 'Recepción']],
    },
  };
}

function buildPhotoHeaderComponent() {
  return {
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
}

async function updateCatalog(queryInterface, name, components) {
  await queryInterface.sequelize.query(
    `
    UPDATE WhatsappTemplateCatalog
    SET body_text = :body,
        variables = :variables,
        components = :components,
        propagation_state = NULL,
        updated_at = NOW()
    WHERE name = :name
    `,
    {
      replacements: {
        name,
        body: BODY,
        variables: JSON.stringify(VARIABLES),
        components: JSON.stringify(components),
      },
    }
  );
}

async function updateEditableOperationalTemplates(queryInterface, name, components) {
  await queryInterface.sequelize.query(
    `
    UPDATE WhatsappTemplates wt
    LEFT JOIN WhatsappTemplateCatalog wc ON wc.id = wt.catalog_template_id
    SET wt.components = :components,
        wt.variables = :variables,
        wt.updatedAt = NOW()
    WHERE (
        wt.name = :name
        OR wt.name LIKE :familyName
        OR wc.name = :name
      )
      AND (
        wt.status <> 'APPROVED'
        OR wt.meta_template_id IS NULL
        OR wt.meta_template_id = ''
      )
    `,
    {
      replacements: {
        name,
        familyName: `${name}_v%`,
        variables: JSON.stringify(VARIABLES),
        components: JSON.stringify(components),
      },
    }
  );
}

module.exports = {
  async up(queryInterface) {
    const baseComponents = [buildBodyComponent()];
    const photoComponents = [buildPhotoHeaderComponent(), buildBodyComponent()];

    await updateCatalog(queryInterface, BASE_TEMPLATE_NAME, baseComponents);
    await updateCatalog(queryInterface, PHOTO_TEMPLATE_NAME, photoComponents);
    await updateEditableOperationalTemplates(queryInterface, BASE_TEMPLATE_NAME, baseComponents);
    await updateEditableOperationalTemplates(queryInterface, PHOTO_TEMPLATE_NAME, photoComponents);
  },

  async down() {
    // No revertimos plantillas de Meta ni copias aprobadas.
  },
};
