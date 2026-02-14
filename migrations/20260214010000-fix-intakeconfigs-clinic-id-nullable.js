'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // MySQL: si existen FKs sobre clinic_id, hay que quitarlas antes de poder cambiar nullability.
    // Hemos visto estados donde clinic_id seguia NOT NULL y existian FKs duplicadas (ibfk_1/ibfk_2).
    const dropFk = async (name) => {
      try {
        await queryInterface.sequelize.query(`ALTER TABLE \`IntakeConfigs\` DROP FOREIGN KEY \`${name}\``);
      } catch (_) {
        // noop
      }
    };

    await dropFk('IntakeConfigs_ibfk_1');
    await dropFk('IntakeConfigs_ibfk_2');
    await dropFk('IntakeConfigs_clinic_id_fk');

    // Asegurar clinic_id nullable para configs a nivel de grupo.
    await queryInterface.sequelize.query('ALTER TABLE `IntakeConfigs` MODIFY `clinic_id` INT NULL');

    // Re-crear FK (una sola vez) con nombre estable.
    // Nota: requiere que exista un índice sobre clinic_id (ya existe UNIQUE KEY clinic_id).
    await queryInterface.sequelize.query(
      'ALTER TABLE `IntakeConfigs` ' +
      'ADD CONSTRAINT `IntakeConfigs_clinic_id_fk` FOREIGN KEY (`clinic_id`) ' +
      'REFERENCES `Clinicas` (`id_clinica`) ON DELETE CASCADE ON UPDATE CASCADE'
    );
  },

  async down(queryInterface) {
    // Revertir a NOT NULL (puede fallar si hay registros de grupo con clinic_id = NULL).
    try {
      await queryInterface.sequelize.query('ALTER TABLE `IntakeConfigs` DROP FOREIGN KEY `IntakeConfigs_clinic_id_fk`');
    } catch (_) {}

    await queryInterface.sequelize.query('ALTER TABLE `IntakeConfigs` MODIFY `clinic_id` INT NOT NULL');

    await queryInterface.sequelize.query(
      'ALTER TABLE `IntakeConfigs` ' +
      'ADD CONSTRAINT `IntakeConfigs_clinic_id_fk` FOREIGN KEY (`clinic_id`) ' +
      'REFERENCES `Clinicas` (`id_clinica`) ON DELETE CASCADE ON UPDATE CASCADE'
    );
  }
};

