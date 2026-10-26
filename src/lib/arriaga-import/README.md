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
