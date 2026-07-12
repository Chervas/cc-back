'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addConstraint('ManagedCampaignLedgerEntries', {
      fields: ['funding_account_id', 'entry_type', 'external_ref'],
      type: 'unique',
      name: 'uniq_managed_ledger_external_ref',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint(
      'ManagedCampaignLedgerEntries',
      'uniq_managed_ledger_external_ref'
    );
  },
};
