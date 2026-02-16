'use strict';

async function hasColumn(queryInterface, tableName, columnName) {
  const table = await queryInterface.describeTable(tableName);
  return !!table[columnName];
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const usuariosTable = 'Usuarios';
    const usuarioClinicaTable = 'UsuarioClinica';

    if (!(await hasColumn(queryInterface, usuariosTable, 'estado_cuenta'))) {
      await queryInterface.addColumn(usuariosTable, 'estado_cuenta', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'activo',
      });
      await queryInterface.addIndex(usuariosTable, ['estado_cuenta'], {
        name: 'idx_usuarios_estado_cuenta',
      }).catch(() => null);
    }

    if (!(await hasColumn(queryInterface, usuariosTable, 'emails_alternativos'))) {
      await queryInterface.addColumn(usuariosTable, 'emails_alternativos', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    if (!(await hasColumn(queryInterface, usuariosTable, 'creado_por'))) {
      await queryInterface.addColumn(usuariosTable, 'creado_por', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
      await queryInterface.addIndex(usuariosTable, ['creado_por'], {
        name: 'idx_usuarios_creado_por',
      }).catch(() => null);
    }

    if (!(await hasColumn(queryInterface, usuarioClinicaTable, 'estado_invitacion'))) {
      await queryInterface.addColumn(usuarioClinicaTable, 'estado_invitacion', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'aceptada',
      });
      await queryInterface.addIndex(usuarioClinicaTable, ['estado_invitacion'], {
        name: 'idx_usuarioclinica_estado_invitacion',
      }).catch(() => null);
    }

    if (!(await hasColumn(queryInterface, usuarioClinicaTable, 'invitado_por'))) {
      await queryInterface.addColumn(usuarioClinicaTable, 'invitado_por', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
      await queryInterface.addIndex(usuarioClinicaTable, ['invitado_por'], {
        name: 'idx_usuarioclinica_invitado_por',
      }).catch(() => null);
    }

    if (!(await hasColumn(queryInterface, usuarioClinicaTable, 'fecha_invitacion'))) {
      await queryInterface.addColumn(usuarioClinicaTable, 'fecha_invitacion', {
        type: Sequelize.DATE,
        allowNull: true,
      });
      await queryInterface.addIndex(usuarioClinicaTable, ['fecha_invitacion'], {
        name: 'idx_usuarioclinica_fecha_invitacion',
      }).catch(() => null);
    }
  },

  async down(queryInterface) {
    const usuariosTable = 'Usuarios';
    const usuarioClinicaTable = 'UsuarioClinica';

    if (await hasColumn(queryInterface, usuarioClinicaTable, 'fecha_invitacion')) {
      await queryInterface.removeIndex(usuarioClinicaTable, 'idx_usuarioclinica_fecha_invitacion').catch(() => null);
      await queryInterface.removeColumn(usuarioClinicaTable, 'fecha_invitacion');
    }

    if (await hasColumn(queryInterface, usuarioClinicaTable, 'invitado_por')) {
      await queryInterface.removeIndex(usuarioClinicaTable, 'idx_usuarioclinica_invitado_por').catch(() => null);
      await queryInterface.removeColumn(usuarioClinicaTable, 'invitado_por');
    }

    if (await hasColumn(queryInterface, usuarioClinicaTable, 'estado_invitacion')) {
      await queryInterface.removeIndex(usuarioClinicaTable, 'idx_usuarioclinica_estado_invitacion').catch(() => null);
      await queryInterface.removeColumn(usuarioClinicaTable, 'estado_invitacion');
    }

    if (await hasColumn(queryInterface, usuariosTable, 'creado_por')) {
      await queryInterface.removeIndex(usuariosTable, 'idx_usuarios_creado_por').catch(() => null);
      await queryInterface.removeColumn(usuariosTable, 'creado_por');
    }

    if (await hasColumn(queryInterface, usuariosTable, 'emails_alternativos')) {
      await queryInterface.removeColumn(usuariosTable, 'emails_alternativos');
    }

    if (await hasColumn(queryInterface, usuariosTable, 'estado_cuenta')) {
      await queryInterface.removeIndex(usuariosTable, 'idx_usuarios_estado_cuenta').catch(() => null);
      await queryInterface.removeColumn(usuariosTable, 'estado_cuenta');
    }
  },
};
