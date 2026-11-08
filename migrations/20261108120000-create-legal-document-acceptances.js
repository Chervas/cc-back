'use strict';
const schema = require('../src/lib/legalAcceptanceSchema');
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable(schema.TABLE, schema.fields(Sequelize), { charset: 'utf8mb4', collate: 'utf8mb4_bin' });
        for (const index of schema.indexes) await queryInterface.addIndex(schema.TABLE, index.fields, index);
    },
    async down() { throw Error('legal_acceptance_history_must_be_preserved'); },
};
