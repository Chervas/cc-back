'use strict';
const { randomUUID } = require('node:crypto');
const { fromBinding } = require('../../../services/googlePropertyRevocation.contract');
const { site } = require('../../../../services/integrations-broker/src/google-search-console-contract');
function revocationFor(kind, mapping, subject = 'fictitious-subject') {
  return { ...fromBinding(kind, { mapping_id: mapping.id, clinica_id: mapping.clinicaId, google_connection_id: mapping.googleConnectionId,
    google_user_id: subject, state: 'active', connection_ref: mapping.broker_read_connection_ref, asset_ref: mapping.broker_read_asset_ref,
    ...(kind === 'search_console' ? { site_url: mapping.siteUrl, site_hash: site(mapping.siteUrl).siteHash } : { property_name: mapping.propertyName }) }),
    request_id: randomUUID(), actor_user_id: 501, requested_at: new Date('2026-09-13T12:00:00.000Z'), next_attempt_at: new Date('2026-09-13T12:00:00.000Z'),
    state: 'pending', attempts: 1, lease_token: randomUUID(), lease_until: new Date('2026-09-13T12:02:00.000Z') };
}
module.exports = { revocationFor };
