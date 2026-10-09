'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function requiresReview(item) {
  return (item.output?.necesita_respuesta ?? item.output?.requiere_respuesta) === true
    || (item.planned || []).some((action) => action.type==='action/send_system_notification');
}

function check({report,expectations,cases,previous,casesBytes,previousCases,expectedCandidate,minimumRealInferences=200,regression=false,requireProviderTrace=false}) {
  assert.equal(report.complete,true,'partial replay is not a completed validation');
  assert.equal(report.clinicalWrites,false);
  assert.equal(report.sends,false);
  assert.equal(report.skipped.length,0);
  assert.equal(report.results.length,cases.cases.length);
  assert.equal(report.sourceLogs,cases.cases.length);
  assert.equal(expectations.reviewedBeforeInference,true);
  assert.equal(expectations.casesSha256,crypto.createHash('sha256').update(casesBytes).digest('hex'));
  assert.deepEqual(report.candidate,expectedCandidate || previous.candidate,'runtime must match the explicitly selected candidate');
  assert.ok(Number.isInteger(minimumRealInferences) && minimumRealInferences>0);
  if (regression) assert.ok(expectedCandidate,'regression must explicitly verify the current candidate');
  if (expectedCandidate) {
    for (const item of cases.cases) {
      assert.ok(item.currentPathEvidence,'current native path evidence is required');
      if (!item.currentPathError) assert.equal(item.currentPathEvidence.graphHash,
        crypto.createHash('sha256').update(JSON.stringify(item.nodes)).digest('hex'),'current graph changed after selection');
    }
  }
  const oldIds = new Set(previous.results.map((item) => item.id));
  const labels = new Map(expectations.expectations.map((item) => [item.id,item]));
  const byId = new Map(report.results.map((item) => [item.id,item]));
  assert.equal(byId.size,report.results.length);
  assert.equal(labels.size,expectations.expectations.length);
  assert.equal(labels.size,byId.size);
  const conversations = new Set(cases.cases.map((item) => item.context.conversation.id));
  if (!regression) assert.equal(conversations.size,cases.cases.length,'new sample must not count a conversation twice');
  if (previousCases) {
    const previousConversations=new Set(previousCases.cases.map((item)=>item.context.conversation.id));
    assert.ok([...conversations].every((id)=>!previousConversations.has(id)),'previous conversation reused');
  }
  const failures = [], conservative = [], legacyNonInference = [], groups = {}, providers = {}, states = {};
  let realCalls=0, realLiteCalls=0, reviews=0;
  const expectedSafetyHolds=[];
  const models={};
  for (const item of report.results) {
    const expected = labels.get(item.id);
    if (!regression && oldIds.has(item.id)) failures.push({id:item.id,reason:'previous_case_reused'});
    if (!expected) {failures.push({id:item.id,reason:'human_expectation_missing'});continue;}
    groups[expected.kind]=(groups[expected.kind]||0)+1;
    if (item.error) {
      if (expected.expectedError===item.error && item.inferenceCalls===0
        && (!requireProviderTrace || Array.isArray(item.providerTrace) && item.providerTrace.length===0)) expectedSafetyHolds.push(item.id);
      else failures.push({id:item.id,reason:'analysis_failed',error:item.error});
      continue;
    }
    if (expected.expectedError) failures.push({id:item.id,reason:'expected_safety_hold_not_applied'});
    assert.equal(item.clinicalWrites,false);
    assert.equal(item.sends,false);
    const provider = item.output?._ai_provider;
    providers[provider]=(providers[provider]||0)+1;
    const model=item.output?._ai_model;
    models[model]=(models[model]||0)+1;
    if (item.output?._ai_fallback_used === true || item.output?._ai_simulated === true) {
      failures.push({id:item.id,reason:'fallback_or_simulated_inference'});
    }
    if (requireProviderTrace || item.providerTrace) {
      const trace = item.providerTrace;
      if (!Array.isArray(trace) || trace.length !== 1) {
        failures.push({id:item.id,reason:'one_provider_call_not_verified'});
      } else if (trace[0].errorCode || trace[0].stopReason !== 'tool_use'
        || trace[0].model !== model || !(trace[0].usage?.input_tokens > 0)
        || !(trace[0].usage?.output_tokens > 0)
        || trace[0].usage.output_tokens >= trace[0].maxTokens) {
        failures.push({id:item.id,reason:'provider_completion_not_verified'});
      }
    }
    if (item.inferenceCalls===1 && provider==='bedrock') {
      realCalls++;
      if (String(model).includes('amazon.nova-lite-')) realLiteCalls++;
    }
    else if (item.inferenceCalls===0 && provider==='internal') legacyNonInference.push(item.id);
    else failures.push({id:item.id,reason:'one_real_inference_not_verified',calls:item.inferenceCalls,provider});
    const planned = (item.planned||[]).filter((action) => action.state).map((action) => action.state);
    for (const state of planned) states[state]=(states[state]||0)+1;
    if (planned.some((state) => !expected.allowedStates.includes(state))) {
      failures.push({id:item.id,reason:'wrong_clinical_state',expected:expected.allowedStates,planned});
    }
    if (expected.requiredStates?.some((state)=>!planned.includes(state))) {
      failures.push({id:item.id,reason:'independent_confirmation_not_preserved',required:expected.requiredStates,planned});
    }
    const review = requiresReview(item);
    if (review) reviews++;
    if (expected.requiresDecisionOrReview && !planned.length) {
      if (!review) failures.push({id:item.id,reason:'clinical_request_lost_without_review'});
      else conservative.push(item.id);
    }
    if (expected.needsResponse && !review) failures.push({id:item.id,reason:'unresolved_question_lost'});
  }
  if (realCalls<minimumRealInferences) failures.push({reason:'fewer_than_200_additional_real_inferences',realCalls,minimumRealInferences});
  if (realLiteCalls<minimumRealInferences) failures.push({reason:'fewer_than_200_additional_nova_lite_inferences',realLiteCalls,minimumRealInferences});
  return {validationKind:regression?'current_native_path_regression':'additional_distinct_conversations',
    casesSha256:expectations.casesSha256,
    cases:report.results.length,distinctConversations:conversations.size,realCalls,realLiteCalls,providers,models,groups,
    projectedStates:states,reviews,conservative,legacyNonInference,expectedSafetyHolds,failures,
    cutoff:report.cutoff,clinicalWrites:false,sends:false,
    limitation:'Human-reviewed simulations on reconstructed inputs, not an exact original-input replay or an assertion about current production review state.'};
}

