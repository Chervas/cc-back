'use strict';
const {schema}=require('./contracts'),{fail}=require('./errors'),C=require('./meta-marketing-oauth-contract');
const OPERATIONS=Object.freeze({rotate:'meta.marketing.credential.maintenance.rotate.v1',status:'meta.marketing.credential.maintenance.status.v1',health:'meta.marketing.credential.maintenance.health.v1'});
const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const validators={rotate:schema({maintenanceId:uuid,enrollmentId:uuid,expectedEpoch:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1},expectedVersionId:uuid,expectedCandidateDigest:digest}),status:schema({maintenanceId:uuid}),health:schema({enrollmentId:uuid,expectedEpoch:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1},expectedVersionId:uuid,expectedCandidateDigest:digest})};
const STATES=Object.freeze(['processing','not_applied','staged','active','rejected','interrupted','not_found']);
function validate(operation,payload){const name=Object.keys(OPERATIONS).find(n=>OPERATIONS[n]===operation);if(!name)fail('operation_denied');validators[name](payload);return name;}
module.exports={OPERATIONS,STATES,validators,validate};
