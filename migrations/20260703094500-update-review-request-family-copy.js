'use strict';

const REQUEST_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';

const BODY = [
  '¡Hola {{1}}! Soy {{3}} de {{2}}. ¿Te puedo hacer una pregunta? Como viste, en la clínica somos una pequeña familia, y saber cómo te atendimos es importante para nosotros. ¿Cómo valorarías tu experiencia con nosotros?',
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

function buildPhotoHeaderComponent(existingComponents) {
  const current = parseComponents(existingComponents)
    .find((component) => String(component?.type || '').toUpperCase() === 'HEADER');
  if (current) return current;
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

function parseComponents(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function extractBodyText(value) {
  const body = parseComponents(value)
    .find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  return String(body?.text || '').replace(/\r\n/g, '\n').trim();
}

function buildCatalogComponents(name, existingComponents) {
  const body = buildBodyComponent();
  return name === PHOTO_TEMPLATE_NAME
    ? [buildPhotoHeaderComponent(existingComponents), body]
    : [body];
}

async function fetchCatalogRows(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT id, name, components
      FROM WhatsappTemplateCatalog
     WHERE name IN (:requestName, :photoName)
    `,
    {
      replacements: {
        requestName: REQUEST_TEMPLATE_NAME,
        photoName: PHOTO_TEMPLATE_NAME,
      },
    }
  );
  return rows || [];
}

async function updateCatalog(queryInterface) {
  const rows = await fetchCatalogRows(queryInterface);
  for (const row of rows) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET body_text = :body,
             variables = :variables,
             components = :components,
             propagation_state = NULL,
             updated_at = NOW()
       WHERE id = :id
      `,
      {
        replacements: {
          id: row.id,
          body: BODY,
          variables: JSON.stringify(VARIABLES),
          components: JSON.stringify(buildCatalogComponents(row.name, row.components)),
        },
      }
    );
  }
}

async function updateOperationalTemplates(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT wt.id,
           wt.name,
           wt.status,
           wt.meta_template_id,
           wt.components,
           wc.name AS catalog_name,
           wc.components AS catalog_components
      FROM WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog wc ON wc.id = wt.catalog_template_id
     WHERE wt.name LIKE :requestFamily
        OR wt.name LIKE :photoFamily
        OR wc.name IN (:requestName, :photoName)
    `,
    {
      replacements: {
        requestFamily: `${REQUEST_TEMPLATE_NAME}%`,
        photoFamily: `${PHOTO_TEMPLATE_NAME}%`,
        requestName: REQUEST_TEMPLATE_NAME,
        photoName: PHOTO_TEMPLATE_NAME,
      },
    }
  );

  for (const row of rows || []) {
    const familyName = String(row.catalog_name || row.name || '').startsWith(PHOTO_TEMPLATE_NAME)
      ? PHOTO_TEMPLATE_NAME
      : REQUEST_TEMPLATE_NAME;
    const bodyMatches = extractBodyText(row.components) === BODY;
    const hasRemoteVersion = !!String(row.meta_template_id || '').trim();
    const status = String(row.status || '').toUpperCase();
    const canRewriteLocalCopy = !hasRemoteVersion || ['SIN_CONECTAR', 'PENDING_LOCAL', 'LOCAL_PENDING'].includes(status);

    if (canRewriteLocalCopy) {
      await queryInterface.sequelize.query(
        `
        UPDATE WhatsappTemplates
           SET components = :components,
               variables = :variables,
               is_active = 1,
               updatedAt = NOW()
         WHERE id = :id
        `,
        {
          replacements: {
            id: row.id,
            variables: JSON.stringify(VARIABLES),
            components: JSON.stringify(buildCatalogComponents(familyName, row.components || row.catalog_components)),
          },
        }
      );
      continue;
    }

    if (!bodyMatches) {
      await queryInterface.sequelize.query(
        `
        UPDATE WhatsappTemplates
           SET is_active = 0,
               updatedAt = NOW()
         WHERE id = :id
        `,
        {
          replacements: { id: row.id },
        }
      );
    }
  }
}

module.exports = {
  async up(queryInterface) {
    await updateCatalog(queryInterface);
    await updateOperationalTemplates(queryInterface);
  },

  async down() {
    // No revertimos copias de Meta: cada cambio de BODY requiere una nueva revisión externa.
  },
};
