'use strict';

/**
 * Migración: añadir 'agencia' al ENUM de rol_clinica en UsuarioClinica.
 *
 * MySQL no soporta ALTER TYPE para ENUMs; hay que hacer ALTER TABLE ... MODIFY COLUMN.
 * La migración es idempotente: si 'agencia' ya existe, no falla.
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        // Obtener la definición actual de la columna
        const table = await queryInterface.describeTable('UsuarioClinica');
        const currentType = table.rol_clinica?.type || '';

        // Si ya contiene 'agencia', no hacer nada
        if (currentType.includes('agencia')) {
            console.log('[migration] rol_clinica ya incluye agencia, skip.');
            return;
        }

        // Modificar el ENUM para incluir 'agencia'
        await queryInterface.changeColumn('UsuarioClinica', 'rol_clinica', {
            type: Sequelize.ENUM('paciente', 'personaldeclinica', 'propietario', 'agencia'),
            allowNull: false,
            defaultValue: 'paciente',
        });

        console.log('[migration] Añadido "agencia" a UsuarioClinica.rol_clinica ENUM.');
    },

    async down(queryInterface, Sequelize) {
        // Revertir: quitar 'agencia' del ENUM
        // Primero, actualizar filas que tengan 'agencia' a 'personaldeclinica'
        await queryInterface.sequelize.query(
            `UPDATE UsuarioClinica SET rol_clinica = 'personaldeclinica' WHERE rol_clinica = 'agencia'`
        );

        await queryInterface.changeColumn('UsuarioClinica', 'rol_clinica', {
            type: Sequelize.ENUM('paciente', 'personaldeclinica', 'propietario'),
            allowNull: false,
            defaultValue: 'paciente',
        });
    },
};
