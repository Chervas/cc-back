'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

// Human-reviewed expectations for a frozen, private replay. These are QA cases,
// not patient-text rules or identifiers used by the production engine.
const NO_STATE_CHANGE = [17167,18616,20397,24006,22268,22355,22485,22579,22991,23099,
  23271,23347,23352,23417,23421,23443,23653,24001,24013,24030,22306,22311,
  22275,22576,22964,23312,24018];
const CHANGE_REQUEST = [22282,23407,23412,23426,23928,24023];
const CONFIRM_ATTENDANCE = [18423,19990,22301,22316,22474,22482,22568,22572,
  22830,22835,22878,23052,23057,23122,23126,23136,23151,23160,23435,23439,23448,23647,
  16449,22863,23843,23847,23851,23857,23863];
const CANCEL_WITHOUT_ALTERNATIVE = [22289,22562,22839,23084,23706];
const CONFIRM_DATA = [22340,22376,22421,22427,22818,22822,22826,22874,22895,23095,
  23147,23173,23184,23213,23222,23278,23284,23643,23660,23679,23698,23702,23726,23735,
  23766,23924,24064,24078,24089,24106];
const OPTIONAL_ATTENDANCE = [22296,22344,23920];
const OPTIONAL_DATA = [14047];
const NEEDS_RESPONSE = [20397,24006,22268,22282,22355,22482,22485,22579,22991,23099,
  23271,23407,23412,23417,23421,23426,23443,23653,23843,23920,23928,24023];

function check(report) {
  assert.equal(report.clinicalWrites, false);
  assert.equal(report.sends, false);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.results.length, report.sourceLogs);
  const byId = new Map(report.results.map((item) => [item.id,item]));
  assert.equal(byId.size, report.results.length);
  const failures = [], conservative = [];
  function verify(id, allowed, required = false) {
    const item = byId.get(id);
    if (!item || item.error) { failures.push({id,reason:'missing_or_failed_analysis'}); return; }
    const states = item.planned.filter((action) => action.state).map((action) => action.state);
    if (states.some((state) => !allowed.includes(state))) failures.push({id,reason:'wrong_clinical_state',states});
    if (required && !states.length
      && (item.output?.necesita_respuesta ?? item.output?.requiere_respuesta) !== true) {
      failures.push({id,reason:'clear_confirmation_lost_without_review'});
    }
    if (allowed.length && !states.length) conservative.push(id);
  }
  for (const id of NO_STATE_CHANGE) verify(id, []);
  for (const id of CHANGE_REQUEST) verify(id, ['cambio_solicitado']);
  for (const id of CANCEL_WITHOUT_ALTERNATIVE) verify(id, ['cancelada']);
  for (const id of CONFIRM_ATTENDANCE) verify(id, ['recordatorio_confirmado'], true);
  for (const id of CONFIRM_DATA) verify(id, ['info_confirmada'], true);
  for (const id of OPTIONAL_ATTENDANCE) verify(id, ['recordatorio_confirmado']);
  for (const id of OPTIONAL_DATA) verify(id, ['info_confirmada']);
  const expectedIds = [...NO_STATE_CHANGE,...CHANGE_REQUEST,...CANCEL_WITHOUT_ALTERNATIVE,
    ...CONFIRM_ATTENDANCE,...CONFIRM_DATA,...OPTIONAL_ATTENDANCE,...OPTIONAL_DATA];
  assert.equal(new Set(expectedIds).size, expectedIds.length);
  for (const id of NEEDS_RESPONSE) {
    const item = byId.get(id);
    if ((item?.output?.necesita_respuesta ?? item?.output?.requiere_respuesta) !== true) {
      failures.push({id,reason:'unresolved_question_lost'});
    }
  }
  for (const item of report.results) {
    if (!expectedIds.includes(item.id)) failures.push({id:item.id,reason:'human_expectation_missing'});
    if (item.error || item.output?._ai_provider !== 'bedrock') failures.push({id:item.id,reason:'real_provider_not_verified'});
    assert.equal(item.clinicalWrites, false);
    assert.equal(item.sends, false);
  }
  return {cases:report.results.length, checkedClinicalExpectations:expectedIds.length,
    checkedPendingResponseExpectations:NEEDS_RESPONSE.length, failures, conservative,
    reviewPolicy:'one_inference_accept_review_without_clinical_state_change',
    allCurrentConversationsClaim:false, cutoff:report.cutoff};
}

module.exports = { check };
if (require.main === module) {
  const report = JSON.parse(fs.readFileSync(process.argv[2]));
  const result = check(report);
  const reviewIndex = process.argv.indexOf('--review-report');
  if (reviewIndex >= 0) {
    const cases = report.results.filter((item) => !item.error
      && !(item.planned || []).some((action) => action.state)
      && (item.output?.necesita_respuesta ?? item.output?.requiere_respuesta) === true)
      .map((item) => ({logId:item.id,clinic:item.clinic,patient:item.patient,automation:item.automation,
        reason:item.output.motivo,route:item.route,
        conservativeForClearDecision:result.conservative.includes(item.id)}));
    fs.writeFileSync(process.argv[reviewIndex + 1], JSON.stringify({
      simulated:true,clinicalWrites:false,sends:false,cutoff:report.cutoff,cases,
      limitation:'Predicted review cases only; current production review status has not been asserted.',
    },null,2), {mode:0o600,flag:'wx'});
    result.simulatedReviewCases = cases.length;
  }
  console.log(JSON.stringify(result));
  if (result.failures.length) process.exitCode = 1;
}
