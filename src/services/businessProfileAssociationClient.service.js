'use strict';
const fs = require('node:fs'); const path = require('node:path'); const {randomUUID} = require('node:crypto');
const C = require('./businessProfileAssociation.contract');
const {createIntegrationsBrokerClient} = require('../lib/integrationsBrokerClient');
const PREFIX = 'google.business_profile.enrollment.';
const exact = (v,keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
function createClient({client,controlClient}) {
  function envelope(result,id) { if (!exact(result,['requestId','data','replayed']) || result.requestId !== id || typeof result.replayed !== 'boolean') C.fail('broker_response_invalid'); return result.data; }
  async function command(row,kind,beforeExecute) {
    const control = ['retire','abort'].includes(kind); const id = kind === 'status' ? randomUUID() : row[kind + '_request_id'];
    if (!C.UUID.test(id) || typeof beforeExecute !== 'function') C.fail(); await beforeExecute();
    const payload = kind === 'status' ? {enrollmentId:row.attempt_id} : {enrollmentId:row.attempt_id,accountId:row.account_id,locationId:row.location_id,previousAssetRef:row.previous_asset_ref,clinicCount:1,clinicSetDigest:C.hash([Number(row.clinica_id)])};
    const result = await (control ? controlClient : client).execute({requestId:id,operation:PREFIX + kind + '.v1',tenantRef:'clinic:' + row.clinica_id,connectionRef:row.connection_ref,assetRef:row.scope_ref,payload},{timeoutMs:10000});
    await beforeExecute(); const data = envelope(result,id);
    if(kind === 'status' && exact(data,['enrollmentId','state','accessBlocked']) && data.enrollmentId === row.attempt_id && data.state === 'not_found' && data.accessBlocked === true) return data;
    const fields = ['enrollmentId','assetRef','scopeRef','accountId','locationId','previousAssetRef','clinicCount','clinicSetDigest','state','previousAssetRetired','accessBlocked'];
    if (!exact(data,fields) || data.enrollmentId !== row.attempt_id || data.assetRef !== `gbp:${row.account_id}:${row.location_id}` || data.scopeRef !== row.scope_ref || data.accountId !== row.account_id || data.locationId !== row.location_id || data.previousAssetRef !== row.previous_asset_ref || data.clinicCount !== 1 || data.clinicSetDigest !== C.hash([Number(row.clinica_id)]) || !['prepared','active','cancelled','retired'].includes(data.state) || typeof data.previousAssetRetired !== 'boolean' || typeof data.accessBlocked !== 'boolean') C.fail('broker_response_invalid');
    if (kind === 'prepare' && !['prepared','active'].includes(data.state) || kind === 'activate' && data.state !== 'active' || kind === 'retire' && (!data.previousAssetRetired || !['active','retired'].includes(data.state)) || kind === 'abort' && (data.state !== 'cancelled' || !data.accessBlocked) || !control && kind !== 'status' && data.accessBlocked) C.fail('broker_response_invalid');
    return data;
  }
  return { command, async discover(scope,beforeExecute) {
    const all = []; const tokens = new Set(); let pageToken = null;
    for (let page = 0; page < 4; page++) {
      await beforeExecute(); const requestId = randomUUID();
      const r = await client.execute({requestId,operation:PREFIX + 'discover.v1',tenantRef:'clinic:' + scope.clinica_id,connectionRef:scope.connection_ref,assetRef:scope.scope_ref,payload:{pageToken}},{timeoutMs:10000});
      await beforeExecute(); const data = envelope(r,requestId);
      if (!exact(data,['locations','nextPageToken']) || !Array.isArray(data.locations) || data.locations.length > 250 || Buffer.byteLength(JSON.stringify(data)) > 786432) C.fail('broker_response_invalid');
      for (const row of data.locations) {
        const target = C.providerTarget(row);
        if (!scope.account_ids.includes(row.accountId) || scope.location_ids.length && !scope.location_ids.includes(row.locationId) || all.some(old => old.locationName === target.locationName)) C.fail('broker_response_invalid');
        all.push(target);
      }
      if (data.nextPageToken === null) return all;
      if (typeof data.nextPageToken !== 'string' || !/^[A-Za-z0-9_-]{40,4096}$/.test(data.nextPageToken) || tokens.has(data.nextPageToken)) C.fail('broker_response_invalid');
      tokens.add(data.nextPageToken); pageToken = data.nextPageToken;
    }
    C.fail('broker_response_invalid');
  }};
}
function privateFile(filename) { try { if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) C.fail(); const st=fs.statSync(filename); if (!st.isFile() || st.mode & 0o077 || st.size > 65536) C.fail(); return fs.readFileSync(filename); } catch { C.fail('gbp_association_unavailable'); } }
function configuredClient() {
  let enrolling,control;
  const make = role => createIntegrationsBrokerClient({origin:process.env.INTEGRATIONS_BROKER_ORIGIN,audience:process.env.INTEGRATIONS_BROKER_AUDIENCE,ca:privateFile(process.env.INTEGRATIONS_BROKER_CA_FILE),keyId:process.env['GOOGLE_BUSINESS_PROFILE_' + role + '_KEY_ID'],privateKey:privateFile(process.env['GOOGLE_BUSINESS_PROFILE_' + role + '_KEY_FILE']),timeoutMs:10000});
  return createClient({client:{execute(...args){return (enrolling ||= make('ENROLLMENT')).execute(...args);}},controlClient:{execute(...args){return (control ||= make('ENROLLMENT_CONTROL')).execute(...args);}}});
}
module.exports = {createClient,configuredClient};
