'use strict';

const claims = 'AutomationInboundMessageClaims';
const keys = [
  { column: 'claim_key', name: 'uq_automation_inbound_claim_key' },
  { column: 'message_id', name: 'uq_automation_inbound_claim_message' },
];

module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex(claims);
    const missing = keys.filter(({column}) => !indexes.some(index =>
      index.unique && index.fields.length === 1 && index.fields[0].attribute === column
      && !index.fields[0].length));
    if (!missing.length) return;
    if (missing.some(({name}) => indexes.some(index => index.name === name))) {
      throw Error('inbound_claim_index_definition_conflict');
    }
    // MySQL validates the complete keys, including concurrent writes, in one atomic ALTER.
    const additions = missing.map(({column, name}) => `ADD UNIQUE INDEX \`${name}\` (\`${column}\`)`);
    await queryInterface.sequelize.query(
      `ALTER TABLE \`${claims}\` ${additions.join(', ')}, ALGORITHM=INPLACE, LOCK=NONE`
    );
  },
  async down() {
    throw Error('inbound_claim_uniqueness_required_by_existing_runtime');
  },
};
