'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('DoctorHorarios', 'rrule', {
      type: Sequelize.STRING(255),
      allowNull: true,
      after: 'hora_fin',
    });

    await queryInterface.addColumn('DoctorHorarios', 'fecha_inicio_vigencia', {
      type: Sequelize.DATEONLY,
      allowNull: true,
      after: 'rrule',
    });

    await queryInterface.addColumn('DoctorHorarios', 'fecha_fin_vigencia', {
      type: Sequelize.DATEONLY,
      allowNull: true,
      after: 'fecha_inicio_vigencia',
    });

    await queryInterface.createTable('DoctorHorarioExcepciones', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      doctor_horario_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'DoctorHorarios', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      fecha: { type: Sequelize.DATEONLY, allowNull: false },
      cancelado: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      hora_inicio_override: { type: Sequelize.STRING(5), allowNull: true },
      hora_fin_override: { type: Sequelize.STRING(5), allowNull: true },
      creado_por: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex('DoctorHorarioExcepciones', ['doctor_horario_id', 'fecha'], {
      unique: true,
      name: 'doctor_horario_excepciones_unique_fecha',
    });

    await queryInterface.createTable('DoctorBloqueoExcepciones', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      doctor_bloqueo_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'DoctorBloqueos', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      fecha: { type: Sequelize.DATEONLY, allowNull: false },
      cancelado: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      creado_por: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex('DoctorBloqueoExcepciones', ['doctor_bloqueo_id', 'fecha'], {
      unique: true,
      name: 'doctor_bloqueo_excepciones_unique_fecha',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('DoctorBloqueoExcepciones', 'doctor_bloqueo_excepciones_unique_fecha');
    await queryInterface.dropTable('DoctorBloqueoExcepciones');
    await queryInterface.removeIndex('DoctorHorarioExcepciones', 'doctor_horario_excepciones_unique_fecha');
    await queryInterface.dropTable('DoctorHorarioExcepciones');
    await queryInterface.removeColumn('DoctorHorarios', 'fecha_fin_vigencia');
    await queryInterface.removeColumn('DoctorHorarios', 'fecha_inicio_vigencia');
    await queryInterface.removeColumn('DoctorHorarios', 'rrule');
  },
};
