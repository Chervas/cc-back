'use strict';

/**
 * One-shot de estados de cita a catálogo canónico único:
 * pendiente, pendiente_confirmada, confirmada, reprogramada, cancelada, completada, no_asistio
 */
module.exports = {
  async up(queryInterface) {
    // 1) Normalizar valores legacy que puedan existir antes de cerrar el ENUM.
    await queryInterface.sequelize.query(`
      UPDATE CitasPacientes
      SET estado = CASE LOWER(TRIM(estado))
        WHEN 'programada' THEN 'pendiente'
        WHEN 'agendada' THEN 'pendiente'
        WHEN 'asistio' THEN 'completada'
        WHEN 'realizada' THEN 'completada'
        WHEN 'confirmado' THEN 'confirmada'
        WHEN 'cancelado' THEN 'cancelada'
        ELSE estado
      END
      WHERE estado IS NOT NULL;
    `);

    // 2) Ajustar ENUM final canónico (sin alias).
    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        'pendiente',
        'pendiente_confirmada',
        'confirmada',
        'reprogramada',
        'cancelada',
        'completada',
        'no_asistio'
      ) NOT NULL DEFAULT 'pendiente';
    `);
  },

  async down(queryInterface) {
    // Reducimos a catálogo previo de 5 estados.
    await queryInterface.sequelize.query(`
      UPDATE CitasPacientes
      SET estado = CASE estado
        WHEN 'pendiente_confirmada' THEN 'pendiente'
        WHEN 'reprogramada' THEN 'pendiente'
        ELSE estado
      END
      WHERE estado IN ('pendiente_confirmada', 'reprogramada');
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        'pendiente',
        'confirmada',
        'cancelada',
        'completada',
        'no_asistio'
      ) NOT NULL DEFAULT 'pendiente';
    `);
  },
};
