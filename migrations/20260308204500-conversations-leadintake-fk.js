'use strict';

async function getLeadForeignKeys(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'Conversations'
      AND COLUMN_NAME = 'lead_id'
      AND REFERENCED_TABLE_NAME IS NOT NULL
  `);
  return rows;
}

async function ensureLeadIndex(queryInterface) {
  const [indexes] = await queryInterface.sequelize.query(`
    SHOW INDEX FROM Conversations WHERE Column_name = 'lead_id'
  `);
  if (!indexes.length) {
    await queryInterface.addIndex('Conversations', ['lead_id'], {
      name: 'idx_conversations_lead_id',
    });
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const existingFks = await getLeadForeignKeys(queryInterface);

    for (const fk of existingFks) {
      await queryInterface.removeConstraint('Conversations', fk.CONSTRAINT_NAME);
    }

    await queryInterface.sequelize.query(`
      UPDATE Conversations c
      LEFT JOIN LeadIntakes li ON li.id = c.lead_id
      SET c.lead_id = NULL
      WHERE c.lead_id IS NOT NULL
        AND li.id IS NULL
    `);

    await ensureLeadIndex(queryInterface);

    await queryInterface.addConstraint('Conversations', {
      fields: ['lead_id'],
      type: 'foreign key',
      name: 'fk_conversations_lead_intake',
      references: {
        table: 'LeadIntakes',
        field: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'SET NULL',
    });
  },

  async down(queryInterface, Sequelize) {
    const existingFks = await getLeadForeignKeys(queryInterface);
    const hasCanonical = existingFks.some((fk) => fk.CONSTRAINT_NAME === 'fk_conversations_lead_intake');

    if (hasCanonical) {
      await queryInterface.removeConstraint('Conversations', 'fk_conversations_lead_intake');
    }

    await ensureLeadIndex(queryInterface);

    await queryInterface.addConstraint('Conversations', {
      fields: ['lead_id'],
      type: 'foreign key',
      name: 'fk_conversations_lead_legacy',
      references: {
        table: 'Leads',
        field: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'SET NULL',
    });
  },
};
