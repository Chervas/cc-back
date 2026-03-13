'use strict';

/**
 * Migración: renombrar valores canónicos de modo_disponibilidad
 *
 * 1. Ampliar STRING(16) → STRING(32) para soportar 'citas_personalizadas'.
 * 2. Data migration: solo_registro → sin_citas, basico → citas_automaticas, avanzado → citas_personalizadas.
 * 3. Actualizar default de columna.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = 'DoctorClinicas';
    const col = 'modo_disponibilidad';

    // 1) Ampliar longitud de columna
    await queryInterface.changeColumn(table, col, {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'citas_personalizadas',
    });

    // 2) Data migration de valores legacy a canónicos
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'sin_citas' WHERE \`${col}\` = 'solo_registro'`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'citas_automaticas' WHERE \`${col}\` = 'basico'`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'citas_personalizadas' WHERE \`${col}\` = 'avanzado'`
    );
  },

  async down(queryInterface, Sequelize) {
    const table = 'DoctorClinicas';
    const col = 'modo_disponibilidad';

    // Revertir data migration
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'solo_registro' WHERE \`${col}\` = 'sin_citas'`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'basico' WHERE \`${col}\` = 'citas_automaticas'`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${table}\` SET \`${col}\` = 'avanzado' WHERE \`${col}\` = 'citas_personalizadas'`
    );

    // Restaurar longitud original y default
    await queryInterface.changeColumn(table, col, {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'avanzado',
    });
  },
};