module.exports={check,requiresReview};
if (require.main===module) {
  const [reportFile,expectationsFile,casesFile,previousFile] = process.argv.slice(2);
  const read = (file) => JSON.parse(fs.readFileSync(file));
  const priorCasesIndex=process.argv.indexOf('--previous-cases');
  const candidateIndex=process.argv.indexOf('--candidate-backend');
  const expectedCandidate=candidateIndex>=0 ? Object.fromEntries([
    'src/services/flowEngineV2.service.js','src/lib/automation-intent-contract.js',
    'src/lib/automation-conversation-context.js','src/lib/same-day-canonical-flow.js',
  ].map((path)=>[path,crypto.createHash('sha256').update(fs.readFileSync(process.argv[candidateIndex+1]+'/'+path)).digest('hex')])) : null;
  const minimumIndex=process.argv.indexOf('--minimum-real-inferences');
  const result = check({report:read(reportFile),expectations:read(expectationsFile),cases:read(casesFile),
    previous:read(previousFile),casesBytes:fs.readFileSync(casesFile),
    previousCases:priorCasesIndex>=0 ? read(process.argv[priorCasesIndex+1]) : null,expectedCandidate,
    minimumRealInferences:minimumIndex>=0 ? Number(process.argv[minimumIndex+1]) : 200,
    regression:process.argv.includes('--regression'),
    requireProviderTrace:process.argv.includes('--require-provider-trace')});
  const out = process.argv.indexOf('--report');
  if (out>=0) fs.writeFileSync(process.argv[out+1],JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(result));
  if (result.failures.length) process.exitCode=1;
}
