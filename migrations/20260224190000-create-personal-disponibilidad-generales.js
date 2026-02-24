'use strict';

/**
 * Capa 1 (disponibilidad general):
 * Horario semanal global del profesional, independiente de clínicas.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableName = 'PersonalDisponibilidadGenerales';
    const [existing] = await queryInterface.sequelize.query(`SHOW TABLES LIKE '${tableName}'`);
    if (Array.isArray(existing) && existing.length > 0) {
      return;
    }

    await queryInterface.createTable(tableName, {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      doctor_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      dia_semana: { type: Sequelize.INTEGER, allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      hora_inicio: { type: Sequelize.STRING(5), allowNull: false },
      hora_fin: { type: Sequelize.STRING(5), allowNull: false },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex(tableName, ['doctor_id'], {
      name: 'idx_personal_disponibilidad_generales_doctor_id',
    });
    await queryInterface.addIndex(tableName, ['doctor_id', 'dia_semana'], {
      name: 'idx_personal_disponibilidad_generales_doctor_dia',
    });
    await queryInterface.addIndex(tableName, ['doctor_id', 'dia_semana', 'hora_inicio', 'hora_fin'], {
      unique: true,
      name: 'uq_personal_disponibilidad_generales_doctor_dia_horas',
    });
  },

  async down(queryInterface) {
    const tableName = 'PersonalDisponibilidadGenerales';
    const [existing] = await queryInterface.sequelize.query(`SHOW TABLES LIKE '${tableName}'`);
    if (!Array.isArray(existing) || existing.length === 0) {
      return;
    }
    await queryInterface.dropTable(tableName);
  },
};

