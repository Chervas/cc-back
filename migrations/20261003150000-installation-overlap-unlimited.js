'use strict';

// Additive, off by default. No room/professional/appointment is enabled here.
module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = await queryInterface.describeTable('Instalaciones');
    if (!schema.overlap_capacity_unlimited) await queryInterface.addColumn('Instalaciones', 'overlap_capacity_unlimited', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
  async down() { throw new Error('Conserva la política explícita de ocupación; no borrar configuración durante el rollback.'); },
};
