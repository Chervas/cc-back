'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

function parseComponents(value) {
  if (!value) return [];
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function withoutButtonEmoji(components) {
  return parseComponents(components).map((component) => {
    if (String(component?.type || '').toUpperCase() !== 'BUTTONS') return component;
    return {
      ...component,
      buttons: (component.buttons || []).map((button) => ({
        ...button,
        text: String(button.text || '').replace(/[⭐★]/g, '').trim(),
      })),
    };
  });
}

function withButtonEmoji(components) {
  return parseComponents(components).map((component) => {
    if (String(component?.type || '').toUpperCase() !== 'BUTTONS') return component;
    return {
      ...component,
      buttons: (component.buttons || []).map((button) => ({
        ...button,
        text: `${String(button.text || '').replace(/[⭐★]/g, '').trim()}⭐`,
      })),
    };
  });
}

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      'SELECT id, components FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const template = rows[0];
    if (!template) return;

    const components = JSON.stringify(withoutButtonEmoji(template.components));
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        components,
        updated_at: new Date(),
      },
      { id: template.id }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates
      SET
        components = :components,
        rejection_reason = CASE
          WHEN status = 'PENDING_LOCAL' AND rejection_reason LIKE '%Button Format is Incorrect%' THEN NULL
          WHEN status = 'PENDING_LOCAL' AND rejection_reason LIKE '%Invalid parameter%' THEN NULL
          ELSE rejection_reason
        END,
        status = CASE
          WHEN status = 'PENDING_LOCAL' AND meta_template_id IS NULL THEN 'SIN_CONECTAR'
          ELSE status
        END,
        updatedAt = :updatedAt
      WHERE catalog_template_id = :catalogTemplateId
        OR name = :name
      `,
      {
        replacements: {
          components,
          catalogTemplateId: template.id,
          name: TEMPLATE_NAME,
          updatedAt: new Date(),
        },
      }
    );
  },

  async down(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      'SELECT id, components FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const template = rows[0];
    if (!template) return;

    const components = JSON.stringify(withButtonEmoji(template.components));
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        components,
        updated_at: new Date(),
      },
      { id: template.id }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates
      SET components = :components, updatedAt = :updatedAt
      WHERE catalog_template_id = :catalogTemplateId
        OR name = :name
      `,
      {
        replacements: {
          components,
          catalogTemplateId: template.id,
          name: TEMPLATE_NAME,
          updatedAt: new Date(),
        },
      }
    );
  },
};
