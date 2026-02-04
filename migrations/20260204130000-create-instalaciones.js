'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Instalaciones', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      nombre: { type: Sequelize.STRING(255), allowNull: false },
      tipo: { type: Sequelize.ENUM('box','quirofano','sala_pruebas','sala_polivalente','otro'), allowNull: false, defaultValue: 'box' },
      descripcion: { type: Sequelize.TEXT, allowNull: true },
      piso: { type: Sequelize.STRING(64), allowNull: true },
      color: { type: Sequelize.STRING(16), allowNull: true },
      capacidad: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      requiere_preparacion: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      tiempo_preparacion_minutos: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      es_exclusiva: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      especialidades_permitidas: { type: Sequelize.JSON, allowNull: true },
      tratamientos_exclusivos: { type: Sequelize.JSON, allowNull: true },
      equipamiento: { type: Sequelize.JSON, allowNull: true },
      orden_visualizacion: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('InstalacionHorarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      instalacion_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'CASCADE' },
      dia_semana: { type: Sequelize.INTEGER, allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      hora_inicio: { type: Sequelize.STRING(5), allowNull: false },
      hora_fin: { type: Sequelize.STRING(5), allowNull: false },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('InstalacionBloqueos', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      instalacion_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'CASCADE' },
      fecha_inicio: { type: Sequelize.DATE, allowNull: false },
      fecha_fin: { type: Sequelize.DATE, allowNull: false },
      motivo: { type: Sequelize.STRING(255), allowNull: true },
      recurrente: { type: Sequelize.ENUM('none','daily','weekly','monthly'), allowNull: false, defaultValue: 'none' },
      creado_por: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('InstalacionBloqueos');
    await queryInterface.dropTable('InstalacionHorarios');
    await queryInterface.dropTable('Instalaciones');
  }
};
