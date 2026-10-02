'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {check}=require('../qa/check-extended-appointment-replay');
const {installHistoricalConversationClock}=require('../qa/historical-replay-context');
const {currentAnalysisNode}=require('../qa/hydrate-current-automation-paths');

function fixture() {
  const cases={cases:Array.from({length:200},(_,i)=>({id:i+1,context:{conversation:{id:i+1}}}))};
  const casesBytes=Buffer.from(JSON.stringify(cases));
  const candidate={runtime:'unchanged'};
  return {cases,casesBytes,previous:{candidate,results:[]},
    expectations:{reviewedBeforeInference:true,casesSha256:crypto.createHash('sha256').update(casesBytes).digest('hex'),
      expectations:cases.cases.map(c=>({id:c.id,kind:'attendance',allowedStates:['recordatorio_confirmado'],
        requiresDecisionOrReview:true,needsResponse:false}))},
    report:{complete:true,candidate,clinicalWrites:false,sends:false,skipped:[],sourceLogs:200,
      results:cases.cases.map(c=>({id:c.id,inferenceCalls:1,output:{_ai_provider:'bedrock',_ai_model:'eu.amazon.nova-lite-v1:0',necesita_respuesta:false},
        planned:[{state:'recordatorio_confirmado'}],clinicalWrites:false,sends:false}))}};
}
test('checks 200 distinct additional real decisions',()=>assert.equal(check(fixture()).failures.length,0));
test('review without a state change is explicit conservative coverage',()=>{
  const input=fixture();input.report.results[0].planned=[];input.report.results[0].output.necesita_respuesta=true;
  assert.deepEqual(check(input).conservative,[1]);assert.equal(check(input).failures.length,0);
});
test('wrong cancellation is not hidden by also requiring review',()=>{
  const input=fixture();input.report.results[0].planned=[{state:'cancelada'}];input.report.results[0].output.necesita_respuesta=true;
  assert.equal(check(input).failures[0].reason,'wrong_clinical_state');
});
test('does not silently lose a clear request',()=>{
  const input=fixture();input.report.results[0].planned=[];
  assert.equal(check(input).failures[0].reason,'clinical_request_lost_without_review');
});
test('a confirmation must not hide a question',()=>{
  const input=fixture();input.expectations.expectations[0].needsResponse=true;
  assert.equal(check(input).failures[0].reason,'unresolved_question_lost');
});
test('rejects more than one inference and insufficient real coverage',()=>{
  const input=fixture();input.report.results[0].inferenceCalls=2;
  assert.deepEqual(check(input).failures.map(f=>f.reason),['one_real_inference_not_verified','fewer_than_200_additional_real_inferences','fewer_than_200_additional_nova_lite_inferences']);
});
test('rejects partial results, changed runtime and tampered expectations',()=>{
  const input=fixture();input.report.complete=false;assert.throws(()=>check(input));
  input.report.complete=true;input.report.candidate={runtime:'modified'};assert.throws(()=>check(input));
  input.report.candidate=input.previous.candidate;input.expectations.casesSha256='wrong';assert.throws(()=>check(input));
});
test('does not count previous IDs or duplicate conversations as new coverage',()=>{
  const input=fixture();input.previous.results=[{id:1}];
  assert.equal(check(input).failures[0].reason,'previous_case_reused');
  input.cases.cases[1].context.conversation.id=1;assert.throws(()=>check(input));
});
test('historical day is injected only into conversation hydration, not the global clock',async()=>{
  const now=Date.now(),at='2026-09-01T08:30:00Z';
  const original=async input=>input;
  const contextModule={buildConversationContext:original};
  const restore=installHistoricalConversationClock(contextModule,()=>({at}));
  const result=await contextModule.buildConversationContext({clinicId:3});
  assert.equal(result.now.toISOString(),at.replace('00Z','00.000Z'));
  assert.equal(result.clinicId,3);
  assert.ok(Date.now()>=now);
  restore();assert.equal(contextModule.buildConversationContext,original);
});
test('scope holds are not counted as real model decisions',()=>{
  const input=fixture();
  input.expectations.expectations[0].expectedError='automation_conversation_scope_mismatch';
  input.report.results[0]={id:1,inferenceCalls:0,error:'automation_conversation_scope_mismatch'};
  const result=check(input);
  assert.equal(result.realCalls,199);assert.deepEqual(result.expectedSafetyHolds,[1]);
  assert.ok(result.failures.some(f=>f.reason==='fewer_than_200_additional_real_inferences'));
});
test('previous conversations are rejected even under a different analysis ID',()=>{
  const input=fixture();input.previousCases={cases:[{id:500,context:{conversation:{id:1}}}]};
  assert.throws(()=>check(input),/previous conversation reused/);
});

test('a removed historical AI node is replaced only through the same native wait and reference',()=>{
  const item={id:1,node:{id:'OLD'},nodes:[{id:'WAIT',type:'delay/wait_response',config:{listens_to_node_id:'SEND'}}]};
  const template={nodes:[{id:'WAIT',type:'delay/wait_response',config:{listens_to_node_id:'SEND'},outputs:{on_response:'CURRENT'}},
    {id:'CURRENT',type:'condition/ai_analysis'}]};
  assert.equal(currentAnalysisNode(item,template,'WAIT').id,'CURRENT');
  template.nodes[0].config.listens_to_node_id='OTHER_SEND';
  assert.throws(()=>currentAnalysisNode(item,template,'WAIT'),/reference_not_equivalent/);
});

test('baseline regression is separate from new coverage and still verifies current graphs and code',()=>{
  const input=fixture();
  input.previous.results=[{id:1}];input.regression=true;
  assert.throws(()=>check(input),/current candidate/);
  input.expectedCandidate=input.report.candidate;
  for(const item of input.cases.cases){item.nodes=[];item.currentPathEvidence={graphHash:crypto.createHash('sha256').update('[]').digest('hex')};}
  const result=check(input);
  assert.equal(result.validationKind,'current_native_path_regression');
  assert.equal(result.failures.length,0);
  input.cases.cases[1].context.conversation.id=1;
  assert.equal(check(input).distinctConversations,199);
});
