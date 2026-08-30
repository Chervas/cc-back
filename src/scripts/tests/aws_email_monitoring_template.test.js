'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../../infrastructure/aws/email-monitoring.cloudformation.json',
);

function loadTemplate() {
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
}

function resourcesByType(template, type) {
  return Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === type);
}

function metricKey(resource) {
  return `${resource.Properties.Namespace}/${resource.Properties.MetricName}`;
}

function collectResourceReferences(value, resourceNames, references = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectResourceReferences(item, resourceNames, references));
    return references;
  }
  if (!value || typeof value !== 'object') return references;

  if (typeof value.Ref === 'string' && resourceNames.has(value.Ref)) {
    references.add(value.Ref);
  }
  if (Array.isArray(value['Fn::GetAtt']) && resourceNames.has(value['Fn::GetAtt'][0])) {
    references.add(value['Fn::GetAtt'][0]);
  }
  if (typeof value['Fn::Sub'] === 'string') {
    for (const match of value['Fn::Sub'].matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]*)?}/g)) {
      if (resourceNames.has(match[1])) references.add(match[1]);
    }
  }
  Object.values(value).forEach((item) => (
    collectResourceReferences(item, resourceNames, references)
  ));
  return references;
}

function assertAcyclicResources(template) {
  const names = new Set(Object.keys(template.Resources));
  const graph = new Map();
  for (const [name, resource] of Object.entries(template.Resources)) {
    const dependencies = collectResourceReferences(resource.Properties, names);
    const explicit = Array.isArray(resource.DependsOn)
      ? resource.DependsOn
      : [resource.DependsOn].filter(Boolean);
    explicit.forEach((dependency) => dependencies.add(dependency));
    graph.set(name, dependencies);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name, trail) {
    if (visiting.has(name)) {
      assert.fail(`Dependencia circular: ${[...trail, name].join(' -> ')}`);
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) || []) visit(dependency, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name, []);
}

function isIntrinsic(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).some((key) => key === 'Ref' || key.startsWith('Fn::')),
  );
}

function propertyTypeDefinition(specification, resourceType, typeName) {
  if (typeName === 'Tag') {
    return { Properties: { Key: {}, Value: {} } };
  }
  return specification.PropertyTypes[`${resourceType}.${typeName}`]
    || specification.PropertyTypes[typeName]
    || null;
}

function validateSchemaValue({
  value,
  property,
  resourceType,
  specification,
  location,
}) {
  if (isIntrinsic(value)) return;
  if (property.Type === 'List') {
    assert.ok(Array.isArray(value), `${location}: se esperaba una lista`);
    if (!property.ItemType) return;
    const itemDefinition = propertyTypeDefinition(
      specification,
      resourceType,
      property.ItemType,
    );
    if (!itemDefinition) return;
    value.forEach((item, index) => validateSchemaObject({
      value: item,
      definition: itemDefinition,
      resourceType,
      specification,
      location: `${location}[${index}]`,
    }));
    return;
  }
  if (property.Type === 'Map') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), (
      `${location}: se esperaba un mapa`
    ));
    return;
  }
  if (property.Type) {
    const definition = propertyTypeDefinition(specification, resourceType, property.Type);
    if (definition) {
      validateSchemaObject({
        value,
        definition,
        resourceType,
        specification,
        location,
      });
    }
  }
}

function validateSchemaObject({
  value,
  definition,
  resourceType,
  specification,
  location,
}) {
  if (isIntrinsic(value)) return;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), (
    `${location}: se esperaba un objeto`
  ));
  const properties = definition.Properties || {};
  for (const [name, nestedValue] of Object.entries(value)) {
    const property = properties[name];
    assert.ok(property, `${location}: propiedad desconocida ${name}`);
    validateSchemaValue({
      value: nestedValue,
      property,
      resourceType,
      specification,
      location: `${location}.${name}`,
    });
  }
}

test('el stack solo crea monitorizacion y no muta el transporte SES existente', () => {
  const template = loadTemplate();
  const allowedTypes = new Set([
    'AWS::CloudWatch::Alarm',
    'AWS::Events::Rule',
    'AWS::IAM::Role',
    'AWS::Lambda::Function',
    'AWS::Lambda::Permission',
    'AWS::Logs::LogGroup',
    'AWS::SNS::Subscription',
    'AWS::SNS::Topic',
  ]);

  for (const resource of Object.values(template.Resources)) {
    assert.ok(allowedTypes.has(resource.Type), `Tipo no permitido: ${resource.Type}`);
  }

  const serialized = JSON.stringify(template);
  assert.doesNotMatch(serialized, /AWS::SES::|AWS::SQS::Queue|AWS::Events::ApiDestination/);
  assert.doesNotMatch(serialized, /ses:(Send|SendEmail|SendRawEmail)/i);
  assert.doesNotMatch(serialized, /AKIA[0-9A-Z]{16}/);
  assert.doesNotMatch(serialized, /carlos\.hervas@|617560236/i);
  assertAcyclicResources(template);
});

