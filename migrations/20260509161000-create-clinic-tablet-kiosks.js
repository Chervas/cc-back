'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ClinicTabletKiosks', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      username: { type: Sequelize.STRING(160), allowNull: false, unique: true },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      display_name: { type: Sequelize.STRING(160), allowNull: true },
      status: {
        type: Sequelize.ENUM('active', 'disabled'),
        allowNull: false,
        defaultValue: 'active',
      },
      last_login_at: { type: Sequelize.DATE, allowNull: true },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('ClinicTabletKiosks', ['clinic_id'], { name: 'idx_clinic_tablet_kiosks_clinic' });
    await queryInterface.addIndex('ClinicTabletKiosks', ['status'], { name: 'idx_clinic_tablet_kiosks_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ClinicTabletKiosks');
  },
};
