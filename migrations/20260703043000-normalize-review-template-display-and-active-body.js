'use strict';

const REQUEST_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';
const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

const DISPLAY_NAMES = {
  [REQUEST_TEMPLATE_NAME]: 'Solicitud de valoración 5-1',
  [PHOTO_TEMPLATE_NAME]: 'Solicitud de valoración 5-1 con foto',
  [REMINDER_TEMPLATE_NAME]: 'Recordatorio de valoración sin respuesta',
};

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function parseJson(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function extractBodyText(components) {
  const body = parseJson(components).find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  return normalizeText(body?.text || '');
}

function resolveFamilyName(row) {
  const name = String(row?.name || '');
  const catalogName = String(row?.catalog_name || '');
  if (name.startsWith(PHOTO_TEMPLATE_NAME) || catalogName === PHOTO_TEMPLATE_NAME) return PHOTO_TEMPLATE_NAME;
  if (name.startsWith(REQUEST_TEMPLATE_NAME) || catalogName === REQUEST_TEMPLATE_NAME) return REQUEST_TEMPLATE_NAME;
  if (name.startsWith(REMINDER_TEMPLATE_NAME) || catalogName === REMINDER_TEMPLATE_NAME) return REMINDER_TEMPLATE_NAME;
  return '';
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET display_name = CASE name
              WHEN :requestName THEN :requestDisplayName
              WHEN :photoName THEN :photoDisplayName
              WHEN :reminderName THEN :reminderDisplayName
              ELSE display_name
             END,
             updated_at = NOW()
       WHERE name IN (:requestName, :photoName, :reminderName)
      `,
      {
        replacements: {
          requestName: REQUEST_TEMPLATE_NAME,
          photoName: PHOTO_TEMPLATE_NAME,
          reminderName: REMINDER_TEMPLATE_NAME,
          requestDisplayName: DISPLAY_NAMES[REQUEST_TEMPLATE_NAME],
          photoDisplayName: DISPLAY_NAMES[PHOTO_TEMPLATE_NAME],
          reminderDisplayName: DISPLAY_NAMES[REMINDER_TEMPLATE_NAME],
        },
      }
    );

    const [catalogRows] = await queryInterface.sequelize.query(
      `
      SELECT name, body_text
        FROM WhatsappTemplateCatalog
       WHERE name IN (:requestName, :photoName, :reminderName)
      `,
      {
        replacements: {
          requestName: REQUEST_TEMPLATE_NAME,
          photoName: PHOTO_TEMPLATE_NAME,
          reminderName: REMINDER_TEMPLATE_NAME,
        },
      }
    );
    const bodiesByName = new Map(
      catalogRows.map((row) => [String(row.name || ''), normalizeText(row.body_text || '')])
    );

    const [templates] = await queryInterface.sequelize.query(
      `
      SELECT wt.id,
             wt.name,
             wt.status,
             wt.components,
             wt.is_active,
             wc.name AS catalog_name
        FROM WhatsappTemplates wt
        LEFT JOIN WhatsappTemplateCatalog wc ON wc.id = wt.catalog_template_id
       WHERE wt.name LIKE :requestFamily
          OR wt.name LIKE :photoFamily
          OR wt.name LIKE :reminderFamily
          OR wc.name IN (:requestName, :photoName, :reminderName)
      `,
      {
        replacements: {
          requestFamily: `${REQUEST_TEMPLATE_NAME}%`,
          photoFamily: `${PHOTO_TEMPLATE_NAME}%`,
          reminderFamily: `${REMINDER_TEMPLATE_NAME}%`,
          requestName: REQUEST_TEMPLATE_NAME,
          photoName: PHOTO_TEMPLATE_NAME,
          reminderName: REMINDER_TEMPLATE_NAME,
        },
      }
    );

    for (const template of templates) {
      const familyName = resolveFamilyName(template);
      const expectedBody = bodiesByName.get(familyName) || '';
      if (!familyName || !expectedBody) continue;

      const matchesCurrentBody = extractBodyText(template.components) === expectedBody;
      const nextDisplayName = DISPLAY_NAMES[familyName] || null;
      await queryInterface.sequelize.query(
        `
        UPDATE WhatsappTemplates
           SET is_active = :isActive,
               display_name = COALESCE(display_name, :displayName),
               updatedAt = NOW()
         WHERE id = :id
        `,
        {
          replacements: {
            id: template.id,
            isActive: matchesCurrentBody ? 1 : 0,
            displayName: nextDisplayName,
          },
        }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET display_name = CASE name
              WHEN :requestName THEN 'Solicitud de valoración 1-5'
              WHEN :photoName THEN 'Solicitud de valoración 1-5 con foto'
              ELSE display_name
             END,
             updated_at = NOW()
       WHERE name IN (:requestName, :photoName)
      `,
      {
        replacements: {
          requestName: REQUEST_TEMPLATE_NAME,
          photoName: PHOTO_TEMPLATE_NAME,
        },
      }
    );
  },
};
