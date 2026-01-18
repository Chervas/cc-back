'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Tratamientos', 'codigo', {
      type: Sequelize.STRING(50),
      allowNull: true,
      unique: true
    });
    await queryInterface.addColumn('Tratamientos', 'especialidad', {
      type: Sequelize.STRING(100),
      allowNull: true
    });
    await queryInterface.addColumn('Tratamientos', 'origen', {
      type: Sequelize.ENUM('sistema', 'grupo', 'clinica'),
      allowNull: false,
      defaultValue: 'clinica'
    });
    await queryInterface.addColumn('Tratamientos', 'id_tratamiento_base', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Tratamientos', key: 'id_tratamiento' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });
    await queryInterface.addColumn('Tratamientos', 'eliminado_por_clinica', {
      type: Sequelize.JSON,
      allowNull: true
    });
    await queryInterface.addColumn('Tratamientos', 'asignacion_especialidades', {
      type: Sequelize.JSON,
      allowNull: true
    });
    await queryInterface.addColumn('Tratamientos', 'sesiones_defecto', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 1
    });
    await queryInterface.addColumn('Tratamientos', 'requiere_pieza', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false
    });
    await queryInterface.addColumn('Tratamientos', 'requiere_zona', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Tratamientos', 'requiere_zona');
    await queryInterface.removeColumn('Tratamientos', 'requiere_pieza');
    await queryInterface.removeColumn('Tratamientos', 'sesiones_defecto');
    await queryInterface.removeColumn('Tratamientos', 'asignacion_especialidades');
    await queryInterface.removeColumn('Tratamientos', 'eliminado_por_clinica');
    await queryInterface.removeColumn('Tratamientos', 'id_tratamiento_base');
    await queryInterface.removeColumn('Tratamientos', 'origen');
    await queryInterface.removeColumn('Tratamientos', 'especialidad');
    await queryInterface.removeColumn('Tratamientos', 'codigo');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Tratamientos_origen";');
  }
};
