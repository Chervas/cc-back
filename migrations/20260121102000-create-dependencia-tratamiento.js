'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('DependenciaTratamiento', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_tratamiento_origen: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      id_tratamiento_destino: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      tipo: {
        type: Sequelize.ENUM('obligatoria', 'recomendada'),
        allowNull: false,
        defaultValue: 'obligatoria'
      },
      dias_espera: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      notas: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('DependenciaTratamiento', ['id_tratamiento_origen']);
    await queryInterface.addIndex('DependenciaTratamiento', ['id_tratamiento_destino']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('DependenciaTratamiento', ['id_tratamiento_destino']);
    await queryInterface.removeIndex('DependenciaTratamiento', ['id_tratamiento_origen']);
    await queryInterface.dropTable('DependenciaTratamiento');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_DependenciaTratamiento_tipo";');
  }
};
