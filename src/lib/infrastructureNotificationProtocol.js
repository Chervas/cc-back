'use strict';

const { createHash } = require('node:crypto');
const S = require('../../services/infrastructure-alert-collector/src/scope');
const DB_ID = 'clinicaclick-mysql';
const DBI = 'db-2YF2E5HFTNWAHYB45MS4QW7VUA';
const HOST = 'clinicaclick-mysql.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com';
const RDS_ARN = `arn:aws:rds:${S.REGION}:${S.ACCOUNT}:db:${DB_ID}`;
const PREFIX = `arn:aws:cloudwatch:${S.REGION}:${S.ACCOUNT}:alarm:clinicaclick-mysql-staging-`;
const ALARMS = Object.freeze({
 [`${PREFIX}cpu-high`]: { metric: 'CPUUtilization', label: 'CPU de RDS alta', severity: 'warning' },
 [`${PREFIX}storage-low`]: { metric: 'FreeStorageSpace', label: 'Espacio libre de RDS bajo', severity: 'critical' },
 [`${PREFIX}memory-low`]: { metric: 'FreeableMemory', label: 'Memoria disponible de RDS baja', severity: 'critical' },
 [`${PREFIX}connections-high`]: { metric: 'DatabaseConnections', label: 'Conexiones de RDS altas', severity: 'warning' },
});
// Categories are AWS's event-ID categories; severity is this application's
// operational policy. Backup/configuration/unknown valid events are receipted,
// but do not generate an email for every routine backup or configuration tick.
const RDS_EVENTS = Object.freeze(Object.fromEntries([
 ['availability','warning',['0004']],['availability','info',['0006']],['availability','critical',['0022','0221']],
 ['failover','warning',['0013','0034','0050']],['failover','info',['0015','0049','0051','0065']],
 ['failure','critical',['0031','0035','0036','0223','0254','0306','0418']],['failure','info',['0420']],
 ['failure','warning',['0079','0080']],['low storage','critical',['0007']],['low storage','warning',['0089']],
 ['recovery','warning',['0020','0052','0053','0361']],['recovery','info',['0021','0362']],
 ['maintenance','warning',['0026','0178','0501','0502']],['maintenance','info',['0027','0047','0596']],
 ['maintenance','critical',['0270']],['notification','critical',['0403']],
].flatMap(([category,severity,ids]) => ids.map(id => ['RDS-EVENT-' + id,{category,severity}]))));
const ACKABLE = new Set(['QUEUED', 'STALE', 'NO_CHANGE', 'NO_CHANNELS', 'IGNORED', 'TESTED']);
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const need = (ok, code) => { if (!ok) fail(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function runtimeEnabled(env = process.env) {
 return env.INFRASTRUCTURE_NOTIFICATIONS_ENABLED === 'true'
  && (env.JOB_RUNTIME_NAMESPACE || env.RUNTIME_NAMESPACE) === 'staging'
  && env.RUNTIME_ROLE !== 'gateway' && !env.DEV_SECURITY_PROFILE;
}
function selectedStartupJobs(notificationCron, env = process.env) {
 return [...(notificationCron ? ['systemNotificationCheck'] : []), ...(runtimeEnabled(env) ? ['infrastructureNotifications'] : [])];
}
function parseEnvelope(raw, now = Date.now()) {
 need(typeof raw === 'string' && Buffer.byteLength(raw) <= 65536, 'infrastructure_envelope_invalid');
 let sns, alarm;try { sns = JSON.parse(raw);alarm = JSON.parse(sns.Message); } catch { fail('infrastructure_envelope_invalid'); }
 need(sns?.Type === 'Notification' && sns.TopicArn === S.TOPIC_ARN && uuid(sns.MessageId)
  && typeof sns.Message === 'string' && Number.isFinite(Date.parse(sns.Timestamp)), 'infrastructure_sns_scope');
 if (Object.hasOwn(alarm || {}, 'Event Source')) return parseRdsEvent(sns, alarm, now);
 const definition = Object.hasOwn(ALARMS, alarm?.AlarmArn) ? ALARMS[alarm.AlarmArn] : null;
 need(definition && alarm.AWSAccountId === S.ACCOUNT && alarm.AlarmName === alarm.AlarmArn.slice(alarm.AlarmArn.indexOf(':alarm:') + 7)
  && ['EU (Paris)', S.REGION].includes(alarm.Region) && ['ALARM', 'OK', 'INSUFFICIENT_DATA'].includes(alarm.NewStateValue), 'infrastructure_alarm_scope');
 const trigger = alarm.Trigger;
 need(trigger?.Namespace === 'AWS/RDS' && trigger.MetricName === definition.metric && Array.isArray(trigger.Dimensions)
  && trigger.Dimensions.length === 1 && trigger.Dimensions[0].name === 'DBInstanceIdentifier'
  && trigger.Dimensions[0].value === DB_ID, 'infrastructure_metric_scope');
 const changedAt = Date.parse(alarm.StateChangeTime), publishedAt = Date.parse(sns.Timestamp);
 need(Number.isFinite(changedAt) && changedAt >= Date.UTC(2000, 0, 1) && changedAt <= now + 300000
  && publishedAt >= changedAt - 300000 && publishedAt <= now + 300000, 'infrastructure_event_clock');
 let testNonce = null;
 if (typeof alarm.NewStateReason === 'string' && alarm.NewStateReason.startsWith('CC_DELIVERY_TEST:')) {
  const match = /^CC_DELIVERY_TEST:([a-f0-9-]{36})$/.exec(alarm.NewStateReason);
  need(match && uuid(match[1]) && alarm.NewStateValue === 'ALARM', 'infrastructure_delivery_test_invalid');testNonce = match[1];
 }
 return { kind: 'CLOUDWATCH_ALARM', receiptKey: hash(S.TOPIC_ARN + '\n' + sns.MessageId.toLowerCase()), topicArn: S.TOPIC_ARN,
  messageId: sns.MessageId.toLowerCase(), payloadSha256: hash(sns.Message), alarmArn: alarm.AlarmArn,
  resourceArn: alarm.AlarmArn,
  alarmKey: hash(alarm.AlarmArn), newState: alarm.NewStateValue, changedAt, testNonce, definition };
}
function parseRdsEvent(sns, value, now) {
 need(value['Event Source'] === 'db-instance' && value['Source ID'] === DB_ID && !Object.hasOwn(value, 'AlarmArn')
  && (value['Source ARN'] === undefined || value['Source ARN'] === RDS_ARN), 'infrastructure_rds_event_scope');
 let eventId = value['Event ID'];
 if (typeof eventId === 'string' && !/^RDS-EVENT-\d{4}$/.test(eventId)) {
  let url;try { url = new URL(eventId); } catch { fail('infrastructure_rds_event_id'); }
  need(['http:','https:'].includes(url.protocol) && ['docs.aws.amazon.com','docs.amazonwebservices.com'].includes(url.hostname)
   && !url.username && !url.password && !url.port && !url.search
   && /^\/AmazonRDS\/latest\/UserGuide\/USER_Events(?:\.Messages)?\.html$/.test(url.pathname), 'infrastructure_rds_event_id');
  eventId = url.hash.slice(1);
 }
 need(typeof eventId === 'string' && /^RDS-EVENT-\d{4}$/.test(eventId), 'infrastructure_rds_event_id');
 const attributes = sns.MessageAttributes;
 if (attributes?.Resource) need(attributes.Resource.Type === 'String' && attributes.Resource.Value === RDS_ARN, 'infrastructure_rds_event_attributes');
 if (attributes?.EventID) need(attributes.EventID.Type === 'String' && attributes.EventID.Value === eventId, 'infrastructure_rds_event_attributes');
 const time = value['Event Time'];
 const match = typeof time === 'string' && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(?:Z| UTC)?$/.exec(time);
 need(match, 'infrastructure_rds_event_time');
 const iso = match[1] + 'T' + match[2] + '.' + (match[3] || '').padEnd(3, '0') + 'Z';
 const changedAt = Date.parse(iso), publishedAt = Date.parse(sns.Timestamp);
 need(Number.isFinite(changedAt) && new Date(changedAt).toISOString() === iso && changedAt >= Date.UTC(2000,0,1)
  && changedAt <= now + 300000 && publishedAt >= changedAt - 300000 && publishedAt <= now + 300000, 'infrastructure_rds_event_time');
 return { kind: 'RDS_EVENT', receiptKey: hash(S.TOPIC_ARN + '\n' + sns.MessageId.toLowerCase()), topicArn: S.TOPIC_ARN,
  messageId: sns.MessageId.toLowerCase(), payloadSha256: hash(sns.Message), resourceArn: RDS_ARN,
  changedAt, testNonce: null, eventId, definition: Object.hasOwn(RDS_EVENTS,eventId) ? RDS_EVENTS[eventId] : null };
}
function authorizeTest(event, configuration, now) {
 need(event.testNonce, 'infrastructure_delivery_test_invalid');
 const approved = configuration.deliveryTests?.find(test => test.nonce === event.testNonce && test.alarmArn === event.alarmArn);
 need(approved && Number.isSafeInteger(approved.approvedAtEpochMs) && Number.isSafeInteger(approved.expiresAtEpochMs)
  && approved.approvedAtEpochMs <= event.changedAt && event.changedAt <= approved.expiresAtEpochMs
  && approved.approvedAtEpochMs <= now && now < approved.expiresAtEpochMs
  && approved.expiresAtEpochMs - approved.approvedAtEpochMs <= 900000, 'infrastructure_delivery_test_not_authorized');
}
function transition(previous, event) {
 if (!previous || previous.state === 'UNOBSERVED') return { outcome: event.newState === 'OK' ? 'NO_CHANGE' : 'QUEUED', notify: event.newState !== 'OK' };
 const oldTime = new Date(previous.state_changed_at).getTime();need(Number.isFinite(oldTime), 'infrastructure_state_clock_invalid');
 if (event.changedAt < oldTime) return { outcome: 'STALE', notify: false, preserve: true };
 if (event.changedAt === oldTime && event.newState !== previous.state) fail('infrastructure_same_time_conflict');
 if (event.newState === previous.state) return { outcome: 'NO_CHANGE', notify: false };
 return { outcome: 'QUEUED', notify: true };
}
function notification(event) {
 if (event.kind === 'RDS_EVENT') {
  need(event.definition, 'infrastructure_rds_event_not_notifiable');
  return { eventKey: 'infrastructure.rds_event', allowedChannels: ['panel','email'], force: false,
   payload: { title: 'RDS: evento operativo', message: `Evento ${event.eventId} de ${DB_ID}; categoría ${event.definition.category}.`,
    severity: event.definition.severity, occurredAt: new Date(event.changedAt).toISOString(), action: 'Revisar Ajustes → Monitoreo del sistema → AWS y el estado actual de RDS.' },
   metadata: { source: 'infrastructure_notifications', receipt_key: event.receiptKey, source_message_id: event.messageId,
    physical_database_id: DBI, database_identifier: DB_ID, source_arn: RDS_ARN, rds_event_id: event.eventId,
    rds_event_category: event.definition.category, link: '/ajustes?panel=jobs-monitoring&tab=aws' } };
 }
 const test = Boolean(event.testNonce), recovered = event.newState === 'OK';
 return { eventKey: test ? 'system.notification_test' : recovered ? 'infrastructure.rds_recovered' : 'infrastructure.rds_alarm',
  payload: { title: test ? 'Prueba autorizada de avisos de RDS' : recovered ? 'RDS: condición recuperada' : event.definition.label,
   message: test ? 'Se ha verificado el recorrido CloudWatch → SNS → SQS → notificación email.'
    : `${event.definition.label}. Estado observado: ${event.newState}. Base de datos: ${DB_ID}.`,
   severity: test || recovered ? 'info' : event.newState === 'INSUFFICIENT_DATA' ? 'warning' : event.definition.severity, occurredAt: new Date(event.changedAt).toISOString(),
   action: 'Revisar Ajustes → Monitoreo del sistema → AWS. Este aviso no modifica la infraestructura.' },
  ...(test ? { channelsOverride: { email: true, panel: false, whatsapp: false } } : {}),
  allowedChannels: test ? ['email'] : ['panel', 'email'], force: test,
  metadata: { source: 'infrastructure_notifications', receipt_key: event.receiptKey, alarm_arn: event.alarmArn,
   source_message_id: event.messageId, physical_database_id: DBI, database_identifier: DB_ID,
   ...(test ? { delivery_test_nonce: event.testNonce } : {}), link: '/ajustes?panel=jobs-monitoring&tab=aws' } };
}
module.exports = { ...S, DB_ID, DBI, HOST, RDS_ARN, ALARMS, RDS_EVENTS, ACKABLE, hash, need, fail, uuid,
 runtimeEnabled, selectedStartupJobs, parseEnvelope, parseRdsEvent, authorizeTest, transition, notification };
