'use strict';

/**
 * Hard cut disponibilidad por clínica:
 * - elimina `modo_disponibilidad`
 * - añade dos ejes explícitos:
 *   - `recibe_citas` (bool)
 *   - `modo_horario` ('citas_automaticas' | 'citas_personalizadas')
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = 'DoctorClinicas';

    const [hasRecibe] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'recibe_citas'`
    );
    if (!Array.isArray(hasRecibe) || hasRecibe.length === 0) {
      await queryInterface.addColumn(table, 'recibe_citas', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    const [hasModoHorario] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_horario'`
    );
    if (!Array.isArray(hasModoHorario) || hasModoHorario.length === 0) {
      await queryInterface.addColumn(table, 'modo_horario', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'citas_automaticas',
      });
    }

    const [hasModoDisponibilidad] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_disponibilidad'`
    );
    if (Array.isArray(hasModoDisponibilidad) && hasModoDisponibilidad.length > 0) {
      // Backfill único de datos actuales.
      await queryInterface.sequelize.query(`
        UPDATE \`${table}\`
        SET
          recibe_citas = CASE
            WHEN modo_disponibilidad IN ('sin_citas', 'solo_registro') THEN 0
            ELSE 1
          END,
          modo_horario = CASE
            WHEN modo_disponibilidad IN ('citas_personalizadas', 'avanzado') THEN 'citas_personalizadas'
            ELSE 'citas_automaticas'
          END
      `);

      await queryInterface.removeColumn(table, 'modo_disponibilidad');
    }

    await queryInterface.changeColumn(table, 'recibe_citas', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.changeColumn(table, 'modo_horario', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'citas_automaticas',
    });
  },

  async down(queryInterface, Sequelize) {
    const table = 'DoctorClinicas';

    const [hasModoDisponibilidad] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_disponibilidad'`
    );
    if (!Array.isArray(hasModoDisponibilidad) || hasModoDisponibilidad.length === 0) {
      await queryInterface.addColumn(table, 'modo_disponibilidad', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'citas_personalizadas',
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE \`${table}\`
      SET modo_disponibilidad = CASE
        WHEN COALESCE(recibe_citas, 0) = 0 THEN 'sin_citas'
        WHEN modo_horario = 'citas_automaticas' THEN 'citas_automaticas'
        ELSE 'citas_personalizadas'
      END
    `);

    const [hasRecibe] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'recibe_citas'`
    );
    if (Array.isArray(hasRecibe) && hasRecibe.length > 0) {
      await queryInterface.removeColumn(table, 'recibe_citas');
    }

    const [hasModoHorario] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_horario'`
    );
    if (Array.isArray(hasModoHorario) && hasModoHorario.length > 0) {
      await queryInterface.removeColumn(table, 'modo_horario');
    }
  },
};

