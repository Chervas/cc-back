# ClinicaClick – Google Ads API Standard Access design

> **Runtime clarification — 2026-07-18:** `guided_improvement` starts at Qualified Lead when the authorized strategy is activated and can promote to Schedule automatically by reusing the initial client mandate. `managed_service` retains operator approval for later promotions.

**Company:** Mod Marketing / ClinicaClick

**MCC (manager) ID:** 286-322-4233

**Contact:** google-ads-api@modmarketing.net / carlos.hervas@modmarketing.net

**Use case:** Healthcare marketing platform for clinics. ClinicaClick links customer accounts, reads campaign/reporting data, provisions its own canonical conversion actions, measures consented first-party lead milestones and applies a narrowly scoped goal policy only to cohorts covered by an explicit client mandate (`guided_improvement`) or an approved managed campaign (`managed_service`).

This document describes the current contract. Detailed event transport lives in
[`google-data-manager-conversions.md`](./google-data-manager-conversions.md) and
the scoped goal contract in
[`google-ads-goal-policy-v4.md`](./google-ads-goal-policy-v4.md).

## 1. Architecture and provider boundaries

- **Frontend (Angular):** account connection, campaign onboarding, web/consent configuration, reporting and managed-campaign administration.
- **Backend (Node.js/Express + MySQL):** resolves tenant scope, OAuth connection, manager/customer account mapping, canonical conversion destinations, attribution, deduplication and audit.
- **Google Ads API:** account/campaign/reporting reads, canonical `ConversionAction` provisioning and the explicit custom-goal executor for `guided_improvement` and `managed_service`. Campaign publishing remains dry-run; there is no general executor that creates, pauses or changes budgets/creatives.
- **Google Data Manager API:** current transport for click-derived server-side conversion events. It replaces `ConversionUploadService` for this event path and processes accepted requests asynchronously through Diagnostics.
- **Intake/CRM:** forms, calls, chat and appointment lifecycle produce Lead, Contact, Qualified Lead, Schedule and Purchase milestones. Meta CAPI is an independent destination; Google events are not a blind mirror of Meta events.

## 2. Data flow

1. An authorized user links Google through OAuth. The connection must contain the `adwords` and `datamanager` scopes and be mapped to the same clinic/group scope as the selected customer account.
2. ClinicaClick reads account/campaign inventory and maps each external campaign using the full provider + account + campaign identity.
3. `intake.js` and the CRM create idempotent milestones with attribution. A configured `customer_id`, campaign association or destination key selects exactly one allowed conversion destination.
4. The backend uploads the event with a stable transaction ID, a permitted `gclid`/`gbraid`/`wbraid` when present, and/or allowlisted Enhanced user data when expressly authorized.
5. Data Manager returns synchronous acceptance; the durable `google_data_manager_diagnostics` `JobRequest` retrieves the final asynchronous result every 30 minutes and links its `SyncLog`.
6. Reporting combines Ads metrics with ClinicaClick's audited CRM milestones. An accepted HTTP response is never presented as proof of final attribution.

## 3. Canonical conversion actions

ClinicaClick uses these exact canonical actions per customer account:

- `Lead - ClinicaClick`
- `Contact - ClinicaClick`
- `Qualified Lead - ClinicaClick`
- `Schedule - ClinicaClick`
- `Purchase - ClinicaClick`

New actions are `UPLOAD_CLICKS`, `MANY_PER_CLICK`, `ENABLED` and globally secondary (`primary_for_goal=false`). Provisioning is read-only by default and only creates a missing canonical action when both `create_missing=true` and `confirm_external_mutation=true` are supplied. It never deletes, disables or silently rewrites customer actions.

Data Manager transports events but does not create conversion actions. The Google Ads API remains responsible for provisioning and, under the scoped policies described below, custom goals.

## 4. Values and optimization semantics

The versioned default policy uses:

| Event | Value | Meaning |
|---|---:|---|
| Lead | 0 EUR | Observation |
| Contact | 0 EUR | Observation |
| Qualified Lead | 10 EUR | Relative optimization/reporting weight |
| Schedule | 40 EUR | Relative optimization/reporting weight for an appointment scheduled and linked to the lead; not necessarily confirmed or attended |
| Purchase | Disabled in Propdental | Current code can derive catalog `precio_base`/`0`; this is not accepted/paid revenue and cannot be a bidding value |

The `10/40` values are not revenue, price, margin or ROAS and do not authorize `Maximize Conversion Value`. Qualified Lead is the initial bidding signal for both scoped optimization modes; Schedule requires later lifecycle evidence. Purchase must remain disabled until CRM persists an authoritative accepted/paid amount or margin with sufficient coverage; the treatment catalog price does not satisfy that contract.

## 5. Consent, Enhanced conversions and healthcare restrictions

The standard offline path can upload a permitted click identifier without PII. Enhanced conversions are separately allowlisted for Propdental customer accounts `1851215478` and `5992356722` and for Lead, Contact, Qualified Lead and Schedule only.

