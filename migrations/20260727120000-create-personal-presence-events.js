'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PersonalPresenceEvents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onDelete: 'CASCADE',
      },
      business_date: { type: Sequelize.DATEONLY, allowNull: false },
      event_type: { type: Sequelize.STRING(32), allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'web' },
      note: { type: Sequelize.TEXT, allowNull: true },
      created_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('PersonalPresenceEvents', ['clinic_id', 'business_date'], {
      name: 'personal_presence_events_clinic_date_idx',
    });
    await queryInterface.addIndex('PersonalPresenceEvents', ['user_id', 'business_date'], {
      name: 'personal_presence_events_user_date_idx',
    });
    await queryInterface.addIndex('PersonalPresenceEvents', ['clinic_id', 'user_id', 'business_date'], {
      name: 'personal_presence_events_clinic_user_date_idx',
    });
    await queryInterface.addIndex('PersonalPresenceEvents', ['clinic_id', 'event_type', 'business_date'], {
      name: 'personal_presence_events_type_date_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PersonalPresenceEvents');
  },
};
