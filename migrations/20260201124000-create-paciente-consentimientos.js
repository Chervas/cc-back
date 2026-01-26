'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PacienteConsentimientos', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Pacientes',
          key: 'id_paciente',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      nombre: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      descripcion: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      tipo: {
        type: Sequelize.ENUM('tratamiento', 'rgpd', 'imagen', 'comunicaciones', 'otro'),
        allowNull: false,
      },
      estado: {
        type: Sequelize.ENUM('pendiente', 'enviado', 'firmado', 'rechazado', 'caducado'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      fecha_envio: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      fecha_firma: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      fecha_caducidad: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      url_documento: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      obligatorio: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('PacienteConsentimientos', ['paciente_id'], {
      name: 'idx_paciente_consentimientos_paciente',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PacienteConsentimientos');
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_PacienteConsentimientos_tipo";');
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_PacienteConsentimientos_estado";');
    }
  },
};
