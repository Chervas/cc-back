# Durable appointment visit / communication foundation

This is an additive production API with the narrowly scoped, default-CLOSED
native birth/details consumer implemented below, **not a runtime rollout**. The migration
base creates three empty tables; the additive runtime migration below adds two
empty ledger tables and nullable contracts. Neither migration backfills identities, mutates appointments
or economics, publish events, enqueue jobs, change flags, activate automations or
send anything. Unenrolled/historical consumers still use appointment IDs. The
implemented consumer frontier and remaining adapters are recorded in the final
section; earlier audit/bridge sections retain their original pass scope.
Pure/fake tests do not prove SQL isolation or transport safety.

## Identity and invariants

- `AppointmentVisits.id` is an immutable UUID. `owner_appointment_id` retains the
  existing appointment trigger contract. A reservation has at most one member
  row (SQL primary key on appointment ID), regardless of its date/name/phone.
- `ensureSingletonVisit` locks an existing appointment and creates identity only.
  It does not infer a group. A singleton with any clinical-component metadata
  cannot claim communications until its relation has been validated and grouped.
- `linkValidatedPrpVisit` consumes the existing reciprocal PRP receipt, both
  current reservations, current treatment evidence and append-only audit through
  `appointment-clinical-components`. It never creates clinical links, modifies
  appointments, assumes administration/attendance or assigns prices. The parent
  reservation remains the compatibility trigger owner.
- A merge of empty singleton identities retains the parent identity, marks the
  old identity `merged` and moves only foundation membership. Any communication
  history in either identity **or legacy FlowExecutionV2 history on either
  appointment**, regardless of state, refuses merge with
  `appointment_visit_grouping_communication_history_requires_review`. No accepted
  or uncertain right, execution, wait, reply association or lock is reassigned.
  Resolving this requires an explicitly approved history/adoption ledger and
  reconciliation plan; ordinary retry or matching times/names is not permission.
- The communication revision changes only in an explicit, compare-and-set
  `refreshVisitSnapshot` or validated membership change. Its semantic projection
  includes scope, owner, member IDs/roles, grouping evidence, reserved start/end,
  doctor/room/treatment IDs, validated selected frozen booking steps and lifecycle
  (active, cancelled, no-show, completed,
  change-requested). `reprogramada` is active, consistent with current runtime.
  `updated_at`, template publication and ordinary info/confirmation states do
  not create revisions. A broken PRP receipt fails closed instead of being
  rewritten. No names, contact data, notes, prices or equipment-turnaround time
  enter this snapshot. Patient end is the latest reserved appointment end.
- Frozen steps come from the actual writer's `import_metadata.booking`
  (`appointmentBookingCommand.service.js`) and are validated through the real
  `bookingSegments` contract (v1–4). The projection retains selected step keys,
  order, start/end, room, staff IDs/attention intervals/policies, equipment IDs
  and preparation-sharing mode, plus validated full-visit additional staff IDs.
  Changing phase2's staff/room changes revision even when top-level fields do
  not. Names/labels/warnings/catalog alternative lists and equipment turnaround
  are not communication identity. Present invalid frozen steps fail closed;
  they never silently revert to primary IDs. This does **not** independently
  establish live resource capacity, treatment equivalence or clinical consent.
- SQL uniqueness is `(visit_id, purpose, communication_revision, window_sha256)`.
  Purpose is from the finite helper contract; booking and rescheduling details
  both map to `appointment_details`. A stable operational window **key** defines
  identity; changing its bounds produces `window_definition_changed`, not a new
  right. Do not derive purpose/window from template versions, random IDs or retry
  timestamps. Different channels do not create independent rights.
- New-table timestamps and operational window bounds use `DATE(3)` consistently
  in migration/models. SQL round-trip preserves ISO millisecond bounds; truncating
  them would break idempotent replay and policy-freshness comparisons.
- A claim replay returns the original row and original template audit binding.
  Message delivery key is `visit-communication:<communication UUID>` and fits
  the existing unique `Messages.automation_delivery_key` column. One Message is
  bound to at most one communication through a second SQL unique index.

## API and boundaries

`createAppointmentVisitCommunicationService({ db })` receives actual Sequelize
models explicitly, without app/worker bootstrap. Its public methods accept an
optional caller-owned `READ COMMITTED` transaction. Locks are appointment IDs
ascending, membership, visit UUIDs ascending, then communication. Supplied
transactions must roll back on errors; never catch and commit a partial operation.
No provider request belongs in these transactions.

Methods: `ensureSingletonVisit`, `linkValidatedPrpVisit`, `refreshVisitSnapshot`,
`claimCommunication`, `bindCommunication`, `assertCommunicationCurrent`,
`reconcileDelivery`, `cancelCommunication`, `inspectCommunicationCurrent`.

Claim verifies the exact current projection/revision/membership, purpose, window,
all-member QA/provisional/historical/HOLD/manual suppression. It reads the
existing protected `whatsappImportedAppointmentOperations` and
`whatsappImportedReminderRelease` server registries, preserving their clinic,
source, start, approval and exact-reservation/template restrictions. Only new
intents/windows after approval are eligible; same-day remains off for imported
release. Pure helper release decisions are resolver functions created by this
service, not client JSON booleans. Policy-reader injection is a trusted
composition/testing dependency, never a request field.

Binding/dispatch additionally checks a persisted, current owner execution with
the existing appointment trigger, current captured start and purpose. Imported
release requires its freshness under `permits`; every validated member must also
remain eligible under that same current policy. A registry revocation or schedule
change closes the gate. No global imported-patient or source waiver is stored.

Binding records only the already-existing execution/Message IDs. It never
creates, resumes, cancels, unlocks or resets those objects. It verifies exact
clinic/patient conversation, outbound direction, execution metadata, delivery
key and absence of synthetic context. Reconciliation derives delivery outcome
from the bound persisted Message: provider receipts/sent state are accepted;
uncertain delivery, response without proved acceptance and `sending` are unknown.
`accepted` never regresses. `unknown` only advances to accepted on a receipt from
the **same Message**. Cancellation preserves both, even after snapshot/HOLD/PRP
changes; no new Message or execution may replace their binding. Pre-dispatch
assertion refuses both without resetting receipts. Reconcile explicitly after
send/recovery, including outcomes accepted after a concurrent cancellation.

## Required integration and verification before activation

1. An opt-in real MySQL 8.0.42 integration now covers migration up/down/up,
   persisted model contracts, actual FK/unique constraints, millisecond windows,
   eight simultaneous singleton requests/eight claims, four PRP grouping requests,
   six released-import claims, canonical numeric lock order, two competing CAS
   refreshes, stale binding, membership rollback, later-step snapshot changes,
   protected policy/QA/HOLD, legacy wait preservation and accepted/unknown
   reconciliation. It uses the existing `withIsolatedCampaignMysql` fixture's
   owned Unix socket/mysqld with TCP/providers/queues denied. Latest successful
   report: `/tmp/cc-campaign-opt-mysql-PRWIii/result.json`; clean shutdown 0,
   zero rejected external connections/provider calls/real patients touched.
   It loads actual foundation and referenced appointment/flow/Message/audit models;
   only FK anchor records are reduced fixture scaffolding. The audit table uses
   its actual existing migration, avoiding its model's overly long implicit sync
   index name without changing that unrelated production model.
   Before rollout, still compare the deployment schema/types/collation and run
   integration with the final canonical booking/runtime lock adapters. This test
   does not prove unintegrated runtime/sender behavior or deadlock retry policy.
2. Wire native booking/rescheduling/cancellation and import identity creation in
   the same canonical transaction. Review existing legacy history before any
   bulk/group backfill. No automatic historical replay.
3. Wire appointment runtime/scheduler, flow execution ownership, stable outbox
   materialization, WhatsApp and email sender/final dispatch gates, recovery and
   per-purpose cancellation. Preserve family/execution lock order; this service
   deliberately does not lock or mutate existing execution/Message rows in an
   inverse order. Transport still needs its existing immediate authorization,
   patient HOLD/consent/contact/inbox/handoff/opt-out/template/namespace gates.
   `assertCommunicationCurrent` is a foundation guard, not full permission to send.
   Legacy execution creators do not yet participate in foundation appointment
   locks: their history check is not a global race barrier until those consumers
   are integrated. No clinical identity backfill/activation is authorized by the
   standalone API test. Final transport still needs immediate rechecks outside
   provider calls; an accepted result after a cancellation must be reconciled.
4. Extend inbound wait/reply matching by visit **and purpose/revision/window**,
   while retaining accepted outbound, conversation/contact scope, native wait
   locks and inbox-health protections. Do not collapse all waits in a patient's
   conversation or cancel unrelated purposes. Adopt old IDs only with an explicit
   history ledger. This API does not claim to deduplicate already-running flows.
