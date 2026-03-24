'use strict';

const crypto = require('crypto');

function generatePublicId() {
  return `flw_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AutomationFlowTemplatesV2', 'public_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
      after: 'id',
    });

    const rows = await queryInterface.sequelize.query(
      `
        SELECT id, template_key
        FROM AutomationFlowTemplatesV2
        ORDER BY template_key ASC, version ASC, id ASC
      `,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    const familyIds = new Map();
    for (const row of rows) {
      const templateKey = String(row.template_key || '').trim();
      if (!templateKey) continue;
      if (!familyIds.has(templateKey)) {
        familyIds.set(templateKey, generatePublicId());
      }
      await queryInterface.sequelize.query(
        'UPDATE AutomationFlowTemplatesV2 SET public_id = :publicId WHERE id = :id',
        {
          replacements: {
            id: row.id,
            publicId: familyIds.get(templateKey),
          },
        }
      );
    }

    await queryInterface.changeColumn('AutomationFlowTemplatesV2', 'public_id', {
      type: Sequelize.STRING(64),
      allowNull: false,
    });

    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['public_id'], {
      name: 'automation_flow_templates_v2_public_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', 'automation_flow_templates_v2_public_id_idx');
    await queryInterface.removeColumn('AutomationFlowTemplatesV2', 'public_id');
  },
};
