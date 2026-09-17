'use strict';
module.exports = {
  async up(q, S) {
    const timestamps = { created_at: { type:S.DATE,allowNull:false }, updated_at: { type:S.DATE,allowNull:false } };
    const id = { type:S.INTEGER.UNSIGNED,autoIncrement:true,primaryKey:true };
    await q.createTable('SecurityMonitoringSettings', { id, scope:{type:S.STRING(32),allowNull:false,unique:true}, rules:{type:S.JSON,allowNull:false}, updated_by:S.INTEGER, ...timestamps });
    await q.createTable('SecurityMonitoringAlerts', { id, dedupe_key:{type:S.STRING(191),allowNull:false,unique:true}, rule_key:{type:S.STRING(80),allowNull:false}, entity_type:{type:S.STRING(40),allowNull:false}, entity_id:{type:S.STRING(160),allowNull:false}, clinic_id:S.INTEGER, title:{type:S.STRING(255),allowNull:false}, detail:{type:S.STRING(1000),allowNull:false}, measured_value:{type:S.DECIMAL(20,6),allowNull:false}, threshold:{type:S.DECIMAL(20,6),allowNull:false}, status:{type:S.STRING(24),allowNull:false,defaultValue:'open'}, notification_queued_at:S.DATE, acknowledged_by:S.INTEGER, acknowledged_at:S.DATE, ...timestamps });
    await q.addIndex('SecurityMonitoringAlerts',['status','created_at'],{name:'idx_security_alerts_state_date'});
    await q.createTable('SecurityMonitoringMeasures', { id, entity_type:{type:S.STRING(40),allowNull:false}, entity_id:{type:S.STRING(160),allowNull:false}, label:{type:S.STRING(255),allowNull:false}, clinic_id:S.INTEGER, paused:{type:S.BOOLEAN,allowNull:false,defaultValue:false}, reason:{type:S.STRING(500),allowNull:false}, updated_by:{type:S.INTEGER,allowNull:false}, ...timestamps });
    await q.addIndex('SecurityMonitoringMeasures',['entity_type','entity_id'],{name:'uq_security_measure_entity',unique:true});
    await q.createTable('SecurityMonitoringChanges', { id, entity_type:{type:S.STRING(40),allowNull:false}, entity_id:{type:S.STRING(160),allowNull:false}, action:{type:S.STRING(40),allowNull:false}, actor_id:{type:S.INTEGER,allowNull:false}, detail:{type:S.JSON,allowNull:false}, ...timestamps });
    await q.createTable('AiModelPrices', { id, provider:{type:S.STRING(32),allowNull:false}, model:{type:S.STRING(160),allowNull:false}, input_usd_million:S.DECIMAL(16,6),cached_input_usd_million:S.DECIMAL(16,6),output_usd_million:S.DECIMAL(16,6),audio_usd_hour:S.DECIMAL(16,6),search_usd_thousand:S.DECIMAL(16,6),long_context_threshold:S.INTEGER,long_input_multiplier:S.DECIMAL(8,3),long_output_multiplier:S.DECIMAL(8,3),source_url:S.STRING(1000),updated_by:S.INTEGER,...timestamps });
    await q.addIndex('AiModelPrices',['provider','model'],{name:'uq_ai_model_price',unique:true});
    await q.addColumn('AiUsageDaily','cached_input_tokens',{type:S.BIGINT.UNSIGNED,allowNull:false,defaultValue:0});
    await q.addColumn('AiUsageDaily','audio_seconds',{type:S.DECIMAL(18,3),allowNull:false,defaultValue:0});
    await q.addColumn('AiUsageDaily','search_requests',{type:S.INTEGER.UNSIGNED,allowNull:false,defaultValue:0});
    await q.addColumn('AiUsageDaily','unpriced_requests',{type:S.INTEGER.UNSIGNED,allowNull:false,defaultValue:0});
    // Preserve historical amounts; new requests store the effective price snapshot.
  },
  async down(q) {
    for (const field of ['unpriced_requests','search_requests','audio_seconds','cached_input_tokens']) await q.removeColumn('AiUsageDaily',field);
    for (const name of ['AiModelPrices','SecurityMonitoringChanges','SecurityMonitoringMeasures','SecurityMonitoringAlerts','SecurityMonitoringSettings']) await q.dropTable(name);
  },
};