5. Decide approved window-key definitions and lifecycle adapters per purpose.
   Migration/QA actions never use clinical patient communication purposes.
   Deletion/anonymization workflows need explicit review because RESTRICT FKs
   intentionally preserve visit/delivery history.

No clinical decision was invented. The unresolved durable decision is adoption
of already-existing independent histories; it is diagnosed and blocked, not
silently merged. Ordinary rollback refuses to drop any nonempty foundation table.

Run the opt-in fixture in a separate process:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 PLATFORM_AUDIT_FIXTURE_EXPORT= node src/scripts/tests/appointment_visit_communications_mysql.integration.js
```

## Runtime integration audit / proposed next pass (2026-10-07)

This section is a read-only consumer audit and implementation plan, not runtime
code or rollout approval. Only this document was updated in this pass. No real
database, application bootstrap, scheduler, queue, provider, deployment or flag
was activated. File/line references describe the reviewed worktree, not proof of
the deployed database/template catalog. Broader import/adoption work above is
**not** part of the initial enrollment lane below.

### Actual consumer map and existing deduplication

| Boundary | Reviewed source | Existing guarantee / integration gap |
| --- | --- | --- |
| Canonical reservation | `appointmentBookingCommand.service.js:218,239,494,509` | Existing appointment UPDATE lock, one persistence callback, frozen `import_metadata.booking`, occupancy rows with the same appointment ID. No flow/provider inside this transaction. |
| Phase read projection | `appointment-booking-segments.js:5,55` | All validated v4 phases project the SAME `appointment_id`; `segment_key` is a display/reservation projection, not another appointment or delivery owner. |
| Create | `citas.controller.js:2264,2282,2288` | One appointment then post-commit event/schedule hooks; errors are logged after the reservation already committed. No durable atomic publication of the communication event yet. |
| Edit/status/cancel | `citas.controller.js:2807,2875,2886,2992,3030` | Status writer uses the command; automation cancellation/enqueue/resync is outside it. Cancellation is appointment/execution-wide, not an intent-purpose operation. |
| Move | `citas.controller.js:3222,3278,3284` | Same ID is updated, then all previous running/waiting appointment executions are cancelled before a rescheduled flow. |
| Note/support | `citas.controller.js:2719,3349`; `appointmentSupport.service.js:9,18` | Notes do not belong in the fingerprint. Support changes selected staff and needs snapshot CAS, but must not invent a patient notice just because geometry changed. |
| Delete | `citas.controller.js:3061,3105` | Current cancelled-appointment deletion conflicts with the foundation's deliberate RESTRICT history. Enrolled rows need an explicit protected-history response, not a cascade or an unexplained SQL error. Legacy deletion is outside this lane. |
| Voucher/program writers | `patientVoucherAppointments.service.js:281,293`; `patientProgramBooking.service.js:366,374,399` | Ordinary voucher appointments use the same command and post-commit hooks. Program sessions currently have `source_system=treatment_program`, HOLD, all three notification suppressions, and `reminders_enabled:false`; v4 is NOT authority to release them. |
| Execution creation | `appointmentAutomationV2Runtime.service.js:448,465,1175,1200,1230`; migration `20260219151000:89` | SQL UNIQUE execution idempotency closes concurrent creation for the EXACT same current key. That key contains trigger, appointment ID and template ID; rescheduled key additionally includes `updated_at`, start/end and top-level resource IDs. Template publication/touch can therefore open another execution for the same business purpose. |
| Schedule planning/fire | `appointmentAutomationV2Runtime.service.js:979,1039,1392,1503,1669`; `jobExecutor.service.js:451` | Planner chooses a template per configured slot and compares pending/waiting job payloads before enqueue. No unique semantic visit/purpose/window constraint. Fire reloads appointment, current scoped template, suppression and effective schedule, rejects stale windows and passes a real job claim. Two duplicate schedule rows usually converge on the same execution key, but a new template version gives a different key. |
| Execution queue ownership | `appointmentAutomationV2Runtime.service.js:1182`; `jobRequests.service.js:373,445`; `jobClaim.service.js:7` | Unique enqueue is runtime namespace + active job + dedupe scope, normally `flow_execution:<ID>`. Real claim checks current persisted attempt/time/namespace. This is transport/execution ownership, not a lasting business notification right. |
| WhatsApp materialization | `flowEngineV2.service.js:3605,3678,3840,4544`; migration `20260714121000:28` | SQL UNIQUE Message delivery key is execution + node/explicit slot; access-guidance variants can share a slot. It deduplicates the SAME execution/slot, not independent executions or old PRP IDs. Events have a separate `:event` row and are not patient deliveries. |
| Replay/outbox | `flowEngineV2.service.js:3699,3257,3345`; `queue.workers.js:766,777,785` | Existing accepted Message is reused; uncertain non-outbox replay is refused. Deterministic transport job and SAME Message are retained. Worker sets Message to `sending` BEFORE final send. Foundation assertion cannot simply be inserted afterward; see dispatch lease below. |
| Final WhatsApp send | `whatsapp.service.js:483`; `whatsappAuthorizedBrokerClient.js:174,299`; `whatsappAppointmentEligibility.js:16,48` | Common execution/QA gate, durable Message/conversation scope, fresh appointment/import/patient-HOLD/reception gates, authorization and namespace rechecks immediately before broker dispatch. Stable broker request ID derives from Message ID, not queue attempt. Foundation checks must supplement, not replace these gates. |
| Email | `flowEngineV2.service.js:6298`; `emailDelivery.service.js:199,441,473`; `models/emailmessage.js:36` | Outbox UNIQUE key is execution + node + recipient hash; final `beforeDispatch` calls the common execution/QA gate and suppression/auth gates. Foundation has only `message_id -> Messages`, not EmailMessage binding/outcome. Cross-channel at-most-one notice is NOT implemented. |
| Native waits/recovery | `flowEngineV2.service.js:6160,6921,7334,7402`; `whatsappAppointmentTimeout.js:6,34`; `whatsappPendingReply.js:6` | Wait owns listened outbound Message/conversation, effective send anchor and deadline. Inbox outage/pending native dispatch holds it; recovered receipts create reception review, not replay. Recovery delivery key uses appointment ID/start/day. `hasAskedToday` queries the SAME canonical appointment ID, not legacy linked IDs. |
| Inbound ownership | `automationsV2Resume.service.js:564,690,895,945`; `automationInboundMessage.service.js:110,600,724`; `models/automationinboundmessageclaim.js:12` | Unique claim per inbound/provider Message; conversation/contact/patient/lead scope, never appointment ID alone. Buffer locks execution then jobs and consolidates inbound IDs. Multiple matching waits currently keep newest and cancel older regardless of visit/purpose; this must not cancel another purpose or legacy history when a new enrolled lane is introduced. |
| State mutation from flow | `flowEngineV2.service.js:2543,2572,2669` | Family/execution/job-claim locks precede appointment/booking mutation. Existing cancellation may clear waits. New enrolled mutation must check captured visit revision too; matching appointment state alone does not protect an old reply after a silent reschedule. |

Canonical ID prevents per-phase creation and makes ordinary identical execution,
Message, transport-job and recovery keys converge. It does not make template
versions, different nodes, schedule races or separate historical IDs equivalent.
Two independent create requests that persist two appointment IDs are also not
permission to merge them by equal time/patient/phone.

### Smallest coherent enrollment and stage contract

Proposed flag name: `APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED`; exact string
`true` only, closed by default. No flag was added/set here. Enrollment is decided
ONLY inside the canonical birth transaction after successful v4 persistence:
at least two valid frozen v4 steps, fully verified capacity, SINGLETON, no current
clinical component reference, source/reference/HOLD/history/provisional/QA/suppression
exclusions. No scan, lazy enrollment on edit/fire, history takeover, PRP merge or
program/import release. Ordinary voucher ownership does not bypass these checks.

Add a dedicated server-owned durable contract/enrollment field on AppointmentVisit
(contract ID/version, birth event ID/time, policy identifier). Do not overload
`grouping_evidence` (singleton requires `{}`), the semantic snapshot or client
`import_metadata`. Persist explicit mutation/event time once; `updated_at` is not
an event identifier or communication revision. Once enrolled, all relevant
consumers route by that persisted contract, even after the rollout flag closes:
hold new dispatch, retain receipts/waits, NEVER fall back to legacy sending.
Unenrolled rows retain their current runtime unchanged.

The trusted stage manifest is a finite server registry, validated against the
actual pinned flow graph. It maps graph node(s) to semantic stage, purpose,
source/listened stage, channel, lifecycle transition and window policy. Node ID,
template name/version, delivery variant and retry attempt are audit/binding data,
not notification identity. Base/access-guidance alternatives map to ONE stage.
All reachable patient-send and state-change nodes must be classified before
enrollment; unsupported graph/unknown stage fails closed, not legacy fallback.
Do not mutate/activate templates or infer a purpose from display text.

Important direct-wire mismatch: current foundation `purposeTriggers` at
`appointmentVisitCommunications.service.js:81` allows acknowledgement only from
`appointment_confirmed` and timeout only from created/reminder triggers. Actual
flows acknowledge within the original reminder/created/rescheduled execution:
night-before seed `20260627113000:268` is an ACK after attendance confirmation;
rescheduled graph `20260905210000:157,336,342` has same-flow reply/timeout stages.
Its cancellation branch at seed `:220` is cancellation plus RECEPTION system
notification, not proof of a patient cancellation notice. Extend authorization
only for enrolled, persisted manifest stages and exact source/revision bindings;
keep the unmanifested foundation restrictions intact. Do not broadly allow any
purpose on any appointment execution.

If a manifested flow itself makes a guarded lifecycle change, only the resulting
persisted canonical mutation receipt may advance its captured revision for the
next manifested stage. Refreshing an old execution to whichever revision happens
to be current would let stale inbound mutate/acknowledge the moved appointment.
The original accepted source intent/Message/wait remains bound to its old revision.

### Finite semantic windows (proposed contract, not enabled)

Let D be patient start's clinic-local calendar date, S the captured patient start,
and E the stored server mutation/event time. Timezone and stage policy are frozen
with enrollment/planning; DST conversion must use local date operations rather
than adding 24 hours. The revision remains a separate SQL key component.

| Purpose | Stable window key | Bounds/source that MUST be persisted once |
| --- | --- | --- |
| `appointment_details` | `details` | `[E,S)`. Create and patient-visible reschedule share this purpose; explicit semantic revision permits new current details. Note edits, template publication, retry and administrative-error reschedule never independently request details. |
| `reminder_day_before` | `day_before:<D>` | Local calendar day D-1, ending at local midnight D. Approved scheduled run time is dispatch scheduling/audit, NOT another window key. Night unconfirmed warning is NOT automatically a second ordinary reminder slot. |
| `reminder_same_day` | `same_day:<D>` | `[local midnight D,S)`. Same-day native policy must remain explicit; imports/hold release cannot enter this lane. |
| `confirmation_acknowledgement` | `ack:details` or `ack:attendance` | Native accepted source communication + listened stage + first owned eligible inbound claim; bounds use that source's persisted effective send anchor/native wait deadline, capped by S. More inbound Messages or reply node variants do not create more ACK rights. |
| `confirmation_timeout` | `timeout:details` or `timeout:attendance` | Native source stage's persisted due/cutoff, capped by S and its original operational day/stage window. Recovery/retry uses SAME key/Message, never `recovery:<today>` to grant another right. No reception health, pending inbound or unresolved outcome means no timeout right. |
| `cancellation`, `no_show`, `completed` | `terminal:<lifecycle>` | Exact persisted terminal mutation E and finite server-owned expiry. Current runtime has no uniform terminal expiry contract: choose/document this technical delivery policy before admitting such a graph. Do not invent expiry from retry time or enqueue attempt. |
| `aftercare` | Reviewed finite `aftercare:<stage>` | Exact completed lifecycle/source and approved existing aftercare timing/cutoff. Current scheduler also supports day/week-after slots; those are NOT automatically licensed by the finite foundation purpose. |
| `clinical_consent` | Reviewed `consent:<requirement-slot>` | Existing server consent package/requirement ledger and expiry; do not replace clinical package identity with template version or a new random package on retry. |

The runtime registry must reject arbitrary caller window strings: foundation's
generic `normalizeWindow` intentionally validates syntax, not business meaning.
Changing configured run time or template version keeps an existing intent's key,
bounds, template audit binding and Message. Changed bounds on that key conflict;
an implementation must not mint `retry:<timestamp>` or another channel key.
Terminal/aftercare/consent policy gaps are engineering review items, not questions
to patients and not permission to manufacture additional clinical decisions.
The existing 21:00 night-unconfirmed trigger tests attendance state, not proof of
silence after an owned outbound wait. It must have an explicitly reviewed warning
purpose/stage contract before that graph enrolls; do not label it a timeout merely
because its template says unconfirmed. Likewise `week_before` is not implicitly
covered by the two finite reminder purposes. Candidate enrollment checks ALL
applicable event/scheduled/consent graphs, so an unsupported existing operation
means no enrollment, not silently dropping that operation after creation.

### Transaction boundaries and the required real dispatch lease

Booking already owns appointment then booking-resource locks. Do NOT call
`createExecution` or acquire family/execution/existing job locks inside it. That
would invert the actual flow mutation path. Birth/mutation transaction writes
enrollment, snapshot CAS and intent rows only; pending/unbound communication rows
can be the durable minimal outbox. A consumer materializes the flow later, using
the original pinned template audit and durable intent key. A crash after commit
must leave a recoverable unbound intent, not a lost logged hook.

Runtime action/dispatch order: family rows in established order -> existing
execution (if any) -> real job claim when required -> appointment IDs ascending
-> member rows -> visit UUIDs ascending -> communication -> Message. New
execution creation takes family first and never starts with a booking lock.
Plain booking transaction has no family/execution/job acquisition. Inbound buffer
must join the family-first order before executing a managed clinical mutation;
do not add a later family lock beneath its current execution-first transaction.
No provider call is inside any of these transactions. Retrying a deadlock reruns
the whole database operation; it never grants a new communication window.

Do not blindly put `assertCommunicationCurrent` in the final broker gate:
`messageOutcome` (`appointment-visit-communication.js:200`) treats `sending` as
unknown, while the real worker (`queue.workers.js:785`) sets sending before the
first HTTP dispatch. A real `beginDispatch`/`assertDispatchAttemptCurrent` adapter
must distinguish the SAME authorized live attempt from an orphan uncertain send.

Minimum lease extension on the communication: durable opaque attempt token,
claim kind/ID/attempt, started/lease-expiry times and dispatch state. Claim proof
comes from server job/execution/transport ownership, not payload booleans. Under
the lock order above, begin verifies existing final eligibility, source/revision,
manifest, window, original bound Message and absence of accepted/unknown evidence;
CAS records the lease and sets THAT Message sending atomically. Final preflight
checks the still-owned lease and current gates. A concurrent handler cannot start
another attempt while it is owned. Lease expiry/worker disappearance after begin
becomes protected unknown unless there is positive persisted proof no dispatch
started; elapsed time is NOT proof of failure. A definite pre-dispatch failure
may release/retry the SAME intent/Message/request key. Transport request identity
remains derived from the Message, never lease token/attempt/template version.

The outbound row uses foundation `visit-communication:<UUID>` EXACTLY; current
generic helper appends `:outbound`, which would fail `boundMessage` today. Use a
managed materializer branch, not a global legacy-key rewrite. Internal flow
event keeps a separate key and is not bound as the delivery. Binding must precede
queue publication. Accepted/unknown replay returns existing receipt/output and
preserves source Message/wait anchor; it does not call begin again or send another
Message. Reconcile receipts even after cancellation/revision/HOLD/QA changes;
unknown may become accepted only on that SAME original delivery evidence.

Email must either gain a typed EmailMessage binding/outcome and shared purpose
right before this lane admits email stages, or that entire candidate graph is
not eligible for enrollment. Do not add `:email` to the window as a workaround,
silently skip an existing email operation, or claim cross-channel coverage.

### Executable implementation order / acceptance gates

The **next authorized coding unit**, before shared consumers, can be limited to:
an additive enrollment/lease migration, corresponding existing foundation model
fields, `src/lib/appointment-visit-runtime-contract.js`, and
`src/services/appointmentVisitDispatch.service.js` using actual explicit models.
Contract API names below are proposals, not currently exported methods:

- `enrollNewCanonicalVisit`: requires a server-sealed proof of creation in this
  transaction, eligible frozen v4 and selected finite manifests; ordinary public
  JSON/caller `newAppointment:true` cannot enroll an existing row.
- `planVisitCommunication`: takes a trusted manifest stage/native source anchor,
  derives the registered purpose/window, stores its definition once and calls the
  real claim API. It does not accept an arbitrary retry/template-shaped window.
- `beginDispatch` / `assertDispatchAttemptCurrent`: take real delivery-claim proof
  and persisted communication/Message, implementing the lease/CAS above.
- `settleDispatch`: derives outcome from the persisted bound Message/provider
  evidence; a caller `accepted:true` is not a receipt. `failBeforeDispatch` accepts
  only positively classified server boundary failure, not a stale-lease timeout.

Tests for that unit: proposed `appointment_visit_runtime_contract.test.js`,
`appointment_visit_dispatch_service.test.js` and opt-in
`appointment_visit_dispatch_mysql.integration.js`, reusing the existing isolated
fixture and actual migration/models/service. The subsequent actual-consumer owned
fixture should be `appointment_visit_runtime_mysql.integration.js`. Implementing
this unit alone must NOT be reported as endpoint-to-send or wait integration.

1. **Additive contracts, not consumer rewrites.** New enrollment/manifest/window
   helper, small schema extension and real dispatch-lease service; existing
   foundation triggers stay restrictive outside the managed contract. Pure/model
   tests prove server-only enrollment, all reachable stage mapping, stable keys,
   purpose/lifecycle authorization, millisecond windows, positive ownership proof,
   no arbitrary window/template/retry/channel escape and protected outcomes.
2. **Canonical transaction and publication.** In
   `appointmentBookingCommand.service.js` after successful persistence/occupancy,
   birth enrolls eligible v4 only; enrolled edit/move/cancel/support/automation
   status writers refresh explicit CAS and record selected intents atomically.
   No sends merely because a fingerprint changed. Native controller hooks route
   enrolled rows to the adapter, never both paths. Preserve the exact existing
   administrative-error silent behavior. RESTRICT deletion gets a scoped history
   response. Owned SQL proves rollback, CAS and a committed unbound intent can
   resume after producer death. Imports/program/HOLD/history/PRP never enroll.
3. **Runtime/scheduler creation.** Branch by persisted enrollment in
   `appointmentAutomationV2Runtime.service.js`; visit/revision/stage execution
   key and communication planning are template-version independent. Stable
   planned intent/window plus real job claim closes duplicate schedule rows/fire
   races. Preserve compatibility `trigger_entity_id=owner_appointment_id`, clinic,
   template-family active checks and namespace. Do not run legacy template
   backfill/enqueue for managed appointments, including when flag closes.
4. **One materialized delivery and lease.** Managed branches in
`flowEngineV2.service.js`, `automation-runtime-stop.js`, worker/common WhatsApp
   send and authorized broker bind original intent/Message before publish;
   prepare/begin/final checks use real ownership. Existing legacy Message keys and
   sender behavior stay unchanged. Queue publication failure retries that same
   pending row. Provider-fake acceptance settlement, unknown handling and receipt
   reconciliation must test actual adapters, not just the helper.
5. **Purpose-aware waits, inbound and recovery before activation.** Retain native
   listened source, effective send clock, deadline, namespace, pending reply IDs,
   conversation/contact/opt-out/human-handoff/inbox-health guards. Store managed
   visit/revision/purpose/window/source-intent wait binding. Never match by visit
   or appointment ID alone; never cancel another purpose or legacy execution using
   the global newest-wait rule. Explicit reply-to/accepted outbound ownership can
   select a wait; ambiguous free text keeps durable receipt + internal review,
   without patient-facing technical clarification or another reminder. Stale
   revision replies remain visible but cannot mutate the newly moved reservation.
   Per-purpose intent cancellation does not erase accepted waits/reply evidence.
   Whole-visit terminal invalidation is distinct from stopping one purpose.
6. **Transport breadth and rollout remain separate.** Email requires the typed
   extension above. Terminal/aftercare/consent graph policies and mixed legacy/
   managed wait ownership must pass explicit contracts before those candidates
   enroll. Rollout remains closed until the owned end-to-end fixture below and
   final consumer review pass; migrations/tests never authorize sending.

New owned integration acceptance should reuse `withIsolatedCampaignMysql` and
deny real sockets/providers/queues/app bootstrap. Invoke the actual scoped
endpoint handler/command, runtime, materializer, queue handler and final guards
against fixture-owned models, a controlled fake queue and in-process fake broker
transport; stub only unrelated infrastructure/CRM/socket hooks. Endpoint/auth/
DTO scope must be exercised, not a reimplementation of the writer. If an owned
loopback HTTP harness is needed, use the fixture's explicit owned-server permit.

Required observable checks (counts must distinguish internal events from patient
deliveries):

- Eligible endpoint v4 birth -> ONE CitaPaciente ID -> all phases same ID -> ONE
  Visit/Member -> ONE purpose/revision/window intent -> ONE canonical execution
  for its stage -> ONE outbound Message -> ONE fake logical provider acceptance.
- Parallel same event/schedule fires, template publication, benign `updated_at`
  touch, access-guidance alternatives, queue handoff retry and process restart
  keep that original intent/Message/request key. Replaying accepted performs ZERO
  additional provider attempts. Definitive pre-dispatch retry keeps the SAME key.
- Sending under the live lease can pass final preflight once; wrong/expired/stolen
  lease cannot. Crash-after-send/unknown never creates another Message or resends.
  Later same-key receipt upgrades unknown to accepted, even after cancel/HOLD.
- Move or phase2 staff/room change increments semantic revision in the same
  transaction; old queued send fails final projection gate. Administrative-error
  move sends nothing. Note/confirmation status touch does not create a revision.
- Cancellation-before-begin gives zero provider calls for that stale purpose;
  cancellation after real request begins cannot undo acceptance and must reconcile
  it. A reminder purpose cancellation does not erase the details wait or ACK.
- Two simultaneous legitimate purpose waits, stale reply after move, mixed legacy/
  managed contact, inbound duplicate/buffer batch, pending native dispatch and
  recovered receipt retain exact source/ownership/history and do not blind-cancel
  an unrelated wait. Outage/overdue recovery cannot mint a new date window.
- Flag closed, missing enrollment/manifest, invalid frozen v4, QA nested marker,
  provisional/HOLD/import/history/PRP/program row, source policy revocation or
  scope mismatch cannot enter managed sending. Flag closure on enrolled row cannot
  re-enter legacy. Legacy control fixture retains original behavior/keys/history.
- All lease/command/runtime cross-lock race tests use real owned MySQL and
  rollback/deadlock handling; fake mutex tests alone do not prove this order.

This audit reran only six offline suites (foundation pure/model/fake, synthetic
guards, scoped scheduler resolution, timeout policy and extracted real timeout
branch): **64/64 passed**, no skips. This is not endpoint/runtime SQL integration,
provider proof or evidence that the proposed adapter exists. Existing scheduler
and rescheduled-graph test scripts that import the normal models/services were
inspected, not run against a real environment.

### Historical PRP adoption is a separate ledger, not the initial lane

Current validated reciprocal relation plus current reservations proves membership,
not that two historical messages/waits had one identical purpose/revision/window.
The existing foundation history refusal remains correct. Future adoption needs
append-only evidence rows linking every original execution/Message/EmailMessage/
provider request and native wait to an explicitly reconstructed business slot;
multiple accepted/unknown deliveries must ALL remain represented, not replaced
by one arbitrary winner. Accepted or unknown evidence consumes/holds that slot;
no new delivery follows from adoption, publication, restart or changed ownership.

Preserve original IDs, trigger owners, keys, timestamps, reply claims, waiting
metadata/deadlines and provider outcomes. Reconstruct old geometry only from
actual captured receipts/snapshots; incomplete phase/revision evidence is marked
unresolved, not assigned current revision or `updated_at`. Relationship changes
are explicit audited ledger actions after conflict/race reconciliation, never
ordinary ensure/group retry. Route technical ambiguity to internal review without
asking the patient to decide identity; do not delete, infer-merge, resend or cancel
independent legacy waits as a side effect of establishing a Visit. This adoption
ledger and runtime adaptation remain unimplemented and unactivated.

## Additive runtime bridge implemented 2026-10-07 (not consumer wiring)

This section supersedes the proposed API names in the audit, not its end-to-end
acceptance gates. Actual new files:

- `migrations/20261007130000-add-appointment-visit-runtime-contracts.js`:
  `AppointmentVisitBirthRequests`, `AppointmentVisitDispatches`, nullable Visit
  enrollment and Communication stage/purpose-wait contracts + SHA256 columns.
  All new timestamps are `DATE(3)`. Unique clinic/request key, appointment/visit
  birth bindings and communication/attempt/token indexes are actual SQL, not an
  in-memory dedupe. Down refuses any receipt, enrollment, stage or wait/hash
  before dropping/removing anything. No historical row/event/job is created.
- Actual factories `models/appointmentvisitbirthrequest.js` and
  `models/appointmentvisitdispatch.js`; existing foundation model attributes
  match both migrations. Normal model discovery needs no bootstrap alteration.
- `src/lib/appointment-visit-runtime-contract.js` compiles the entire selected
  published active server-owned graph into opaque, privately branded contracts,
  not caller JSON. The graph and per-stage node/trigger/purpose/wait/mutation
  configuration are frozen and hash-checked. One send node per stage initially;
  every reachable patient send, native response wait and appointment mutation
  must be mapped. Unsupported email, week-before/night-unconfirmed warning,
  unmapped action or duplicate/multi-send stage rejects enrollment; do not drop
  that operation from an existing graph to make it enrollable.
- `src/services/appointmentVisitRuntime.service.js` exports real birth, stage
  claim and purpose-wait capture, using explicitly supplied actual models.
- `src/services/appointmentVisitDispatch.service.js` exports real SQL attempt
  leases over an existing exact-bound Message, execution and durable JobRequest.
  Neither service bootstraps an app, registers a worker/handler, enqueues,
  creates a Message/execution/job, invokes a provider or activates a flag.

### Exported contracts and required trusted composition

`compileEnrollmentContract({clinicId, groupId, timeZone, manifests})` must be
called only from the server's selected actual published templates and reviewed
finite stage manifest. Each stage has a registered key, exactly one node ID,
native wait IDs if applicable and a source stage for ACK/timeout. A timeout
requires explicit reviewed `timeout_grace_ms`; no clinical expiry is invented.
Known appointment status mutation nodes require exact explicit mapping.
Serialized/cloned tokens and public `newAppointment:true` have no authority.

`createAppointmentVisitRuntimeService({db, bookCanonicalBirth, ...})` accepts
the canonical writer only as a startup/server composition dependency, never an
HTTP field. `createCanonicalBirth({clinicId, patientId, actorId, requestKey, plan,
contract, transaction?})` requires a UUID request key even on its first call.
`plan` is the actual normalized selected plan (start/end, doctor/installation/
treatment, validated frozen booking and optional full-visit additional staff),
not notes, arbitrary import metadata or raw request timestamps. The semantic
hash normalizes instants/ID geometry and excludes labels/warnings/notes/economics.

The transaction reserves/locks a unique receipt, compares clinic/patient/hash,
and only then invokes the trusted writer. The writer receives a privately scoped
`persist(values)` closure and must return the exact row that this closure creates
once in that same transaction. An existing row, guessed ID, client boolean,
skipped or double persist cannot prove a new birth. Any error rolls back receipt,
appointment, member and enrollment. Replay loads the current scoped appointment
and durable membership/Visit and compares the effective normalized plan hash
before invoking the writer; conflicts or changed geometry fail, never create
another appointment. A replay after rollout closes returns identity only, not a
right to communicate. A failed/closed first call creates no placeholder.

The flag `APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED` is strict `true` only and
defaults closed. It has not been enabled. No generic create endpoint now requires
a new key: this API is unconnected opt-in composition only. Initial enrollment
is future native singleton, frozen fully-verified v4 with at least two steps;
voucher/program/source/HOLD/provisional/history/PRP/QA/suppressed rows cannot
enroll. Managed uses recheck this narrow eligibility. Existing protected import
operation/reminder releases remain unchanged for unenrolled callers; they never
become a fallback enrollment or a same-day/backlog right.

`planVisitCommunication({visitId, clinicId, expectedRevision, stageKey,
templateVersionId, sourceCommunicationId?, inboundMessageId?, actorId?,
transaction?})` derives the window from durable enrollment/native purpose wait,
privately seals the plan and calls the real foundation claim in the same
transaction. Public caller windows are not accepted. SQL uniqueness is still
visit + purpose + explicit communication revision + semantic window key; a
template publication/retry timestamp cannot mint another right or overwrite the
original template/Message binding. Enrolled calls to generic `claimCommunication`
without the exact opaque stage plan fail closed; there is no legacy fallback.

Implemented windows:

| Stage | Exact key | Fixed source/bounds |
| --- | --- | --- |
| details | `details` | Revision 1 enrollment timestamp to patient start |
| attendance_day_before | `day_before:YYYY-MM-DD` | Clinic-local preceding midnight to patient-date midnight; DST preserved |
| attendance_same_day | `same_day:YYYY-MM-DD` | Clinic-local patient-date midnight to patient start |
| ack_details / ack_attendance | `ack:details` / `ack:attendance` | Accepted source wait start to min(native deadline, source cutoff) |
| timeout_details / timeout_attendance | `timeout:details` / `timeout:attendance` | Native deadline to min(deadline + explicit grace, source cutoff) |

Details revision >1 deliberately fails `runtime_mutation_event_required` until
the canonical mutation adapter records a real explicit durable event anchor.
No use of `updated_at`, template version or a retry clock fills that gap.
Terminal/aftercare/consent/email rights remain unsupported in this managed lane.
ACK needs the actual completed wait-response inbound owner receipt, same source
execution/conversation and accepted inbound time; arbitrary appointment/patient
IDs or free text do not select a wait. Late/recovered inbound receipt must remain
visible under existing recovery policy even when this strict ACK window cannot
claim. Timeout verifies actual still-owned native wait/pending reply buffer and
the protected inbox health reader (ready for timeout), with fresh checks still
required at execution and immediately before dispatch/clinical mutation.

`freezePurposeWait({sourceCommunicationId, clinicId, waitNodeId, transaction?})`
locks actual family/execution first and captures the already accepted bound
source Message plus manifested native wait. It retains source intent/message/
execution/conversation/node, namespace and native JSON clock/deadline; compares
the latter to existing `FlowExecutionV2.wait_until` at its real DATE(0) precision.
Capture is immutable/idempotent and does not rewrite native flow status,
`waiting_meta`, pending replies, deadlines, conversation or inbound claims. This
is a stored ownership contract, not yet inbound/recovery integration.

`createAppointmentVisitDispatchService({db, namespace, preDispatchCheck, ...})`
has these exact exports:

- `captureJobClaim({job, isActive})`: internally brands an actual current running
  durable JobRequest claim with existing `createJobClaim`, attempt/time/namespace.
  Tokens are process-local, cannot be JSON and must be recaptured only by the
  real worker after a legitimate persisted claim; process restart does not
  invent an attempt. Required type is `appointment_visit_dispatch`. No handler
  is registered by this unit; ordinary Bull outbound transport is not a claim.
- `beginDispatch({communicationId, clinicId, claim, transaction?})`: family ->
  execution -> actual JobRequest proof -> appointments ascending -> member ->
  Visit -> Communication -> Dispatch -> SAME Message. The persisted job payload
  must bind exact communication/execution/Message and cannot be QA. Rechecks
  current enrollment graph/stage/revision/membership/window/suppression and
  exact Message stage node/clinic/patient/outbound delivery key. Creates one
  SQL attempt and atomically marks that Message `sending` + intent `dispatching`.
  Same owned attempt replay reuses it; no replacement Message/key is created.
- `assertDispatchAttemptCurrent({dispatchId, clinicId, attemptToken, claim,
  transaction?})`: checks the same actual ownership and future technical lease
  (default 60 seconds, maximum 5 minutes), same Message and protected receipts.
  It may validate a live `sending` Message without treating it as generic orphan
  unknown. Lease time never creates another semantic communication window.
- `runPreDispatchCheck` takes that same argument shape. The trusted factory
  guard must **throw on rejection and return undefined on success**, composing
  all actual immediate transport policies; booleans are not permission. Missing
  guard fails closed. It records `network_started_at` once before the external
  call, with no provider call inside the transaction. Another invocation cannot
  begin network again. A positively known pre-network denial fails that same
  Message/attempt; a real SQL/transaction error propagates instead of certifying
  a definite failure. Actual final broker/common sender checks remain required.
- `reconcileDispatch({dispatchId, clinicId, transaction?})`: derives outcomes
  only from the persisted same Message. Accepted never regresses; live owned
  `sending` retains dispatching; expired/lost/orphan sending becomes protected
  unknown, which only a later same-Message acceptance can advance. Receipt
  reconciliation survives current HOLD/QA/stale clinical projection and cannot
  grant sending permission. No resets/reassignment/deletion of old attempts.
- `cancelIntent({communicationId, clinicId, reason, transaction?})`: bounded
  code reason, one purpose/intent only. Pre-network owned attempts can be
  definitely cancelled; started/orphan/expired sending remains unknown. Accepted
  and unknown are preserved. It does not cancel another native wait, flow/job,
  history or purpose. Whole-visit cancellation still needs explicit adapters.

Managed consumers must use lease-aware `reconcileDispatch`/`cancelIntent`, not
generic foundation reconciliation (which conservatively treats every `sending`
Message as unknown). `inspectCommunicationCurrent` checks projection/policy but
is intentionally NOT an attempt/send permission. `assertCommunicationCurrent`
does not by itself authorize a first live lease-owned `sending` Message.

### Verified scope and immediate consumer hooks

Pure/model + existing safe foundation/synthetic/scoped-runtime/timeout suites:
**76/76 passed**, no skips. Actual opt-in owned integration
`src/scripts/tests/appointment_visit_runtime_mysql.integration.js` passed on
MySQL 8.0.42 with report `/tmp/cc-campaign-opt-mysql-yIwPqG/result.json`, clean
shutdown 0, rejected external sockets 0 and provider attempts 0. It proves both
migrations up/down/up, actual model/FK/unique/DATE3 contracts, 8 simultaneous
canonical sealed births -> one appointment/member/Visit/receipt; 8 real enrolled
claims -> one intent; 8 actual job-owned begin calls -> one lease/SAME Message;
the actual SQL family/execution/job/appointment/member/Visit/intent/Dispatch/
Message lock order, native purpose wait clocks, inbound receipt ownership,
reception/pending reply holds, definitive same-key retry, per-purpose cancel,
orphan/expired unknown, late accepted after HOLD/QA, real locked phase2 edit
race/CAS/stale binding, stopped execution, graph change and closed preflight.

The prior actual foundation SQL regression also passed with the composed model
columns (`/tmp/cc-campaign-opt-mysql-OXWgUq/result.json`, shutdown 0, no external
connections/providers), preserving current verified released PRP/import policy,
same-day/backlog refusal, history/waits, accepted/unknown and grouping locks.
The new SQL fixture uses the actual sealed persistence seam with a controlled
trusted writer, **not the actual booking command/controller/runtime/worker**.
No current endpoint-to-provider proof, global lock/deadlock-retry proof or runtime
consumer integration is claimed by these passing unit/SQL tests.

Next consumer implementation, after interface review:

1. **Canonical endpoint/command:** choose the opt-in server contract before
   entering the birth path; accept a stable frontend UUID request key only for
   this lane and keep it for retry (new patient intent gets a new key). Wire the
   command's existing validated persistence boundary to the sealed closure,
   preserving availability/resource locks, economics and one appointment ID.
   Birth + enrollment + selected details intent must share the caller-owned
   canonical transaction, before commit; the BirthRequest/intent is the durable
   recovery source if publication fails. No original postcommit generic hook
   also runs for the enrolled row. Do not alter generic legacy request DTOs.
2. **Runtime/scheduler:** read persisted enrollment, claim with
   `planVisitCommunication`, retain original intent/template and use a stable
   stage execution key derived from that intent rather than template/runAt.
   Set `context.appointment_visit` exact Visit/revision/enrollment hash and
   compatibility owner trigger. Family lock comes before execution creation;
   none under booking appointment/resource locks. Publish/resume from committed
   intents/receipts; failure leaves durable unbound work, no legacy fallback.
   Scheduler must not create ordinary template-keyed jobs for managed rows.
3. **Materializer/real durable delivery job:** choose mapped node/stage, create or
   reuse ONE Message using the exact `visit-communication:<UUID>` key (do not
   append current helper's `:outbound` suffix), persist `execution_id`, `node_id`,
   `visit_communication_id` and bind foundation before publish. Add a narrowly
   scoped durable `appointment_visit_dispatch` handler: actual claimed
   JobRequest payload carries only persisted IDs/namespace, then recapture job
   proof and begin SAME Message lease. Legacy Bull sender must not independently
   process it; existing legacy jobs/messages/keys remain unchanged.
4. **Final transport/reconciliation:** compose actual contact/scope/template/
   namespace/opt-out/handoff/HOLD/inbox/synthetic guards in the trusted assertion
   dependency, and retain broker/common sender immediate gates. Run precheck
   once, pass exact same provider idempotency key, store the actual outcome on
   that same Message, then reconcile the SQL dispatch. Definite pre-network retry
   increments actual job attempt but retains intent/Message/key. Transport-start
   uncertainty never resets sending or enrolls new work. Crash/recovery is fact
   reconciliation, not another provider permission.
5. **Wait/revision/inbound:** after actual native wait persistence, capture exact
   purpose wait; use its source for ACK/timeout claims. Preserve existing native
   clocks, pending dispatch/recovery and inbound duplicate ownership. Managed
   inbound selection must remove the global newest-wait cross-purpose cancellation
   only for the managed lane, without changing legacy matching. Add explicit
   durable canonical mutation-event anchor for details revision >1, bind it in
   the same CAS move/edit transaction, invalidate stale owned work per purpose;
   cancel/status/support/delete adapters and terminal contracts need review.

Acceptance is still the earlier actual scoped endpoint -> canonical one ID ->
runtime stage/execution -> ONE Message -> one fake provider logical acceptance,
plus parallel retry/move/cancel/purpose waits/recovered replies/legacy control.
Do not enable the flag or call this overall objective complete before that
actual-consumer owned fixture and final boundaries pass. Historical PRP/adoption
ledger, email binding and unsupported clinical policies remain separate explicit
work, never inference or an excuse to resend old accepted/unknown history.

## Native birth/details consumer cut implemented 2026-10-07 — CLOSED

This section supersedes the earlier **proposed** consumer hooks only for the
initial native singleton details lane. It does not authorize rollout, migration
execution, real provider dispatch or historical identity adoption. No flag,
private provider configuration, production graph manifest, database or deployed
application was changed. `src/config/appointmentVisitRuntimeManifests.js` is an
empty frozen server-owned registry; rollout requires an explicitly reviewed
graph and `APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED === 'true'`, currently not
activated. Two or more frozen steps remain **one CitaPaciente**, never a new
family of appointment rows to accommodate communication IDs.

### Actual files and boundaries

- `citas.controller.js:createCita` (2287–2391): optional
  `booking_request_key` UUID and `booking_plan_sha256` receipt; the server selects
  a supported native birth lane and issues a private WeakMap-branded token.
  Only managed responses advertise `booking_request_replay_supported:true`,
  the same request key and `booking_request_replayed`. Legacy callers do not
  require a key and do not acquire replay support implicitly. Exact replay does
  not repeat creation-only clinical-package, lead/direction/socket side effects.
- `appointmentBookingCommand.service.js:mutateAppointmentBooking` (248, 523):
  check durable receipt before solving occupancy, then recheck under canonical
  booking locks for first-request races. Mixed clinic/patient/semantic selected
  plan conflicts fail409. Complete-plan hash CAS is checked after actual solver
  and rechecks, before any appointment/occupancy persistence. The sealed existing
  writer creates exactly one appointment and, in that same transaction,
  BirthRequest/Visit/member, hashed enrollment and the details intent. Notes,
  retry time, template version and `updated_at` grant no new right.
- `appointmentVisitManaged.service.js` (45–213): private birth/transport tokens,
  durable replay, postcommit publication, guarded discovery and exact stage
  bindings. New enrollments freeze the server's explicit `runtime_namespace`
  into the enrollment JSON/hash. Existing contracts without it are preserved,
  never lazily assigned another namespace. Reconstructing the SQL saved booking
  receipt uses frozen effective attention, persisted warnings and the original
  priority/overlap requirement facts, not a newly fabricated acknowledgement.
- `appointmentAutomationV2Runtime.service.js:enqueueExecutionForCita` (1292):
  detect persisted enrollment **before** the legacy appointment hook. Publish
  the original persisted intent at `visit-stage:<intentUUID>`, under actual
  family→execution→job→appointment/member/Visit/intent locking. No family lock
  runs inside the canonical booking/resource transaction. Enrolled rows never
  fall back to ordinary scheduled/Bull/template-keyed messages, including when
  rollout closes or mutation/stage support is absent. Unenrolled operations,
  including protected released imports, retain their existing policy.
- `flowEngineV2.service.js` (1002, 3637, 3860, 4573): managed writes acquire the
  family/execution guard before the actual branded JobRequest claim; materialize
  or reuse the **same** Message at `visit-communication:<intentUUID>` with no
  legacy suffix. New Message `sent_at:null`; persist exact communication and
  execution binding before publish of `appointment_visit_dispatch`. Explicit
  legacy enqueue/quiet-send boundaries reject managed Messages, including fresh
  context/durable detection when a Message marker is stripped.
- `jobClaim.service.js` and `jobExecutor.service.js` (588): existing native
  JobRequest claims now carry a server-only brand. The real new handler recaptures
  job/namespace/attempt/lease, not an HTTP-shaped JSON claim. Dispatch service
  `prepareDispatch` validates before configuration/common-sender checks;
  `runPreDispatchCheck` marks `network_started_at` only from the private broker
  proof immediately before its actual transport boundary. Pre-network denial is
  definite failure, not delivery unknown. Started ambiguous transport becomes
  protected unknown; no retry can reset it, allocate another Message or key.
- `whatsapp.service.js:dispatchMessage` (475) and
  `whatsappAuthorizedBrokerClient.js` (142, 194, 350): repeat fresh durable
  managed detection and private current proof. Existing clinic/account,
  recipient/contact, opt-out, template/WABA/security, scope, namespace,
  handoff/inbox/HOLD/import/synthetic guards stay in the actual sender/broker.
  Managed dispatch requires the existing authorized broker binding and cannot
  fall back to legacy credentials. The proof is never serialized to its payload.
- `appointmentVisitManaged.service.js:runDispatch` (257): accepted Meta receipt
  atomically merges into current Message metadata and only changes a still
  `sending` state to `pending`. It never clears a factual `sent_at`, regresses
  sent/delivered/read or overwrites concurrent status metadata. Accepted WAMID,
  including `held_for_quality_assessment`, reserves the intent without claiming
  effective send. `reuseMessage` waits without another transport until factual
  `sent_at`; actual JobRequest waiting settlement polls via its persisted due
  time, then uses that factual clock, not createdAt or acceptance time.
  The network-error path uses a separate atomic uncertainty merge guarded by
  the CURRENT exact Message/key/lease token and absence of any factual
  sent_at/sent-delivered-read/WAMID/provider-acceptance receipt. It does not
  write stale instance metadata. `reconcileDispatch` then reads the CURRENT SQL
  Message; factual acceptance wins, otherwise genuine uncertainty stays unknown.
- `whatsapp-provider-status.js:persistProviderStatus` (25) is extracted into
  the actual `queue.workers.js` status consumer (1922). A short READ COMMITTED
  Message row lock serializes metadata/state merges. A late valid provider
  `sent` timestamp fills a missing clock even after delivered/read without
  regressing status; malformed/nonfinite/nonpositive timestamps cannot become a
  send clock. No worker or webhook application was started in this work.
- `jobScheduler.service.js:handleCriticalTick` (420) calls bounded managed
  discovery on the **existing recurrent tick**, before its dispatcher/drain.
  CLOSED rollout or an empty registry returns before SQL. Discovery selects
  only revision1 pending unbound details intents for native singleton enrollments
  with the exact persisted namespace, reviewed manifest and valid enrollment
  hash; publication then repeats current graph/window/snapshot/HOLD/QA guards.
  A failure keeps durable evidence and does not prevent ordinary draining. This
  recovers commit→publication crashes without requiring another patient POST;
  already-bound execution/jobs use ordinary durable job discovery.
  Discovery advances a `(created_at DATE3,id)` keyset through a fixed high-water
  fence, at most25 candidates per default tick. Held/expired candidates advance
  the private cursor without changing their receipt; a finite subsequent sweep
  rechecks them. Concurrent ticks in one process share its in-flight page;
  independent processes still use the existing SQL publication locks/uniqueness.
  Restart loses only ephemeral scan progress, begins another finite sweep and
  never assigns a new window, namespace or communication right.

Foundation additions in this cut are `bindExecution`, completion of an existing
execution-only binding with the same Message, real branded claim capture,
`prepareDispatch`/`failBeforeNetwork` and optional server-owned namespace in the
enrollment compiler. Both existing migration/model ledgers remain additive and
contain no send/enqueue/adoption side effects.

### Reproducible, owned-only verification

```sh
PLATFORM_AUDIT_FIXTURE_EXPORT= CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 APPOINTMENT_VISIT_CONSUMERS_MYSQL_TEST=1 node --test src/scripts/tests/appointment_visit_consumers_mysql.integration.test.js
PLATFORM_AUDIT_FIXTURE_EXPORT= CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/appointment_visit_runtime_mysql.integration.js
PLATFORM_AUDIT_FIXTURE_EXPORT= CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/appointment_visit_communications_mysql.integration.js
```

Actual consumer SQL passed in
`/tmp/cc-campaign-opt-mysql-Af2OXw/result.json`: MySQL8.0.42, clean shutdown0,
rejected external sockets0, 65 owned loopback POSTs, nine **fake** provider
attempts across positive/held/unknown/retry/interleaving/recovery scenarios.
There was no real provider attempt, real patient mutation or live DB connection.
Four first POSTs race and four exact transport retries share one canonical
appointment/receipt/Visit/intent/execution/job; hash drift to an eligible alternate
machine fails409 and rolls back, while refreshed alternate-machine preview and
inherited effective attention reproduce the saved SQL receipt on exact replay.
The extended correction cases additionally interleave actual `sent`, `delivered`
and `read` webhook persistence just before the network-error SQL uncertainty
write. Its CURRENT guards preserve factual status/clock/history metadata;
reconciliation reads that current Message and reserves accepted, with no second
transport. The no-receipt network ambiguity case still preserves unknown.
Fourteen naturally expired and14 future HOLD receipts precede a later eligible
birth: bounded25 keyset/high-water pages, concurrent ticks and a service restart
reach one execution/job, leave all blocked windows/snapshots/history unchanged,
then reconsider a released HOLD at its **same** original window. CLOSED recovery
still performs zero SQL; discovery itself creates no Message/provider attempt.

The fixture uses actual controller/command/SQL solver/models, native runtime,
flow, JobRequest claim/handler and scheduler tick/settlement, common sender,
broker and extracted webhook status persistence. Its explicit seams are
synthetic ACL/capabilities, ancillary UI/clinical summaries, controlled postcommit
crash/publication, manually invoked owned job/tick and fake broker transport.
It does **not** bootstrap Express/session middleware, real workers/timers,
Redis/provider configuration, the complete webhook intake pipeline or other
clinical consumers. A factual send receipt in the positive-flow case is placed
explicitly on the owned row; separate actual extracted status-consumer cases
prove delivered-before-sent, nonfinite clock refusal and SQL acceptance-write
interleaving. Simulation is not substituted for these actual target consumers.

Core runtime SQL also passed in `/tmp/cc-campaign-opt-mysql-gE6vnb/result.json`;
foundation/PRP/released-import SQL rerun passed in
`/tmp/cc-campaign-opt-mysql-vN02VM/result.json`, each shutdown0 and zero external
sockets/providers. The scoped offline foundation/guard/broker/import suite
passed107/107; extracted status helper2/2; existing scheduler orchestration1/1;
the combined correction rerun passed110/110 with zero skips.
`git diff --check` passed. These are evidence for this closed cut, not deployed
schema, real template review or whole-system activation.

### Exact gaps and minimum eventual rollout boundary

- Native durable wait freeze, ACK/timeout semantic claims and inbound owner
  receipts exist in the bridge API, but **are not wired into** real
  `delay/wait_response`, inbound selection/consumption, pending-reply recovery
  or per-purpose continuation. Existing global newest-wait replacement cannot
  be used as a managed cross-purpose cancellation policy. No real response wait
  graph is in the registry and no response ownership/recovered-reply proof is
  claimed by the consumer fixture.
- Real reminder scheduler/day-before/same-day and consent/email graphs have no
  managed adapter here. Created-template review is not proof that all clinically
  required scheduled/consent consumers are covered. Do not enroll a production
  graph/policy that requires those omitted purposes, or remove an existing
  reminder/consent obligation to fit this cut. Unsupported graphs stay legacy
  **unenrolled**; already enrolled rows stay fail-closed, never fallback.
- Generic edit/move/status/cancel/support/delete commands are not connected to
  a durable mutation-event ledger or per-purpose invalidation/cancellation.
  Changed fresh snapshots already block stale sending. Explicit revision>1
  publication returns `visit_mutation_adapter_required`; it does not fabricate a
  new details window from `updated_at`. Purpose `cancelIntent` is real, but does
  not establish full endpoint cancellation/wait/reply behavior.
- Fair discovery now advances bounded keyset/high-water pages and reconsiders
  blocked rows next sweep; the old first25 starvation defect is corrected and
  verified with28 invalid predecessors, concurrency/restart and HOLD release.
  Operational recovery still requires the existing scheduler to remain alive
  long enough to finish pages; perpetual process restarts or database outages
  cannot promise progress. No durable delivery authority is derived from the
  ephemeral cursor, and namespace-less history remains excluded.
- Real out-of-order status persistence and acceptance interleaving are covered;
  complete webhook ingress/identity/account/reception pipeline and autonomous
  delivery-process crash/status recovery still require consumer-level review.
  Unknown is preserved, not automatically retried or presented as success.
- PRP/import/historical appointments, existing singleton history, vouchers/
  programs, QA/HOLD/provisional/source-tagged bookings are excluded from native
  autoenrollment. Historical PRP pairs with accepted/unknown/waits require a
  separate reviewed adoption/history ledger, not group inference by date,
  patient name, telephone or matching treatment label. Never delete/reassign
  old communications or create multiple CitaPaciente rows for this objective.

The smallest eventual rollout is an explicitly reviewed clinic/graph/namespace
cohort of **new native one-Cita fully verified v4 multi-step singletons**, after
all applicable clinical/reminder/consent/mutation
obligations for that cohort are implemented and reviewed. Keep the registry and
flag closed until independent diff review and owned SQL reproduction pass; no
activation, rollout, deploy, commit or full-goal completion is asserted here.

### 2026-10-07 — Factual status clock through the encrypted inbox

The independent OWNED pipeline reproduction found that encrypted capture kept
the original Meta status timestamp, but `whatsappInboxImport.normalize` discarded
it. `importLease` then committed `status=sent` without `sent_at`, so the actual
managed flow correctly waited for a factual clock forever. This cut fixes that
specific consumer boundary, not the outstanding purpose waits/inbound/mutation
adapters above.

Changed production paths are only `src/lib/whatsappInboxImport.js` and
`src/lib/whatsapp-provider-status.js`. No broker package, public intake, scope
routing, workers, scheduler, ledger, migration, flag or manifest is changed.

- The normalizer retains the original provider seconds string. If present it
  must contain 1–12 decimal digits, represent an instant from 2000-01-01 through
  five minutes beyond the current import clock, and fit a safe integer.
  A **new** sent receipt without a valid factual timestamp is retained as
  `review_required`, without SQL status/clock changes, receipt or ACK. Delivered,
  read and failed may omit their timestamp; none can create an effective-send
  clock. No fallback to import time, `createdAt`, delivered/read or retry time.
- Replay still validates the complete envelope's current WABA, receiving phone
  and WhatsApp product ownership before checking the receipt. A matching receipt
  also requires its original digest, clinic and phone. Exact already-imported
  receipts return their committed import receipt without reprocessing clocks or
  reopening history, even if the prior sent event lacked its clock. Changing
  WABA/phone/clinic/digest never authorizes replay or ACK.
- The existing importer query retains clinic/channel/outbound/WAMID ownership
  and unique-match checks and now selects CURRENT metadata and `sent_at` under
  its existing SQL row lock. A shared pure `projectProviderStatus` computes the
  non-regressing state, history/metadata merge and factual sent clock for both
  real SQL adapters. The ORM webhook preserves its existing state ordering;
  the importer explicitly preserves its existing recoverable-failed policy.
  An empty later error list does not erase earlier error evidence.
- The importer updates status and CURRENT metadata/history in its **existing
  raw-connection transaction**. `sent_at=COALESCE(sent_at, factualSentAt)` retains
  any existing DB clock exactly and fills only a missing clock from sent. A late
  sent after delivered/read can fill that clock without regressing status.
  It never opens a second independent transaction. Receipt insertion and the
  final fresh `validateScope` check remain in that transaction; commit precedes
  the real `pollOnce` confirmation call. Scope drift rolls back both clock/state
  and receipt.

The opt-in test is
`src/scripts/tests/whatsapp_inbox_status_clock_mysql.integration.test.js`:

```bash
PLATFORM_AUDIT_FIXTURE_EXPORT= CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 WHATSAPP_INBOX_STATUS_CLOCK_MYSQL_TEST=1 /home/ubuntu/.nvm/versions/node/v24.8.0/bin/node --test src/scripts/tests/whatsapp_inbox_status_clock_mysql.integration.test.js
```

OWNED SQL+encrypted SQLite passed in
`/tmp/cc-campaign-opt-mysql-lEc38P/result.json`: MySQL 8.0.42, clean shutdown 0,
external sockets 0, one owned booking POST and one fake provider attempt. The
real cipher/HMAC capture, `pollOnce`, raw-connection `importLease`, actual
managed flow and JobRequest handler prove early sent-before-WAMID is deferred
without ACK, survives encrypted inbox restart, and later commits its exact
provider clock before confirmation. The actual flow then completes, while a
dispatch retry reserves the accepted same Message with no second transport.
Further SQL cases cover delivered/read before sent, duplicate receipt/history,
invalid/missing/nonfinite/future clocks held without mutation/ACK, foreign scope
including already-imported replay, real HMAC/foreign-account capture denials,
ambiguous WAMID refusal, final-scope rollback, concurrent importer
connections, a real ORM webhook started after the importer Message row lock,
failure/error evidence preservation and historical receipt replay without clock
repair. Existing passive importer and multiclinic routing SQL passed in
`/tmp/cc-campaign-opt-mysql-o93F21/result.json` and
`/tmp/cc-campaign-opt-mysql-dRUbY8/result.json`, each shutdown 0/external sockets 0.
The actual managed consumer regression also passed in
`/tmp/cc-campaign-opt-mysql-4prJJT/result.json` (65 owned POSTs/nine fake attempts),
including accepted/unknown preservation, CURRENT webhook interleavings and fair
bounded postcommit recovery. Scoped inbox/status offline tests passed 19/19 and
the foundation/guards/broker/operations regression passed 111/111, no skips.
Independent readonly reproduction also passed in
`/tmp/cc-campaign-opt-mysql-HvBFBB/result.json`, with SQL 8.0.42, shutdown 0,
external sockets 0 and one fake attempt. It rechecked exact-receipt scope replay,
encrypted capture/poll/import/actual flow completion, clock before ACK, late sent
after an advanced status and concurrent importer/ORM consumers without edits.

These tests use the actual target consumers and encrypted store, but an explicit
in-process fixture client replaces private inbox transport authentication/TLS;
there is no KMS/AWS, external Meta intake, app/session bootstrap, Redis, running
worker or real provider. Positive HMAC/cipher execution is not proof of public
gateway authorization or deployed reception health. No process configuration
or production registry was activated.

Known pipeline boundaries remain explicit: historical already-imported
clockless rows are not silently reopened or repaired; they need separately
authorized source-preserving reconciliation. This does not repair the legacy
Bull early-WAMID/no-match path. Shared-phone multiclinic routing can still defer
an unresolved early status as generic review with its existing 24-hour delay,
not the single-clinic unmatched-status retry; routing/review semantics were not
changed. Full authenticated intake, account ownership/operational deployment and
the real purpose response/reminder/move adapters remain outside this cut.

## Operational handoff — legacy confirmation incident, 2026-10-07

This incident was an integration regression, not an intentional appointment
restriction, MFA failure or Meta rejection. With the experimental visits rollout
closed and its tables not installed, `assertMutationNode` still queried
`AppointmentVisitMembers` for unenrolled legacy executions. The first WhatsApp
could be accepted, then `action/change_status` failed before `wait_response`.
Consequently a later confirmation had no live wait to resume: neither its state
change nor its acknowledgment ran.

Fix `7575e89f36b410994c612da1b91c65ffc4c8d4a4`, published to DEV and the CRM
staging worker, limits the existing `uninstalledClosed` compatibility boundary
to genuinely unenrolled legacy executions with the rollout closed and a missing
table. Enrolled/lost-binding executions, an open rollout and other SQL errors
remain fail-closed. No experimental schema, permission relaxation, authentication
bypass or consent activation was performed. Gateway was not fully promoted.
Regression coverage: `appointment_visit_uninstalled_mutation.test.js` and
`appointment_visit_mutations_mysql.integration.test.js` with a fake provider.

BS Medical (72), Madrid date 7 October: 44 affected executions, 40 appointments,
35 patients. Of these, 43 first notices were accepted by the provider; one of
those later became undeliverable (Meta 131026). One administrative-error execution
was silent. These are not 43 confirmed patients. Five rate-limited failures and
one phone/conversation mismatch were separate findings, not repaired by this cut.

Carlos explicitly authorized reviewed recovery on 7 October. At 11:28 UTC:
19 original executions completed through 19 native staging jobs, with 11 states
`recordatorio_confirmado` and 8 `info_confirmada`. Nine missing acknowledgments
were delivered; ten were omitted/suppressed because reception had already
answered afterwards. All 19 original notices were unchanged and unique;
appointment fields other than status and update audit were unchanged. No consent
dispatch. No additional missing-table failures found after the published fix.

Recovery did not replay entry nodes, triggers, AI, initial notices or timeout
nudges. It pinned the original execution/template/node/delivery key, reviewed
actual text responses and current geometry, checked patient/clinic identity,
active jobs, linkage, revocation, already processed acknowledgment and every
reachable repair branch, then atomically restored that execution at a terminal
confirmation/acknowledgment path and queued its native job. The ordinary worker
retained claims, canonical state mutation, transport idempotency, human-reply
suppression and provider checks. A single pilot completed before the batch.
33 operator safety assertions passed before writes. No browser tokens were used.

25 executions were deliberately not reopened: nine without a response, six with
ambiguous/other-appointment or corrected-hour evidence, three cancelled/no-show,
four superseded time/duration snapshots, one with a later change request, one
undeliverable and the silent administrative execution. They remain terminal;
publication alone does not restore their waits. Any later reconciliation needs
fresh evidence and authorization; never bulk-restart these executions at entry
or schedule overdue nudges automatically.

Private source snapshots, per-execution receipts, manifest digests, exclusion
reasons, native job IDs and verified message/status results:
`/home/ubuntu/qa-evidence/linked-visits-20261007-gdqsK1/recovery-final.json`,
`recovery-results.json`, `recovery-reviewed-manifest.json`, `recovery-*.receipt.json`.
Do not copy patient data, transport secrets or raw context into Git or prompts.

Follow-up audit, not completed by this recovery: test all three real legacy
template families with optional visits tables absent, from first-send through
state/wait/response/acknowledgment; test each optional-feature closed boundary;
review the six distinct provider/identity failures and whether the nine unanswered
legacy waits need a separately scoped, no-first-send/no-overdue-nudge repair.