- Only normalized email and phone hashes (SHA-256 HEX) may be included.
- `ad_user_data` must be explicitly `GRANTED` before user data is sent.
- `ad_personalization` reflects the visitor's actual choice and is not forced. A complete marketing rejection skips the upload rather than creating an artificial PII-less request only to send `DENIED`.
- Frontend consent v4 presents both choices under the understandable **Marketing** category, while the backend retains and validates the two signals independently.
- Name, address, URL, clinic, treatment, consultation reason, clinical data, IP, user agent and arbitrary session/user properties are never used as Enhanced identifiers.
- No Customer Match, conversion-based lists, healthcare audiences or remarketing are enabled by this capability.

On 2026-07-13 a direct Google read confirmed accepted data terms and `enhanced_conversions_for_leads_enabled=true` for both Propdental accounts, and Data Manager accepted `validateOnly` for each account. After the live Web verification at `09:38:42 UTC`, the internal reconciler returned `already_active`, `ready=true`, was idempotent and reported `google_ads_mutated=false`. The reconciler only updates the scoped `IntakeConfig`; it does not mutate the Google switch and does not depend on Play.

## 6. Scoped goal policy

Canonical actions stay globally secondary. For an authorized Google Search/PMax cohort, the v4 executor may create and assign an immutable custom goal for exactly one account, cohort and lifecycle stage:

`qualified_lead → schedule → purchase`

In **Mejora** (`guided_improvement`), activating an eligible strategy after the client has accepted the versioned three-scope mandate creates the policy directly in `qualified_lead` and enqueues a durable apply. Measurement and conversion readiness are activation gates; there is no persisted `measurement → qualified_lead` promotion for this mode. The executor uses a current preview digest, `validateOnly`, a drift check, apply and healthy readback. Once active, the daily evaluator can promote `qualified_lead → schedule` after the configured thresholds and two passing evaluations separated by at least 24 hours. The provider job reuses the initial client authorization, records `initial_authorization_reused=true` and does not require a second client action or an operator approval.

In **Piloto automático** (`managed_service`), the initial Qualified Lead apply continues to require persisted admin approval. Later lifecycle promotions remain operator-controlled: a ready evaluation does not by itself authorize the managed provider mutation.

The shared evaluator now builds the Schedule weekly series from the effective appointment date in `CitasPacientes.inicio`; unresolved appointment evidence fails closed. `connect_only`, observe-mode managed campaigns and Smart campaigns never reach the executor.

## 7. Current rollout scope

- Manager account: `2863224233`.
- Propdental customer accounts: `1851215478` and `5992356722`.
- Both accounts have accepted data terms and have Enhanced conversions for leads enabled.
- Lead, Contact, Qualified Lead and Schedule are configured with explicit per-account destinations; Purchase remains outside Enhanced and requires a reliable CRM value/event.
- The current milestone service can build Purchase from a completed appointment with treatment and `Tratamientos.precio_base` (or `0`). Propdental keeps the event disabled because that value is neither authoritative revenue nor margin.
- Current Propdental managed-campaign snapshot remains `draft + observe + unfunded`; no active managed pilot or applied optimization policy is implied by conversion readiness.
- Call reporting is disabled for both accounts by advertiser decision; historical call actions/assets are not deleted and `AD_CALL` is not part of the Clinicaclick custom goal.
- The first natural paid lead, `LeadIntake #7193` for Badalona `58`, produced Contact attempt `#10` for customer `1851215478` / action `7680195323`. With consent `GRANTED` and a GCLID, it moved from `accepted` to `SUCCESS`; Diagnostics returned one record, no warnings/errors and no duplicate. It was GCLID-only because it predated the ownership fix, so a later natural consented lead is still required to evidence Enhanced identifiers.
- Staging backend `323e4a4` and frontend `a1c875ea` passed the live ownership regression at `09:38:42 UTC`: clicking Verify left the protected fingerprint `a04c971…044b` unchanged and only updated `snippet_verification.verified_at`. Enhanced/user-data/personalization capabilities, values `0/0/10/40` and disabled Purchase were preserved. The public config omitted attestations, verification hash, HMAC, Enhanced config, `goal_policy` and audits.
- The global `visitor_choice` reconciliation scanned 18 configurations: 17 `activated`, 1 `already_active`, 0 errors and `grants_consent=false`. Capability materialization never grants visitor consent.

## 8. Security, access and audit

- OAuth tokens are encrypted at rest and revocation is honored.
- Customer IDs and action resources are resolved from server-side mappings; browser overrides are rejected.
- Multi-destination events fail closed when selection is ambiguous.
- Click identifiers are stored only as hashes in upload audit; raw Enhanced PII is never stored in that audit.
- Every external goal mutation requires explicit authority and deterministic audit evidence. Scheduled diagnostics and daily drift checks are read-only and do not autorepair Google state.

## 9. Capability limits

- Search and Performance Max have a deterministic publishing dry-run adapter, not a general execution adapter.
- Display/Meta publishing is not claimed as operational.
- Standard Access does not authorize cross-tenant account discovery or mutation.
- Conversion readiness alone does not authorize changing campaign bidding goals. The narrow authority comes from the accepted `guided_improvement` mandate or the approved `managed_service` goal-policy gate.
