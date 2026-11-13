'use strict';

// Fictitious, deterministic cross-consumer vector. This module imports no
// runtime, database, credentials or digest implementation.
const EPOCH_MS = 1700000000123;
const RETIREMENT_DIGEST = 'e636403912f1b3c3fba3d097a798ba68cf1eac7a88752d645998bf9cb1174839';
const REASSOCIATION_DIGEST = 'f170551a48f9184c33f1186c998a08b66dd19700c84e57ea059c96ac095ac969';
const CLINIC_SET_DIGEST = '7ff031dbab81d9bf0b863b7bba3a53e1256749483694c6eb23af5df386f8e109';
const RETIREMENT_CANONICAL_JSON = '{"asset":"gbp:990000000000000000001:990000000000000000002","connection":"connection:fixture-gbp-reassociation","enrollment_id":"10000000-0000-4000-8000-000000000001","location":"990000000000000000002","retired_at":1700000000123,"tenant":"clinic:91001"}';
const PROOF_CANONICAL_JSON = '{"descriptorId":"20000000-0000-4000-8000-000000000002","retirementDigest":"e636403912f1b3c3fba3d097a798ba68cf1eac7a88752d645998bf9cb1174839","retirementEnrollmentId":"10000000-0000-4000-8000-000000000001","sourceAssetRef":"gbp:990000000000000000001:990000000000000000002","sourceConnectionRef":"connection:fixture-gbp-reassociation","sourceScopeRef":"gbp-enroll:clinic:91001","sourceTenantRef":"clinic:91001"}';
const REASSOCIATION_CANONICAL_JSON = '{"descriptor":{"descriptorId":"20000000-0000-4000-8000-000000000002","retirementDigest":"e636403912f1b3c3fba3d097a798ba68cf1eac7a88752d645998bf9cb1174839","retirementEnrollmentId":"10000000-0000-4000-8000-000000000001","sourceAssetRef":"gbp:990000000000000000001:990000000000000000002","sourceConnectionRef":"connection:fixture-gbp-reassociation","sourceScopeRef":"gbp-enroll:clinic:91001","sourceTenantRef":"clinic:91001"},"target":{"accountId":"990000000000000000001","clinicCount":1,"clinicSetDigest":"7ff031dbab81d9bf0b863b7bba3a53e1256749483694c6eb23af5df386f8e109","connection":"connection:fixture-gbp-reassociation","enrollmentId":"30000000-0000-4000-8000-000000000003","locationId":"990000000000000000002","previousAssetRef":null,"scope":"gbp-enroll:clinic:91070","tenant":"clinic:91070"}}';

function fixture() {
  const retirement = {
    tenant: 'clinic:91001', connection: 'connection:fixture-gbp-reassociation',
    asset: 'gbp:990000000000000000001:990000000000000000002', location: '990000000000000000002',
    enrollment_id: '10000000-0000-4000-8000-000000000001', retired_at: EPOCH_MS,
  };
  const proof = {
    descriptorId: '20000000-0000-4000-8000-000000000002',
    sourceTenantRef: retirement.tenant, sourceConnectionRef: retirement.connection,
    sourceScopeRef: 'gbp-enroll:clinic:91001', sourceAssetRef: retirement.asset,
    retirementEnrollmentId: retirement.enrollment_id, retirementDigest: RETIREMENT_DIGEST,
  };
  const request = {
    requestId: '40000000-0000-4000-8000-000000000004',
    operation: 'google.business_profile.enrollment.prepare.v1',
    tenantRef: 'clinic:91070', connectionRef: retirement.connection, assetRef: 'gbp-enroll:clinic:91070',
    payload: {
      enrollmentId: '30000000-0000-4000-8000-000000000003', accountId: '990000000000000000001',
      locationId: retirement.location, previousAssetRef: null, clinicCount: 1, clinicSetDigest: CLINIC_SET_DIGEST,
      reassociation: structuredClone(proof),
    },
  };
  return { retirement, proof, request };
}

module.exports = { fixture, EPOCH_MS, RETIREMENT_DIGEST, REASSOCIATION_DIGEST, CLINIC_SET_DIGEST,
  RETIREMENT_CANONICAL_JSON, PROOF_CANONICAL_JSON, REASSOCIATION_CANONICAL_JSON };
