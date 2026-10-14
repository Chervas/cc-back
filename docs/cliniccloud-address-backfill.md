# ClinicCloud: address normalization from retained import evidence

This is a one-off administrative backfill, not a patient reimport. The existing
patient form already reads these canonical fields. No application deployment,
worker, message, reminder, appointment, membership or clinical-record change is
needed to make the addresses visible.

## Scope and selection

Only source account `cliniccloud-5880`, group 29, clinics 66/72. Only the five
nullable columns `Pacientes.direccion`, `codigo_postal`, `poblacion`, `provincia`
and `pais` may change. Nonempty canonical values remain byte-for-byte unchanged.
Patients must have an authorized primary clinic or actual membership. The
source's clinic, contact ID, history number, key, version, date and fingerprint
must agree. A conflicting identity, ambiguous history or conflicting canonical
component holds the whole patient for review; there is no name/phone fallback.

The newest address-containing source is selected as a complete tuple, never
assembled from several exports. Explicit blank cells in a newer export suppress
older values. Identity-only snapshots do not erase addresses. Same-date address
conflicts are held. Supported evidence:

- Original `contacto_1.csv` / `cliniccloud_raw_contact:<ID>` archive.
- `cliniccloud_contact_snapshot`, exact account and snapshot version.
- `BACKUP_CONTACTOS_YYYY-MM-DD.csv`, exact account, archive version, date and key.
- Retained contact-ID markers/aliases are ownership evidence, not addresses.

Normalization is limited to trimming and Unicode NFC, with CRLF normalization;
source capitalization and postal leading zeroes are preserved. Invalid types,
HTML, control bytes and overlong values are rejected rather than truncated. A
country must be explicit text. This operator has **no numeric-country mapping**:
unknown `idPais` values never imply España. Missing source components stay empty.

## Operator workflow

Run from the canonical, committed `/home/ubuntu/wt/back-dev` branch `dev`.
Credentials come from the existing explicit operator SDK; never start the app or
copy CRM credentials into DEV. Prepared plans pin the committed code, database
identity, exact source capture, scope and five-field allowlist. Plans expire
after two hours. All evidence is written exclusively, mode 0600, and fsynced
under a private mode-0700 directory inside `/home/ubuntu/secure-imports`.

```sh
node src/scripts/cliniccloud-backfill-addresses.js --mode prepare --target crm --outdir /absolute/private/new-run
node src/scripts/cliniccloud-backfill-addresses.js --mode apply --target crm --outdir /absolute/private/new-run --plan /absolute/private/new-run/plan.json --approve EXACT_ENVELOPE_SHA256
node src/scripts/cliniccloud-backfill-addresses.js --mode verify --target crm --outdir /absolute/private/new-run --plan /absolute/private/new-run/plan.json
```

Preparation and verification use real read-only transactions. Apply takes an
operator advisory lock and an InnoDB transaction, locks the clinical scope,
patients, memberships and minimal source/identity evidence, then rebuilds the
entire plan. Any drift aborts before DML. No table may have triggers; schema,
database identity and InnoDB engines are checked again. SQL projects only
address/identity aliases; complete source contacts and clinical notes never
leave MySQL. Bounded, materialized projections avoid repeatedly parsing large
historical JSON wrappers.

Before the first UPDATE, the callback creates a checksummed **field-level
before-image backup**, verifies its bytes by readback, and fsyncs an intent
journal. This targeted DML has no triggers or DDL, so a field backup is safer to
restore and much smaller than restoring unrelated CRM data. The backup records
the old five values, identity, original timestamp, memberships, source proof and
exact intended after-address for every affected patient.

Bulk UPDATEs (up to 500 patients per statement) assign only approved five-column
values; ELSE preserves other cells and `updatedAt=updatedAt` preserves the
timestamp. Every statement's row count is checked. The complete minimal
after-capture must match the exact expected capture, and replanning must produce
zero further operations. All statements commit **once, atomically**, not one
transaction per batch. Error before commit rolls back. A durable result follows
commit and a separate read-only verification follows that result.

DEV has no BS clinics 66/72 or group 29 as of the October 14 preflight. It is
therefore not a data target. Do not create fake memberships or bypass the scope
guard to make that environment pass. Code can be synchronized to dev/staging
without changing DEV data or restarting either application.

## Interrupted run and conditional restoration

Never blindly rerun `apply` after a timeout, disconnection or missing receipt.
The durable intent may precede a successful commit. Compare the current capture
with the pinned before/after hashes using read-only diagnostics. Exact after
means committed; exact before means no changes. Any other result needs a new
review, not an automatic retry. Used run directories are deliberately rejected.

There is no automatic destructive rollback command. To restore a reviewed
before-image, use a separately reviewed transaction that locks the same patient
and proves its current identity, memberships, five address values and timestamp
still equal the intended after-image. Only then restore those five cells. If a
human has edited any value since, hold that patient. Never restore the complete
database, delete source archives, rewrite history numbers or overwrite later
edits to undo this backfill.

## Tests

`node --test src/scripts/tests/cliniccloud_address_backfill.test.js` tests pure
selection and strict proof validation. The native MySQL integration script
creates its own fictitious database on an owned Unix socket with networking
disabled; it never connects to DEV or CRM. It checks actual five-column writes,
rollback, stale sources/manual edits/memberships, source preservation,
idempotence, schema/trigger rejection and bulk boundaries. Shut down its owned
server before removing only its explicitly validated temporary datadir.
