'use strict';
const { OPERATION } = require('./bedrock-limits');
const contract = require('./bedrock-contract');
const { createBedrockHttp } = require('./bedrock-http');
function createBedrockOperations({http=createBedrockHttp()}={}) {
  return {[OPERATION]:{provider:'aws_bedrock',persistResult:false,
    validate:contract.validate,authorize:contract.authorize,
    async execute({payload,secret,signal,assertActive}){assertActive();return http({payload,token:secret,signal});},
    project:value=>value,
  }};
}
module.exports = { createBedrockOperations };
