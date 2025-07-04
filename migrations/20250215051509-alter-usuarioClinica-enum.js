'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. Cambiar temporalmente la columna subrol_clinica a STRING para permitir cualquier valor.
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null
    });

    // 2. Actualizar los registros:
    // Convertir 'doctor' a 'Doctores'
    await queryInterface.sequelize.query(`
      UPDATE UsuarioClinica 
      SET subrol_clinica = 'Doctores' 
      WHERE subrol_clinica = 'doctor'
    `);

    // Convertir 'auxiliar' a 'Auxiliares y enfermeros'
    await queryInterface.sequelize.query(`
      UPDATE UsuarioClinica 
      SET subrol_clinica = 'Auxiliares y enfermeros' 
      WHERE subrol_clinica = 'auxiliar'
    `);

    // Si algún registro tiene 'propietario' en subrol, se asigna NULL (ya que 'propietario' se usará en rol_clinica)
    await queryInterface.sequelize.query(`
      UPDATE UsuarioClinica 
      SET subrol_clinica = NULL 
      WHERE subrol_clinica = 'propietario'
    `);

    // 3. Cambiar la columna rol_clinica al nuevo enum.
    await queryInterface.changeColumn('UsuarioClinica', 'rol_clinica', {
      type: Sequelize.ENUM('paciente', 'personaldeclinica', 'propietario'),
      allowNull: false,
      defaultValue: 'paciente'
    });

    // 4. Finalmente, cambiar la columna subrol_clinica al nuevo enum.
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.ENUM('Auxiliares y enfermeros', 'Doctores', 'Administrativos'),
      allowNull: true,
      defaultValue: null
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Para revertir, primero cambiar la columna subrol_clinica a STRING.
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null
    });

    // Revertir los cambios en los registros:
    await queryInterface.sequelize.query(`
      UPDATE UsuarioClinica 
      SET subrol_clinica = 'doctor'
      WHERE subrol_clinica = 'Doctores'
    `);

    await queryInterface.sequelize.query(`
      UPDATE UsuarioClinica 
      SET subrol_clinica = 'auxiliar'
      WHERE subrol_clinica = 'Auxiliares y enfermeros'
    `);

    // Revertir la columna rol_clinica al enum anterior.
    await queryInterface.changeColumn('UsuarioClinica', 'rol_clinica', {
      type: Sequelize.ENUM('personaldeclinica', 'paciente', 'otro'),
      allowNull: false,
      defaultValue: 'paciente'
    });

    // Cambiar la columna subrol_clinica al enum anterior.
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.ENUM('doctor', 'auxiliar', 'propietario'),
      allowNull: true,
      defaultValue: null
    });
  }
};
