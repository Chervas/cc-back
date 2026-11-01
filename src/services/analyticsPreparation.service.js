'use strict';
const model = require('../lib/intake-analytics-preparation');
const attestation = require('../lib/intake-verification-attestation');

function createAnalyticsPreparation({ db, broker, resolveEffectiveMappings }) {
  const { Op } = db.Sequelize;
  async function mappingsFor(clinicIds, transaction) {
    const effective = resolveEffectiveMappings ? await resolveEffectiveMappings(transaction) : null;
    const rows = await db.ClinicAnalyticsProperty.findAll({ where: { ...(effective ? { id: { [Op.in]: effective.map(m => m.mapping_id) } } : { clinicaId: { [Op.in]: clinicIds } }), isActive: true },
      attributes: ['id', 'clinicaId', 'googleConnectionId', 'propertyName', 'broker_read_connection_ref', 'broker_read_asset_ref'],
      order: [['id', 'ASC']], limit: 101, raw: true, transaction });
    if (rows.length > 100) throw model.error('analytics_mapping_limit');
    // The actor is authorized for every group member. Reading an existing member
    // binding never grants the property to other clinics. Only an exact web-domain
    // match may configure the shared intake; multiple matches remain explicit.
    if (effective ? rows.length !== effective.length || rows.some(row => !effective.some(m => Number(m.mapping_id) === Number(row.id) && Number(m.clinic_id) === Number(row.clinicaId) && Number(m.connection_id) === Number(row.googleConnectionId) && m.resource === row.propertyName)) : rows.some(row => !clinicIds.some(id => Number(id) === Number(row.clinicaId)))) throw model.error('analytics_scope_changed', 403);
    return rows;
  }
  async function inspect({ record, clinicIds, body }) {
    const domain = model.host(body.domain || '');
    if (!domain || !(record.domains || []).some(d => model.host(d) === domain)) throw model.error('analytics_domain_forbidden', 403);
    const mappings = await mappingsFor(clinicIds);
    const resources = [...new Map(mappings.map(row => [row.propertyName, row])).values()];
    if (resources.length > 8) throw model.error('analytics_property_selection_required');
    const streams = [];
    for (const mapping of resources) {
      // No legacy-token fallback, no browser-supplied provider identifier.
      const context = await broker.prepare(mapping);
      if (!context) throw model.error('analytics_broker_required');
      const response = await broker.read(mapping, context, 'streams', {}, { beforeExecute: async () => {
        const fresh = await mappingsFor(clinicIds);
        if (model.revision(record, fresh) !== model.revision(record, mappings)) throw model.error('analytics_scope_changed', 403);
      } });
      streams.push(...response.data.dataStreams);
    }
    let signals = null;
    if (body.verification_attestation) {
      const proof = attestation.verifyVerificationAttestation(body.verification_attestation, {
        scopeType: record.assignment_scope, scopeId: record.assignment_scope === 'group' ? record.group_id : record.clinic_id,
        domain, configHash: attestation.buildVerificationConfigHash({ scopeType: record.assignment_scope,
          scopeId: record.assignment_scope === 'group' ? record.group_id : record.clinic_id,
          domains: record.domains, config: record.config, hmacKey: record.hmac_key }),
      });
      if (!proof.valid) throw model.error('analytics_verification_expired');
      signals = proof.claims.signals;
    }
    const result = model.plan({ record, mappings, streams, domain, signals, streamName: body.stream_name });
    return { result, mappings };
  }
  return {
    inspect,
    async apply({ record, clinicIds, body }) {
      const { result, mappings } = await inspect({ record, clinicIds, body });
      const config = model.apply(record, result, body);
      await db.sequelize.transaction(async transaction => {
        const current = await db.IntakeConfig.findByPk(record.id, { transaction, lock: transaction.LOCK.UPDATE });
        const currentMappings = await mappingsFor(clinicIds, transaction);
        if (!current || model.revision(current, currentMappings) !== result.revision) throw model.error('analytics_preparation_changed');
        // Identity/revocation guards are run again immediately before writing.
        for (const mapping of mappings) if (!await broker.prepare(mapping)) throw model.error('analytics_broker_required');
        await current.update({ config }, { transaction });
      });
      return { ...result, configured: true, verified: false, channels: config.features.ga4_bridge_channels,
        pending: result.pending.filter(p => p !== 'contact_channels_review') };
    },
  };
}
module.exports = { createAnalyticsPreparation };
