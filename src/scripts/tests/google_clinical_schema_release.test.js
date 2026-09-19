'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const google=require('../../lib/googleClinicalSchemaRelease'),meta=require('../../lib/metaClinicalSchemaRelease');
const {assertGoogleClinicalRuntime}=require('../../lib/googleClinicalRuntime');
test('Google schema entry points are explicit and cannot widen the Meta migration allowlist',()=>{
 const source=path.resolve(__dirname,'../../..'),dir='/var/lib/clinicaclick-schema-recovery/google-owned-plan';
 const cli=require('../google-clinical-schema-release'),cut=require('../google-clinical-cut');
 assert.equal(cli.args(['plan','--source',source,'--dir',dir]).action,'plan');
 assert.equal(cut.parse(['preflight','--dir',dir,'--out','/home/ubuntu/qa-evidence/google-owned']).action,'preflight');
 for(const args of [['apply','--source',source,'--dir','/tmp/plan'],['apply','--source',source,'--dir',dir,'--force'],['apply','--source',source,'--dir',dir+'/child']])assert.throws(()=>cli.args(args));
 assert.equal(google.MIGRATIONS.length,19);assert.equal(meta.MIGRATIONS.length,9);
 assert.equal(google.MIGRATIONS.filter(name=>meta.MIGRATIONS.includes(name)).length,0);
 assert.deepEqual(google.TABLES,['GoogleConnections','ClinicBusinessLocations','ClinicWebAssets','ClinicAnalyticsProperties','ClinicGoogleAdsAccounts','GoogleConnectionAssignments','GroupAssetClinicAssignments','GoogleAdsConversionUploadAttempts']);
});
test('clinical cut rejects migration activation while preserving existing direct-provider configuration',()=>{
 const env={AUTH_SESSION_MODE:'enforce',AUTH_EMAIL_MFA_MODE:'enforce',CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED:'true'};
 assertGoogleClinicalRuntime(env);
 for(const flag of ['GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED','GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED','GOOGLE_ANALYTICS_BROKER_ENABLED','GOOGLE_ADS_BROKER_ENABLED','GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED','GOOGLE_ADS_LEADS_BROKER_ENABLED','GOOGLE_OAUTH_BROKER_WORKER_ENABLED','GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED','GOOGLE_ADS_MAPPING_ENABLED','GOOGLE_ADS_ENROLLMENT_WORKER_ENABLED','GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED']){
  assert.throws(()=>assertGoogleClinicalRuntime({...env,[flag]:'true'}),/activation_requires_review/);
  assert.throws(()=>assertGoogleClinicalRuntime({...env,[flag]:'1'}),/activation_requires_review/);
  assertGoogleClinicalRuntime({...env,[flag]:'false'});
 }
 assert.throws(()=>assertGoogleClinicalRuntime({...env,AUTH_SESSION_MODE:'observe'}),/runtime_review/);
});
