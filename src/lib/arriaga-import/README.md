# Arriaga Excel import

Operator-only adapter for the reviewed Arriaga export, group 28 and clinics 1/70.
Patient and activity payloads remain in a private directory outside Git.

The signed bundle contains all master patients, reviewed identity aliases, only
eligible clinical activity, and inactive draft treatments. Unmarked activity
belongs to Arenal (70). Patient names without a unique source identity are never
created from an activity row. Native appointments, signed encounters, payments,
vouchers, notifications and consent evidence are not manufactured.

`src/scripts/arriaga-import.js --mode plan --target crm --bundle <private.json>
--out <private-directory>` captures the target backup and a source-bound plan.
`--mode apply` requires the same code, bundle and target snapshot. It journals
allocated IDs before commit and rolls back on any invariant failure. Never
repeat an uncertain apply: use `--mode verify` and reconcile the receipt first.

History numbers are unique at `group:28`; source numbers are preserved in the
import identities, and genuine number collisions receive new native numbers.
Profiles with a verified source registration date retain it. The non-null native
registration field otherwise records the ClinicaClick import date, explicitly
distinguished in the import event metadata from an unknown original date.

Every identity remains on communications hold. The native historical reader
checks patient, clinic, source instance and source key, and exposes only the
filtered dated service evidence. Source rows and file hashes remain traceable.

Tests cover identity/clinic/source guards, exclusion rules, number allocation,
rollback, replay and tampering. MySQL integration uses only fictional data in
connection-local temporary DEV tables, never production or real patient rows.

## Site attribution correction (2026-11-16)

The signed 2026-10-26 bundle remains unchanged. Its unmarked activity was assigned
Arenal, including records belonging to people with explicit AJU activity. The
reviewed repair policy inherits AJU only when it is the person's unique explicit
site in the eligible source activity. Both explicit sites remain unchanged for
review; no explicit site retains the Arenal default. Future preparation must use
`site-attribution-repair.deriveSiteAttributions` before signing a new bundle.

`src/scripts/arriaga-site-attribution-repair.js` accepts `plan`, `apply`, `verify`,
an explicit target and the original signed bundle. The private plan binds the
current target, source code, source bundle, complete affected before-state and a
gzip backup. `apply` requires `--approve-plan` with its exact
`operatorPlanSha256`; ROOT applies only after independent review and after the
related outbound queues have been held.

The operator moves only derived source clinic/identity/envelope fields to the
existing AJU identity. It preserves source keys, row/file/bundle hashes, dates,
services, original identity rows and communication HOLDs. Each affected patient
gets an append-only operational audit with before/after attribution hashes,
reason and plan reference. Full before/after envelopes remain in the private
backup and pre-commit journal. No appointment, provider, campaign item, sent
snapshot, opt-out, price or clinical text is changed.

Native care/financial dependencies keep their current primary clinic for review.
Historical conversations, marketing rows and opt-outs retain Arenal membership as
secondary where needed for historical access; this retention does not assert care
in Arenal. Membership is removed only when no such dependency remains. History
numbers retain `group:28`; they are not renumbered.

A pre-commit failure rolls back all materializations and audit entries together.
An uncertain commit must be verified with the pinned plan, never blindly replayed;
same-plan replay verifies the audited after-state and performs zero writes. A
later legitimate change is never reset. A committed rollback requires separate
review of the private before-state and later dependencies. Do not restore source
rows or delete audit history automatically.

The original import verifier intentionally rejects this corrected materialization
against its old immutable interpretation. Use the repair verifier after correction;
do not re-import or re-sign the original source bundle to erase the correction.
