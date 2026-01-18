'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const especialidadesBase = [
      // Dental
      { nombre: 'Odontólogo General', disciplina: 'dental' },
      { nombre: 'Ortodoncista', disciplina: 'dental' },
      { nombre: 'Endodoncista', disciplina: 'dental' },
      { nombre: 'Periodoncista', disciplina: 'dental' },
      { nombre: 'Implantólogo', disciplina: 'dental' },
      { nombre: 'Cirujano Maxilofacial', disciplina: 'dental' },
      { nombre: 'Higienista Dental', disciplina: 'dental' },
      { nombre: 'Auxiliar Dental', disciplina: 'dental' },
      // Estética
      { nombre: 'Médico Estético', disciplina: 'estetica' },
      { nombre: 'Dermatólogo', disciplina: 'estetica' },
      { nombre: 'Cirujano Plástico', disciplina: 'estetica' },
      { nombre: 'Esteticista', disciplina: 'estetica' },
      // Capilar
      { nombre: 'Cirujano Capilar', disciplina: 'capilar' },
      { nombre: 'Tricólogo', disciplina: 'capilar' },
      { nombre: 'Auxiliar Capilar', disciplina: 'capilar' },
      // Psicología
      { nombre: 'Psicólogo Clínico', disciplina: 'psicologia' },
      { nombre: 'Neuropsicólogo', disciplina: 'psicologia' },
      { nombre: 'Psicoterapeuta', disciplina: 'psicologia' },
      { nombre: 'Psiquiatra', disciplina: 'psicologia' },
      // Fisioterapia
      { nombre: 'Fisioterapeuta General', disciplina: 'fisioterapia' },
      { nombre: 'Fisioterapeuta Deportivo', disciplina: 'fisioterapia' },
      { nombre: 'Osteópata', disciplina: 'fisioterapia' }
    ];

    const now = new Date();
    await queryInterface.bulkInsert('EspecialidadesMedicasSistema',
      especialidadesBase.map(e => ({
        ...e,
        activo: true,
        createdAt: now,
        updatedAt: now
      }))
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('EspecialidadesMedicasSistema', null, {});
  }
};
