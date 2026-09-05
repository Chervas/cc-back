'use strict';

const assert = require('node:assert/strict');
const flowEngine = require('../../services/flowEngineV2.service');
const automationsController = require('../../controllers/automationsV2.controller');

function rule(id, connector, path, valueType, operator, rightValue) {
  return {
    id,
    connector,
    left_ref: {
      source: 'node_output',
      node_id: 'N3',
      path,
      value_type: valueType,
      label: path,
    },
    operator,
    right_value: rightValue,
  };
}

function node(config) {
  const multiBranch = config.mode === 'multi_branch';
  return {
    id: 'N10',
    type: 'condition/field_check',
    config: { mode: 'simple', ...config },
    outputs: multiBranch
      ? {
          branch_1: 'CONFIRM',
          branch_2: 'CANCEL',
          branch_3: 'QUESTION',
          on_else: 'NO_MATCH',
        }
      : { on_true: 'MATCH', on_false: 'NO_MATCH' },
  };
}

async function evaluate(config, output) {
  return flowEngine._processNode(
    node(config),
    { outputs: { N3: output } },
    { simulation: true },
  );
}

async function main() {
  const legacy = await evaluate({
    left_ref: {
      source: 'node_output',
      node_id: 'N3',
      path: 'confirmed',
      value_type: 'boolean',
    },
    operator: 'equals',
    right_value: true,
  }, { confirmed: true });
  assert.equal(legacy.next_node_id, 'MATCH');
  assert.equal(legacy.output.decision, true);

  const config = {
    comparison_rules: [
      rule('rule_1', null, 'intent', 'string', 'equals', 'confirmar_cita'),
      rule('rule_2', 'and', 'needs_reply', 'boolean', 'equals', false),
      rule('rule_3', 'or', 'urgent', 'boolean', 'equals', true),
    ],
  };

  const allAnd = await evaluate(config, {
    intent: 'confirmar_cita',
    needs_reply: false,
    urgent: false,
  });
  assert.equal(allAnd.next_node_id, 'MATCH');
  assert.equal(allAnd.output.decision, true);
  assert.equal(allAnd.output.group_count, 2);
  assert.deepEqual(
    allAnd.output.rule_results.map(({ id, connector, matched }) => ({ id, connector, matched })),
    [
      { id: 'rule_1', connector: null, matched: true },
      { id: 'rule_2', connector: 'and', matched: true },
      { id: 'rule_3', connector: 'or', matched: false },
    ],
  );

  const orMatch = await evaluate(config, {
    intent: 'pregunta',
    needs_reply: true,
    urgent: true,
  });
  assert.equal(orMatch.next_node_id, 'MATCH');
  assert.equal(orMatch.output.decision, true);

  const noMatch = await evaluate(config, {
    intent: 'confirmar_cita',
    needs_reply: true,
    urgent: false,
  });
  assert.equal(noMatch.next_node_id, 'NO_MATCH');
  assert.equal(noMatch.output.decision, false);

  assert.equal(
    JSON.stringify(noMatch.output).includes('confirmar_cita'),
    false,
    'audit output must not repeat compared clinical/message values',
  );

  const branchConfig = {
    mode: 'multi_branch',
    branch_rules: [
      {
        id: 'branch_1',
        label: 'Confirmar con confianza',
        comparison_rules: [
          rule('rule_1', null, 'intent', 'string', 'equals', 'confirmar_cita'),
          rule('rule_2', 'and', 'confidence', 'number', 'greater_than', 0.85),
        ],
      },
      { id: 'branch_2', comparison_rules: [rule('rule_1', null, 'intent', 'string', 'equals', 'cancelar_cita')] },
      { id: 'branch_3', comparison_rules: [rule('rule_1', null, 'intent', 'string', 'equals', 'pregunta')] },
    ],
  };
  const branchMatch = await evaluate(branchConfig, { intent: 'cancelar_cita', confidence: 0.99 });
  assert.equal(branchMatch.next_node_id, 'CANCEL');
  assert.equal(branchMatch.output.matched_rule_id, 'branch_2');
  assert.deepEqual(branchMatch.output.rule_results, [
    {
      id: 'branch_1',
      matched: false,
      condition_results: [
        { id: 'rule_1', connector: null, matched: false },
        { id: 'rule_2', connector: 'and', matched: true },
      ],
    },
    { id: 'branch_2', matched: true, condition_results: [{ id: 'rule_1', connector: null, matched: true }] },
    { id: 'branch_3', matched: false, condition_results: [{ id: 'rule_1', connector: null, matched: false }] },
  ]);

  const branchConfidenceFallback = await evaluate(branchConfig, {
    intent: 'confirmar_cita',
    confidence: 0.7,
  });
  assert.equal(branchConfidenceFallback.next_node_id, 'NO_MATCH');

  const firstBranchWins = await evaluate({
    mode: 'multi_branch',
    branch_rules: [
      { id: 'branch_1', comparison_rules: [rule('rule_1', null, 'intent', 'string', 'exists', '')] },
      { id: 'branch_2', comparison_rules: [rule('rule_1', null, 'intent', 'string', 'equals', 'cancelar_cita')] },
    ],
  }, { intent: 'cancelar_cita' });
  assert.equal(firstBranchWins.next_node_id, 'CONFIRM');
  assert.equal(firstBranchWins.output.matched_rule_id, 'branch_1');

  const branchFallback = await evaluate(branchConfig, { intent: 'otra' });
  assert.equal(branchFallback.next_node_id, 'NO_MATCH');
  assert.equal(branchFallback.output.matched_rule_id, null);
  assert.equal(
    JSON.stringify(branchFallback.output).includes('otra'),
    false,
    'multi-branch audit output must not repeat compared clinical/message values',
  );

  const validationRules = [
    rule('branch_1', null, 'intent', 'string', 'equals', 'confirmar_cita'),
    rule('branch_2', null, 'intent', 'string', 'equals', 'cancelar_cita'),
    rule('branch_3', null, 'intent', 'string', 'equals', 'pregunta'),
  ].map((item) => ({
    id: item.id,
    comparison_rules: [{
      ...item,
      id: 'rule_1',
      left_ref: {
        ...item.left_ref,
        source: 'trigger_data',
        node_id: null,
      },
    }],
  }));
  const validationNodes = [
    {
      id: 'N1',
      type: 'trigger/message_received',
      config: {
        channel_scope: 'all_connected',
        channels: [],
        timing: 'clinic_closed',
        only_unclaimed: true,
        response_buffer_seconds: 90,
        runtime_fallback_enabled: false,
      },
      outputs: { on_success: 'N2' },
    },
    {
      id: 'N2',
      type: 'condition/field_check',
      config: { mode: 'multi_branch', branch_rules: validationRules },
      outputs: {
        branch_1: 'N3',
        branch_2: 'N4',
        branch_3: 'N5',
        on_else: 'N6',
      },
    },
    ...['N3', 'N4', 'N5', 'N6'].map((id) => ({
      id,
      type: 'control/end',
      config: {},
      outputs: {},
    })),
  ];
  const validPayload = await automationsController.validateFlowPayloadForInternalUse({
    entry_node_id: 'N1',
    trigger_type: 'message_received',
    nodes: validationNodes,
  });
  assert.equal(validPayload.ok, true, JSON.stringify(validPayload.errors));

  const excessiveRules = Array.from({ length: 8 }, (_, index) => ({
    ...validationRules[0],
    id: `branch_${index + 1}`,
    comparison_rules: validationRules[0].comparison_rules.map((item) => ({
      ...item,
      right_value: `intent_${index + 1}`,
    })),
  }));
  const excessivePayload = await automationsController.validateFlowPayloadForInternalUse({
    entry_node_id: 'N1',
    trigger_type: 'message_received',
    nodes: validationNodes.map((item) => item.id === 'N2'
      ? {
          ...item,
          config: { mode: 'multi_branch', branch_rules: excessiveRules },
          outputs: {
            ...Object.fromEntries(excessiveRules.map((branch) => [branch.id, 'N3'])),
            on_else: 'N6',
          },
        }
      : item),
  });
  assert.equal(excessivePayload.ok, false);
  assert.equal(
    excessivePayload.errors.some((error) => error.details?.key === 'branch_rules' && error.details?.max === 7),
    true,
  );

  console.log('field_check compound contract: OK');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