test('las alarmas cubren EventBridge, DLQ, reputacion, rechazos y cuota real', () => {
  const template = loadTemplate();
  const alarms = resourcesByType(template, 'AWS::CloudWatch::Alarm');
  assert.equal(alarms.length, 13);

  const metrics = new Set(alarms.map(([, alarm]) => metricKey(alarm)));
  for (const expected of [
    'AWS/Events/FailedInvocations',
    'AWS/Events/InvocationsSentToDlq',
    'AWS/Events/InvocationsFailedToBeSentToDlq',
    'AWS/Events/ThrottledRules',
    'AWS/SQS/ApproximateNumberOfMessagesVisible',
    'AWS/SQS/ApproximateAgeOfOldestMessage',
    'AWS/SES/Reputation.BounceRate',
    'AWS/SES/Reputation.ComplaintRate',
    'AWS/SES/Reject',
    'Clinicaclick/EmailOps/DailyQuotaUsagePercent',
    'Clinicaclick/EmailOps/CollectorHeartbeat',
    'AWS/Lambda/Errors',
  ]) {
    assert.ok(metrics.has(expected), `Falta metrica ${expected}`);
  }

  const names = alarms.map(([, alarm]) => alarm.Properties.AlarmName);
  assert.equal(new Set(names).size, names.length);
  for (const [, alarm] of alarms) {
    assert.deepEqual(alarm.Properties.AlarmActions, [{ Ref: 'EmailOpsAlertsTopic' }]);
    assert.deepEqual(alarm.Properties.OKActions, [{ Ref: 'EmailOpsAlertsTopic' }]);
    assert.equal(alarm.Properties.InsufficientDataActions, undefined);
  }
});

test('umbrales y dimensiones usan los recursos operativos acordados', () => {
  const template = loadTemplate();
  const resources = template.Resources;

  for (const key of [
    'EventBridgeFailedInvocationsAlarm',
    'EventBridgeInvocationsSentToDlqAlarm',
    'EventBridgeInvocationsFailedToBeSentToDlqAlarm',
    'EventBridgeThrottledRulesAlarm',
  ]) {
    assert.deepEqual(resources[key].Properties.Dimensions, [
      { Name: 'RuleName', Value: 'clinicaclick-ses-to-gateway' },
    ]);
    assert.equal(resources[key].Properties.TreatMissingData, 'notBreaching');
  }

  assert.deepEqual(resources.DlqVisibleMessagesAlarm.Properties.Dimensions, [
    { Name: 'QueueName', Value: 'clinicaclick-ses-events-dlq' },
  ]);
  assert.equal(resources.DlqVisibleMessagesAlarm.Properties.EvaluationPeriods, 2);
  assert.equal(resources.DlqVisibleMessagesAlarm.Properties.DatapointsToAlarm, 2);
  assert.equal(resources.SesBounceRateWarningAlarm.Properties.Threshold, 0.02);
  assert.equal(resources.SesBounceRateCriticalAlarm.Properties.Threshold, 0.05);
  assert.equal(resources.SesComplaintRateCriticalAlarm.Properties.Threshold, 0.001);
  assert.equal(resources.SesDailyQuotaUsageAlarm.Properties.Threshold, 80);
});

test('el colector de cuota es minimo, sin envio ni datos de destinatarios', () => {
  const template = loadTemplate();
  const role = template.Resources.SesQuotaCollectorRole;
  const statements = role.Properties.Policies[0].PolicyDocument.Statement;
  const actions = statements.flatMap((statement) => (
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  ));

  assert.deepEqual(new Set(actions), new Set([
    'ses:GetSendQuota',
    'cloudwatch:PutMetricData',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]));
  assert.ok(!actions.some((action) => /sendemail|sendrawemail/i.test(action)));
  assert.equal(
    template.Resources.SesQuotaCollectorSchedule.Properties.ScheduleExpression,
    'rate(5 minutes)',
  );
  assert.equal(
    template.Resources.SesQuotaCollector.Properties.FunctionName,
    'clinicaclick-email-quota-collector',
  );
  assert.equal(
    template.Resources.SesQuotaCollectorLogGroup.Properties.LogGroupName,
    '/aws/lambda/clinicaclick-email-quota-collector',
  );

  const code = template.Resources.SesQuotaCollector.Properties.Code.ZipFile;
  assert.match(code, /get_send_quota/);
  assert.match(code, /DailyQuotaUsagePercent/);
  assert.match(code, /CollectorHeartbeat/);
  assert.equal((code.match(/'MetricName':/g) || []).length, 2);
  assert.doesNotMatch(code, /'MetricName': '(SentLast24Hours|Max24HourSend|MaxSendRate)'/);
  assert.doesNotMatch(code, /recipient|destination|message|address/i);
});

test('la suscripcion externa es parametrica y requiere confirmacion SNS', () => {
  const template = loadTemplate();
  const parameter = template.Parameters.NotificationEmail;
  const subscription = template.Resources.EmailOpsEmailSubscription;

  assert.equal(parameter.Default, '');
  assert.equal(subscription.Condition, 'HasNotificationEmail');
  assert.equal(subscription.Properties.Protocol, 'email');
  assert.deepEqual(subscription.Properties.Endpoint, { Ref: 'NotificationEmail' });
});

test('las propiedades existen en la especificacion oficial CloudFormation', {
  skip: !process.env.CFN_RESOURCE_SPEC_PATH,
}, () => {
  const template = loadTemplate();
  const specification = JSON.parse(fs.readFileSync(
    process.env.CFN_RESOURCE_SPEC_PATH,
    'utf8',
  ));

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const definition = specification.ResourceTypes[resource.Type];
    assert.ok(definition, `${logicalId}: tipo desconocido ${resource.Type}`);
    validateSchemaObject({
      value: resource.Properties || {},
      definition,
      resourceType: resource.Type,
      specification,
      location: logicalId,
    });
  }
});
