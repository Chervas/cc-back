'use strict';

function isGatewayRuntime(env = process.env) {
  return String(env.RUNTIME_ROLE || '').trim().toLowerCase() === 'gateway';
}

function resolveEnqueueRuntimeNamespace(currentNamespace, requestedNamespace, env = process.env) {
  if (!isGatewayRuntime(env)) return requestedNamespace || currentNamespace;
  const owner = String(env.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE || '').trim();
  // Public entries hand off only to their configured business owner, never
  // locally, to DEV or to an arbitrary caller-supplied runtime.
  if (!owner || ['gateway', 'dev', 'runtime:unknown'].includes(owner.toLowerCase())
    || owner === currentNamespace || (requestedNamespace && requestedNamespace !== owner)) {
    const error = new Error('Gateway business job owner is unavailable');
    error.code = 'gateway_job_owner_unavailable';
    throw error;
  }
  return owner;
}

module.exports = { isGatewayRuntime, resolveEnqueueRuntimeNamespace };
