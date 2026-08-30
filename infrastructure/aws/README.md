# AWS email monitoring

This directory contains the external monitoring stack for Clinicaclick email.
It is intentionally separate from the SES sending credential and from the
application deployment.

## Scope

`email-monitoring.cloudformation.json` creates:

- one SNS topic and an optional email subscription;
- four alarms for the existing EventBridge rule
  `clinicaclick-ses-to-gateway`;
- two alarms for the existing SQS DLQ `clinicaclick-ses-events-dlq`;
- SES account reputation and rejection alarms;
- a five-minute Lambda that calls only `ses:GetSendQuota` and publishes
  rolling 24-hour quota metrics without message or recipient data;
- alarms for 80% quota usage, collector heartbeat and collector errors.

It does not create or modify SES identities, configuration sets, API
destinations, the existing EventBridge delivery rule, the existing SQS queue,
DNS records or the IAM sender `clinicaclick-ses-sender`.

## Local contract test

Run from `/home/ubuntu/wt/back-dev`:

```bash
node src/scripts/tests/aws_email_monitoring_template.test.js
```

This verifies resource allowlisting, metrics, thresholds, dependencies, least
privilege and absence of embedded contacts or credentials. It does not replace
AWS `validate-template`.

An optional schema pass can compare every resource/property with the current
official CloudFormation resource specification:

```bash
curl --compressed -fsSL \
  'https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json' \
  -o /tmp/clinicaclick-cloudformation-resource-specification.json
CFN_RESOURCE_SPEC_PATH=/tmp/clinicaclick-cloudformation-resource-specification.json \
  node src/scripts/tests/aws_email_monitoring_template.test.js
```

The 2026-08-30 audit passed all six checks against specification `263.0.0` and
also compiled the embedded Python. AWS `validate-template` remains mandatory
because local schema validation cannot verify account or regional state.

## Deployment

Use an existing IAM Identity Center session or a temporary assumed role in the
same AWS account as SES. Do not create a new IAM console user or long-lived
access key just for this deployment, and never add these permissions to
`clinicaclick-ses-sender`.

If operations require a dedicated CloudFormation service role, use
`clinicaclick-ops-alerts` trusted only by `cloudformation.amazonaws.com`, grant
the human/operator identity only CloudFormation stack operations plus
`iam:PassRole` for that exact role, and scope the service role to this stack.
It must cover CloudWatch alarms, SNS, the quota collector Lambda, its EventBridge
schedule, log group and Lambda execution role. A role restricted only to
CloudWatch/SNS cannot deploy this template. Review this carefully because a
CloudFormation service role remains attached to a stack after creation.

```bash
export AWS_REGION=eu-west-3
export STACK_NAME=clinicaclick-email-monitoring
export ALERT_EMAIL='<external-operational-email>'

aws sts get-caller-identity
aws events describe-rule \
  --region "$AWS_REGION" \
  --name clinicaclick-ses-to-gateway
aws sqs get-queue-url \
  --region "$AWS_REGION" \
  --queue-name clinicaclick-ses-events-dlq

aws cloudformation validate-template \
  --region "$AWS_REGION" \
  --template-body file://infrastructure/aws/email-monitoring.cloudformation.json

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infrastructure/aws/email-monitoring.cloudformation.json \
  --parameter-overrides \
    NotificationEmail="$ALERT_EMAIL" \
    DlqAgeThresholdSeconds=900 \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset
```

For a first deployment with `NotificationEmail` set, the reviewed change set
must contain 20 additions: 13 alarms plus SNS topic/subscription, Lambda,
Lambda role/permission, log group and schedule rule. It must not contain a
modification or deletion of an existing resource. The existing delivery rule
and DLQ appear only as metric dimension strings.

When an approved CloudFormation service role is used, pass it with
`--role-arn arn:aws:iam::<account-id>:role/clinicaclick-ops-alerts` (or select it
under stack options in the console). Do not proceed if the role's change-set
review shows broader resources.

The recipient must confirm the SNS subscription email. Until its
`SubscriptionArn` is no longer `PendingConfirmation`, alarm delivery is not
operational.

### Deployment record: 2026-08-30

An external AWS operator reported the first deployment in `eu-west-3` as
`CREATE_COMPLETE`:

- stack ID:
  `arn:aws:cloudformation:eu-west-3:137819318729:stack/clinicaclick-email-monitoring/fe74e220-a483-11f1-9794-067105d4136d`;
- reviewed change set: 20 additions, 0 modifications and 0 deletions;
- capability: `CAPABILITY_IAM`;
- 13 alarms, each with ALARM and OK actions on
  `clinicaclick-email-ops-alerts`;
- sanitized topic ARN:
  `arn:aws:sns:eu-west-3:********8729:clinicaclick-email-ops-alerts`;
- no IAM console user or key was created and no existing SES, DNS, Cloudflare,
  EventBridge delivery rule, DLQ or sender IAM resource was modified.

The email subscription for `carlos.hervas@modmarketing.net` was confirmed. A
controlled alarm transitioned to `ALARM` at 15:26:48 UTC and back to `OK` at
15:26:49 UTC; both notifications were received and SNS reported two deliveries
and zero failures. At 15:26 UTC, `DailyQuotaUsagePercent=0.018`,
`CollectorHeartbeat=1`, the quota collector returned HTTP 200 with
`published=true`, Lambda had no errors and all 13 alarms were `OK`, with both
ALARM and OK actions configured. This validation sent no email through SES and
did not modify SES, DNS, Cloudflare, EventBridge, the DLQ or IAM.

## Verification

```bash
TOPIC_ARN="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertsTopicArn`].OutputValue' \
  --output text)"

aws sns list-subscriptions-by-topic \
  --region "$AWS_REGION" \
  --topic-arn "$TOPIC_ARN"

aws lambda invoke \
  --region "$AWS_REGION" \
  --function-name clinicaclick-email-quota-collector \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/clinicaclick-email-quota-result.json

aws cloudwatch describe-alarms \
  --region "$AWS_REGION" \
  --alarm-name-prefix clinicaclick-email-
```

Perform one controlled notification test without sending an email through SES:

```bash
aws cloudwatch set-alarm-state \
  --region "$AWS_REGION" \
  --alarm-name clinicaclick-email-warning-ses-rejects \
  --state-value ALARM \
  --state-reason 'Controlled Clinicaclick notification test'

aws cloudwatch set-alarm-state \
  --region "$AWS_REGION" \
  --alarm-name clinicaclick-email-warning-ses-rejects \
  --state-value OK \
  --state-reason 'Controlled Clinicaclick recovery test'
```

Record the stack ID, topic ARN, confirmed channel, alarm count, collector
invocation result and receipt of both ALARM and OK notifications. Do not record
credentials, full event payloads or recipient data.

## Rollback

```bash
aws cloudformation delete-stack \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"
aws cloudformation wait stack-delete-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"
```

Deleting this stack removes only its SNS topic, subscription, alarms, quota
collector, schedule, role and logs. It does not delete the existing SES,
EventBridge delivery or SQS DLQ resources.
