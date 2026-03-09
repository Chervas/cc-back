'use strict';

/**
 * Hard-cut de estados de cita (sin compat runtime):
 * pendiente, info_enviada, info_confirmada, recordatorio_enviado,
 * recordatorio_confirmado, completada, no_asistio, cancelada, reprogramada.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        'pendiente',
        'pendiente_confirmada',
        'confirmada',
        'info_enviada',
        'info_confirmada',
        'recordatorio_enviado',
        'recordatorio_confirmado',
        'completada',
        'no_asistio',
        'cancelada',
        'reprogramada'
      ) NOT NULL DEFAULT 'pendiente';
    `);

    await queryInterface.sequelize.query(`
      UPDATE CitasPacientes
      SET estado = CASE LOWER(TRIM(estado))
        WHEN 'programada' THEN 'pendiente'
        WHEN 'agendada' THEN 'pendiente'
        WHEN 'pendiente_confirmada' THEN 'info_confirmada'
        WHEN 'confirmada' THEN 'recordatorio_confirmado'
        WHEN 'asistio' THEN 'completada'
        WHEN 'realizada' THEN 'completada'
        WHEN 'cancelado' THEN 'cancelada'
        ELSE estado
      END
      WHERE estado IS NOT NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        'pendiente',
        'info_enviada',
        'info_confirmada',
        'recordatorio_enviado',
        'recordatorio_confirmado',
        'completada',
        'no_asistio',
        'cancelada',
        'reprogramada'
      ) NOT NULL DEFAULT 'pendiente';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        'pendiente',
        'pendiente_confirmada',
        'confirmada',
        'info_enviada',
        'info_confirmada',
        'recordatorio_enviado',
        'recordatorio_confirmado',
        'reprogramada',
        'cancelada',
        'completada',
        'no_asistio'
      ) NOT NULL DEFAULT 'pendiente';
    `);

    await queryInterface.sequelize.query(`
      UPDATE CitasPacientes
      SET estado = CASE estado
        WHEN 'info_enviada' THEN 'pendiente'
        WHEN 'info_confirmada' THEN 'pendiente_confirmada'
        WHEN 'recordatorio_enviado' THEN 'confirmada'
        WHEN 'recordatorio_confirmado' THEN 'confirmada'
        ELSE estado
      END
      WHERE estado IN (
        'info_enviada',
        'info_confirmada',
        'recordatorio_enviado',
        'recordatorio_confirmado'
      );
    `);

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
};
