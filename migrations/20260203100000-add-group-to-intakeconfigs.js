'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('IntakeConfigs', 'group_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'GruposClinicas', key: 'id_grupo' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });

    await queryInterface.addColumn('IntakeConfigs', 'assignment_scope', {
      type: Sequelize.ENUM('clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic'
    });

    await queryInterface.addIndex('IntakeConfigs', { name: 'idx_intakeconfigs_group', fields: ['group_id'] });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('IntakeConfigs', 'idx_intakeconfigs_group');
    await queryInterface.removeColumn('IntakeConfigs', 'group_id');
    await queryInterface.removeColumn('IntakeConfigs', 'assignment_scope');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_IntakeConfigs_assignment_scope";');
  }
};
