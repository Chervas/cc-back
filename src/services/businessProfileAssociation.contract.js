'use strict';
const { createHash } = require('node:crypto');
const { UUID } = require('../../services/platform-audit/src/event');
const PREFIX = 'gbp_association_';
const fail = (code = PREFIX + 'invalid') => { throw Object.assign(Error(code), { code }); };
const positive = v => /^(?:[1-9]\d{0,9})$/.test(String(v)) && Number(v) <= 2147483647;
const HASH = /^[a-f0-9]{64}$/;
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const external = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
function resource(value, type) { const m = typeof value === 'string' && new RegExp('^' + type + '/([1-9]\\d{0,29})$').exec(value); if (!m) fail(); return m[1]; }
function location(value) { const m = typeof value === 'string' && /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(value); if (!m) fail(); return m[1]; }
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fields = ['id','clinica_id','google_connection_id','location_id','is_active','broker_read_connection_ref','broker_read_asset_ref'];
function identity(row) { return row ? fields.map(key => key === 'location_id' ? location(row[key]) : key === 'is_active' ? !!row[key] : row[key] ?? null) : null; }
const fingerprint = row => hash(identity(row));
const associationFingerprint = (row,impactDigest,lineage=[]) => hash({mapping:identity(row),reviewImpactDigest:impactDigest,...(lineage.length?{lineage}:{})});
const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } } return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
const array = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { fail(); } } if (!Array.isArray(value)) fail(); return value; };
function address(raw) { const a = raw?.storefrontAddress || raw?.storefront_address || {}; return [...(Array.isArray(a.addressLines) ? a.addressLines : []), a.postalCode, a.locality, a.administrativeArea].filter(v => typeof v === 'string' && v.trim()).join(', ').slice(0, 1024); }
function target(row) { if (!row) return null; const raw = object(row.raw_payload); return { mappingId: Number(row.id), name: row.location_name || '', address: address(raw), accountName: /^gbp:([1-9]\d{0,29}):/.exec(row.broker_read_asset_ref || '')?.[1] ? 'accounts/' + row.broker_read_asset_ref.split(':')[1] : (raw.accountName || ''), locationName: 'locations/' + location(row.location_id) }; }
const STATES = ['prepare_pending','prepared','activate_pending','broker_active','retire_pending','active','cancel_pending','cancelled'];
const PENDING = ['prepare_pending','activate_pending','broker_active','retire_pending','cancel_pending'];
function dtoTarget(value) { if (!value) return null; const o=object(value); return Object.fromEntries(['mappingId','name','address','accountName','locationName'].map(k=>[k,o[k] ?? (k === 'mappingId' ? null : '')])); }
function dto(row) { const current = row.current_snapshot ? object(row.current_snapshot) : null; return { attemptId: row.attempt_id, clinicId: Number(row.clinica_id), state: row.state, current: dtoTarget(current), target: dtoTarget(row.target_snapshot), sourceFingerprint: row.source_fingerprint, error: row.last_error || null, retryAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null, canConfirm: row.state === 'prepared', reviewDestinationChangeRequired: object(row.target_snapshot).reviewDestinationChangeRequired===true, reviewDestinationChangeAccepted: object(row.target_snapshot).reviewDestinationChangeAccepted===true, affectedReviewCampaignCount: Number(object(row.target_snapshot).affectedReviewCampaignCount)||0 }; }
function reviewReference(config, mapping) {
  const c = object(config); const r = object(c.reviews || c.resenas || c.review_requests); const a = object(r.google_business_profile_alias || r.business_profile_alias);
  const ids = [a.business_location_id,a.businessLocationId,r.google_business_profile_alias_business_location_id,r.google_business_location_alias_business_location_id,c.review_google_business_profile_alias_business_location_id];
  const resources = [a.location_id,a.locationId,r.google_business_profile_alias_location_id,r.google_business_location_alias_location_id,c.review_google_business_profile_alias_location_id];
  const clinics = [a.clinic_id,a.clinica_id,a.clinicId,r.google_business_profile_alias_clinic_id,r.google_business_location_alias_clinic_id,r.review_google_profile_alias_clinic_id,c.review_google_business_profile_alias_clinic_id,c.review_google_profile_alias_clinic_id,c.review_google_alias_clinic_id];
  return ids.some(v => positive(v) && Number(v) === Number(mapping.id)) || resources.some(v => { try { return location(v) === location(mapping.location_id); } catch { return false; } }) || clinics.some(v => positive(v) && Number(v) === Number(mapping.clinica_id));
}
function publicMetadata(value) {
  const v=object(value); const result={hasVoiceOfMerchant:v.hasVoiceOfMerchant === true};
  if(v.placeId!==undefined){if(typeof v.placeId!=='string'||Buffer.byteLength(v.placeId)>8192||!/^[A-Za-z0-9_-]+$/.test(v.placeId))fail('broker_response_invalid');result.placeId=v.placeId;}
  for(const key of ['mapsUri','newReviewUri'])if(v[key]!==undefined){let u;try{u=new URL(v[key]);}catch{fail('broker_response_invalid');}if(typeof v[key]!=='string'||Buffer.byteLength(v[key])>8192||u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['google.com','www.google.com','maps.google.com','search.google.com','google.es','www.google.es','maps.google.es','search.google.es'].includes(u.hostname)||/^\/url(?:\/|$)/i.test(u.pathname))fail('broker_response_invalid');result[key]=v[key];}
  return result;
}
function reviewCampaign(row) {
  const c=object(row?.criteria); const normalize=v=>String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  if(c.review_request===true||c.review_request===1||['true','1'].includes(String(c.review_request??'').toLowerCase()))return true;
  if(['solicitud_resena','resena','resenas','review_request','reviews'].includes(normalize(c.template_usage)))return true;
  if([c.dispatch,c.dispatch_config].some(v=>{const d=object(v);return ['review_request','reviews','solicitud_resena','resenas'].includes(normalize(d.context||d.dispatch_context));}))return true;
  return [row?.objective_id,row?.source].some(v=>['review_request','review_requests','reviews','resenas','solicitud_resena','automatic_review_request'].includes(normalize(v)));
}
function providerTarget(row) {
  if (!row || !external(row.accountId) || !external(row.locationId) || row.accountName !== 'accounts/' + row.accountId || row.name !== 'locations/' + row.locationId || typeof row.title !== 'string' || row.title.length > 1024 || /[\x00-\x1f]/.test(row.title)) fail('broker_response_invalid');
  const reassociation=row.reassociation;
  if(reassociation!==undefined)require('../../services/integrations-broker/src/google-business-profile-enrollment-contract').validateReassociation(reassociation);
  return { mappingId: null, name: row.title.slice(0, 256), address: address(row), accountName: row.accountName, locationName: row.name, storeCode: typeof row.storeCode === 'string' ? row.storeCode.slice(0,128) : null, isVerified: row.metadata?.hasVoiceOfMerchant === true,...(reassociation?{reassociation:structuredClone(reassociation)}:{}), rawLocation: { name: row.name, title: row.title.slice(0,256), storefrontAddress: row.storefrontAddress || null, metadata: publicMetadata(row.metadata), accountName: row.accountName, accountDisplayName: row.accountDisplayName || row.accountName } };
}
module.exports = { fail, positive, HASH, ref, external, resource, location, hash, identity, fingerprint, associationFingerprint, object, array, address, target, providerTarget, publicMetadata, reviewCampaign, dto, reviewReference, UUID, STATES, PENDING };
