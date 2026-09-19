#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {createClinicalSchemaCutOperator}=require('../lib/clinicalSchemaCutOperator');
const {clinicalCutFailure}=require('../lib/clinicalCutFailure');
const {assertGoogleClinicalRuntime}=require('../lib/googleClinicalRuntime');
const {parse,run}=createClinicalSchemaCutOperator({source:path.resolve(__dirname,'../..'),
 operator:require('./google-clinical-schema-release'),policy:require('../lib/googleClinicalSchemaRelease'),assertRuntime:assertGoogleClinicalRuntime});
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(JSON.stringify({status:'clinical_cut_failed_inspect_before_retry',failure:clinicalCutFailure(error),recoveryFailures:error.recoveryFailures||[]}));process.exitCode=1;});
module.exports={parse,run};
