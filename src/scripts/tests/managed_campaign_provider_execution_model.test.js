'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const migration = require('../../../migrations/20260719103000-create-managed-campaign-provider-executions');

test('managed provider execution model exposes the durable lease and exact indexes', () => {
  const Model = db.ManagedCampaignProviderExecution;
  const leaseVersion = Model.rawAttributes.lease_version;
  const leaseExpiry = Model.rawAttributes.lease_expires_at;

  assert.equal(String(leaseVersion.type), 'INTEGER UNSIGNED');
  assert.equal(leaseVersion.allowNull, false);
  assert.equal(leaseVersion.defaultValue, 0);
  assert.equal(String(leaseExpiry.type), 'DATETIME');
  assert.equal(leaseExpiry.allowNull, true);
  assert.equal(Model.rawAttributes.provider_refs.defaultValue, undefined);
  assert.equal(Model.rawAttributes.ownership_snapshot.defaultValue, undefined);
  assert.deepEqual(Model.rawAttributes.status.values, migration.__testing.STATUS_VALUES);

  assert.deepEqual(
    Model._indexes.map((index) => ({
      name: index.name,
      fields: index.fields,
      unique: Boolean(index.unique),
    })),
    [
      { name: 'uniq_managed_provider_execution_idempotency', fields: ['managed_campaign_id', 'idempotency_key'], unique: true },
      { name: 'idx_managed_provider_execution_campaign_status', fields: ['managed_campaign_id', 'status', 'created_at'], unique: false },
      { name: 'idx_managed_provider_execution_job', fields: ['job_request_id'], unique: false },
      { name: 'idx_managed_provider_execution_activation_job', fields: ['activation_job_request_id'], unique: false },
      { name: 'idx_managed_provider_execution_rollback_job', fields: ['rollback_job_request_id'], unique: false },
      { name: 'idx_managed_provider_execution_plan_hash', fields: ['plan_hash'], unique: false },
      { name: 'idx_managed_provider_execution_lease', fields: ['status', 'lease_expires_at'], unique: false },
    ]
  );
  assert.equal(Model._indexes.every((index) => index.name.length <= 64), true);
});

test('managed provider execution model matches every migration foreign key action', () => {
  const Model = db.ManagedCampaignProviderExecution;
  const foreignKeys = {
    managed_campaign_id: ['ManagedCampaigns', 'id', 'RESTRICT'],
    funding_account_id: ['ManagedCampaignFundingAccounts', 'id', 'RESTRICT'],
    source_publishing_audit_id: ['ManagedCampaignPublishingAudits', 'id', 'SET NULL'],
    job_request_id: ['JobRequests', 'id', 'SET NULL'],
    activation_job_request_id: ['JobRequests', 'id', 'SET NULL'],
    rollback_job_request_id: ['JobRequests', 'id', 'SET NULL'],
    requested_by_user_id: ['Usuarios', 'id_usuario', 'RESTRICT'],
    activation_requested_by_user_id: ['Usuarios', 'id_usuario', 'SET NULL'],
    rollback_requested_by_user_id: ['Usuarios', 'id_usuario', 'SET NULL'],
  };

  for (const [column, [tableName, target, onDelete]] of Object.entries(foreignKeys)) {
    const attribute = Model.rawAttributes[column];
    assert.equal(attribute.references.model, tableName);
    assert.equal(attribute.references.key, target);
    assert.equal(attribute.onUpdate, 'CASCADE');
    assert.equal(attribute.onDelete, onDelete);
  }
});
