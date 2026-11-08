'use strict';
const schema = require('../src/lib/legalAcceptanceSchema');
module.exports = (sequelize, DataTypes) => sequelize.define('LegalDocumentAcceptance', schema.fields(DataTypes), {
    tableName: schema.TABLE, timestamps: false, indexes: schema.indexes,
    hooks: {
        beforeUpdate() { throw Error('legal_acceptance_immutable'); },
        beforeBulkUpdate() { throw Error('legal_acceptance_immutable'); },
        beforeDestroy() { throw Error('legal_acceptance_immutable'); },
        beforeBulkDestroy() { throw Error('legal_acceptance_immutable'); },
    },
});
