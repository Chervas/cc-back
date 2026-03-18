'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MetaConnectionAssignments', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      scopeKey: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      assignmentScope: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false, defaultValue: 'clinic' },
      clinicaId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      grupoClinicaId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      metaConnectionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'MetaConnections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      status: { type: Sequelize.ENUM('active', 'reauthorization_required', 'revoked', 'disconnected'), allowNull: false, defaultValue: 'active' },
      authorizedByUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      authorizedByName: { type: Sequelize.STRING(255), allowNull: true },
      authorizedByEmail: { type: Sequelize.STRING(255), allowNull: true },
      connectedAt: { type: Sequelize.DATE, allowNull: true },
      lastValidatedAt: { type: Sequelize.DATE, allowNull: true },
      lastErrorCode: { type: Sequelize.STRING(128), allowNull: true },
      lastErrorMessage: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('MetaConnectionAssignments', ['metaConnectionId'], { name: 'idx_meta_connection_assignments_connection' });
    await queryInterface.addIndex('MetaConnectionAssignments', ['clinicaId'], { name: 'idx_meta_connection_assignments_clinic' });
    await queryInterface.addIndex('MetaConnectionAssignments', ['grupoClinicaId'], { name: 'idx_meta_connection_assignments_group' });
    await queryInterface.addIndex('MetaConnectionAssignments', ['status'], { name: 'idx_meta_connection_assignments_status' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MetaConnectionAssignments', 'idx_meta_connection_assignments_status');
    await queryInterface.removeIndex('MetaConnectionAssignments', 'idx_meta_connection_assignments_group');
    await queryInterface.removeIndex('MetaConnectionAssignments', 'idx_meta_connection_assignments_clinic');
    await queryInterface.removeIndex('MetaConnectionAssignments', 'idx_meta_connection_assignments_connection');
    await queryInterface.dropTable('MetaConnectionAssignments');
  }
};
