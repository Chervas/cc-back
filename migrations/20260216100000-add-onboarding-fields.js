'use strict';

/**
 * Bloque 6.1 – Onboarding / Invitación de personal
 *
 * Añade:
 *   UsuarioClinica.estado_invitacion  ENUM('pendiente','aceptada','rechazada') DEFAULT NULL
 *   UsuarioClinica.invite_token       VARCHAR(64) DEFAULT NULL  (token único para reclamar)
 *   UsuarioClinica.invited_at         DATETIME DEFAULT NULL
 *   UsuarioClinica.responded_at       DATETIME DEFAULT NULL
 *   Usuarios.es_provisional           BOOLEAN DEFAULT FALSE
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── UsuarioClinica ──
    const ucTable = await queryInterface.describeTable('UsuarioClinica');

    if (!ucTable.estado_invitacion) {
      await queryInterface.addColumn('UsuarioClinica', 'estado_invitacion', {
        type: Sequelize.ENUM('pendiente', 'aceptada', 'rechazada'),
        allowNull: true,
        defaultValue: null,
      });
    }

    if (!ucTable.invite_token) {
      await queryInterface.addColumn('UsuarioClinica', 'invite_token', {
        type: Sequelize.STRING(64),
        allowNull: true,
        defaultValue: null,
      });
      await queryInterface.addIndex('UsuarioClinica', ['invite_token'], {
        name: 'idx_uc_invite_token',
        unique: true,
        where: { invite_token: { [Sequelize.Op.ne]: null } },
      }).catch(() => {
        // Algunos dialectos no soportan partial index; crear sin WHERE
        return queryInterface.addIndex('UsuarioClinica', ['invite_token'], {
          name: 'idx_uc_invite_token',
        });
      });
    }

    if (!ucTable.invited_at) {
      await queryInterface.addColumn('UsuarioClinica', 'invited_at', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }

    if (!ucTable.responded_at) {
      await queryInterface.addColumn('UsuarioClinica', 'responded_at', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }

    // ── Usuarios ──
    const usersTable = await queryInterface.describeTable('Usuarios');

    if (!usersTable.es_provisional) {
      await queryInterface.addColumn('Usuarios', 'es_provisional', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    const ucTable = await queryInterface.describeTable('UsuarioClinica');
    if (ucTable.responded_at) await queryInterface.removeColumn('UsuarioClinica', 'responded_at');
    if (ucTable.invited_at) await queryInterface.removeColumn('UsuarioClinica', 'invited_at');
    if (ucTable.invite_token) {
      await queryInterface.removeIndex('UsuarioClinica', 'idx_uc_invite_token').catch(() => {});
      await queryInterface.removeColumn('UsuarioClinica', 'invite_token');
    }
    if (ucTable.estado_invitacion) await queryInterface.removeColumn('UsuarioClinica', 'estado_invitacion');

    const usersTable = await queryInterface.describeTable('Usuarios');
    if (usersTable.es_provisional) await queryInterface.removeColumn('Usuarios', 'es_provisional');
  },
};
