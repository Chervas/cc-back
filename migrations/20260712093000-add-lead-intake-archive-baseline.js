'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('LeadIntakes');

    if (!table.archived_at) {
      await queryInterface.addColumn('LeadIntakes', 'archived_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    if (!table.archive_reason) {
      await queryInterface.addColumn('LeadIntakes', 'archive_reason', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex('LeadIntakes');
    if (!indexes.some((index) => index.name === 'idx_lead_intakes_scope_archive_created')) {
      await queryInterface.addIndex(
        'LeadIntakes',
        ['grupo_clinica_id', 'archived_at', 'created_at'],
        { name: 'idx_lead_intakes_scope_archive_created' },
      );
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('LeadIntakes');
    if (indexes.some((index) => index.name === 'idx_lead_intakes_scope_archive_created')) {
      await queryInterface.removeIndex('LeadIntakes', 'idx_lead_intakes_scope_archive_created');
    }

    const table = await queryInterface.describeTable('LeadIntakes');
    if (table.archive_reason) await queryInterface.removeColumn('LeadIntakes', 'archive_reason');
    if (table.archived_at) await queryInterface.removeColumn('LeadIntakes', 'archived_at');
  },
};
