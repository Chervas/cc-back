'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotente: si ya existe la tabla (creada manualmente), no se intenta recrear
    const table = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'PacienteRelaciones';",
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (table[0].count > 0) {
      return;
    }

    await queryInterface.createTable('PacienteRelaciones', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      id_paciente: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      id_paciente_relacionado: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      tipo_relacion: {
        type: Sequelize.ENUM('padre', 'madre', 'tutor_legal', 'conyuge', 'hijo', 'otro'),
        allowNull: false
      },
      es_contacto_principal: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      fecha_inicio: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      fecha_fin: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('PacienteRelaciones', ['id_paciente']);
    await queryInterface.addIndex('PacienteRelaciones', ['id_paciente_relacionado']);
    await queryInterface.addIndex('PacienteRelaciones', ['tipo_relacion']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('PacienteRelaciones', ['tipo_relacion']);
    await queryInterface.removeIndex('PacienteRelaciones', ['id_paciente_relacionado']);
    await queryInterface.removeIndex('PacienteRelaciones', ['id_paciente']);
    await queryInterface.dropTable('PacienteRelaciones');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS \"enum_PacienteRelaciones_tipo_relacion\";');
  }
};
