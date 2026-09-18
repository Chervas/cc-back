'use strict';
// Fixed codes only. Never return SDK messages, headers, request bodies or stacks.
const PROVIDER_ERRORS = Object.freeze({
  InternalServerException:'bedrock_internal_error', ModelErrorException:'bedrock_model_error',
  ModelNotReadyException:'bedrock_model_not_ready', ModelTimeoutException:'bedrock_model_timeout',
  ServiceQuotaExceededException:'bedrock_service_quota', ServiceUnavailableException:'bedrock_service_unavailable',
  ThrottlingException:'bedrock_throttled', ValidationException:'bedrock_validation_failed',
  ResourceNotFoundException:'bedrock_model_not_found',
});
module.exports = { PROVIDER_ERRORS };
