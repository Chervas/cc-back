# Group Asset → Clinic Mapping

> **Canonical product contract (2026-07-15):** a provider connection is authorized once for a business scope. Every module serving a clinic must resolve the same effective asset, regardless of whether the mapping was opened from Clinics, Settings, Campaigns or Reports. Module-local connections/mappings are not allowed.

## Overview

Groups can now map the same marketing asset to multiple clinics without duplicating the underlying record. This applies to:

- Meta ad accounts
- Google Ads accounts
- Meta assets (Facebook pages / Instagram business accounts)
- Google properties (Search Console, Analytics, Business Profile)

Assignments are stored in the `GroupAssetClinicAssignments` table and are served to the frontend through `getGroupConfig`.

This table describes **asset assignment**, not the OAuth grant itself and not campaign-to-strategy attribution. Keep the layers separate:

- `GoogleConnectionAssignments` / `MetaConnectionAssignments`: which clinic/group can use the technical grant;
- provider asset models: the discovered/mapped account, page, property or location;
- `GroupAssetClinicAssignments`: which clinics consume a shared group asset;
- `ExternalCampaignAssignments`: which marketing strategy owns the results of an external campaign.

Linking an external campaign never creates the ad-account mapping. A shared ad account can remain connected in Reports even when some campaigns are still unassigned to a strategy.

```
id                     SERIAL PRIMARY KEY
grupoClinicaId         INTEGER (FK -> GruposClinicas.id_grupo)
assetType              VARCHAR(64)       -- e.g. meta.ad_account, google.analytics
assetId                INTEGER           -- ID in the original asset table
clinicaId              INTEGER (FK -> Clinicas.id_clinica)
created_at / updated_at TIMESTAMP
```

`assetType` values currently in use:

| Asset type key            | Source model                 |
|---------------------------|------------------------------|
| `meta.ad_account`         | `ClinicMetaAssets`           |
| `meta.facebook_page`      | `ClinicMetaAssets`           |
| `meta.instagram_business` | `ClinicMetaAssets`           |
| `google.ads_account`      | `ClinicGoogleAdsAccounts`    |
| `google.search_console`   | `ClinicWebAssets`            |
| `google.analytics`        | `ClinicAnalyticsProperties`  |
| `google.business_profile` | `ClinicBusinessLocations`    |

During the migration we back-fill the table from the existing `clinicaId` / `grupoClinicaId` fields so all current assignments remain intact.

## Behaviour

### Effective-asset read contract

For a clinic reader:

1. resolve the scoped provider connection with `scopeConnectionResolver.service.js`: a clinic that belongs to a group uses the group assignment first and a compatible legacy clinic assignment may be promoted to that shared scope; an ungrouped clinic uses its clinic assignment;
2. include active clinic-owned mappings;
3. include active group mappings inherited by the clinic;
4. include explicit rows in `GroupAssetClinicAssignments` for that clinic where the vertical uses the join table;
5. select the configured asset from that valid inventory, otherwise use the vertical's canonical precedence;
6. expose the assignment origin so the UI can distinguish `clinic`, `group/shared` and explicit assignment.

The `clinic > shared > group` precedence applies to the **asset/mapping selection**, not to the OAuth grant. Do not document or implement a clinic OAuth override over the group grant unless the canonical connection resolver is deliberately changed.

Do not implement this as `WHERE clinicaId = selectedClinicId`. Shared records may retain a compatibility `clinicaId` pointing at another/primary clinic. Reuse `scopeConnectionResolver.service.js`, `effectiveMarketingAssets.service.js`, `clinicScope.js` or the canonical vertical resolver.

`connected`, `sync` and `has_data` are independent. A mapped shared asset is still connected when its backfill is pending, the last job failed, or the selected date range contains no metrics.

### Group configuration (`groupAssets.service.js`)

- `getGroupConfig` now enriches each asset/ad account with `assignedClinicIds`.
- `_updateMetaAssignments`, `_updateGoogleAssignments`, `_updateMetaAdAccounts` and `_updateGoogleAdAccounts` write to `GroupAssetClinicAssignments` when operating in clinic mode.
- Switching a section to group mode clears any per-clinic assignments for that asset type.
- Automatic Ads attribution clears Meta/Google ad-account assignments for the group.

### Frontend (`list.component.ts/.html`)

- The selector for clinics shows any asset/ad account surfaced for the group, allowing the same resource to be picked by several clinics.
- Summary cards list shared assets multiple times (one entry per clinic) so the UI reflects compounded assignments.

## Compatibility Notes

- The legacy `clinicaId` column is still populated with the *primary* clinic (first in the assignment list). It is a compatibility hint, not the full assignment and not proof that other clinics are disconnected.
- Backfill / sync jobs continue to run once per distinct asset/account; clinic-level splits rely on delimiters or mapping logic already in place.
- Readers that need explicit multi-clinic context must query `GroupAssetClinicAssignments` when that vertical writes it; new code must not assume future migration will repair a clinic-only filter.
- `effectiveMarketingAssets.service.js` now exposes a read-only effective inventory for Google Ads, Meta Ads, Facebook, Instagram, Search Console, Analytics and Business Profile. Marketing Reports consumes it for clinic, group and multi-clinic scopes. Other jobs/readers may still use dedicated vertical resolvers and must be audited independently rather than assumed compliant.
- Reports keeps Ads metrics on their persisted attribution scope so a later mapping change does not rewrite history. For owner-centric shared sources, group/multi-clinic reports select one canonical mapping per remote identity to avoid summing duplicate copies; Search Console must filter by the exact physical-owner + `site_url` pair.

## Google Business Profile review alias

The reviews-only alias in `Clinicas.configuracion.reviews.google_business_profile_alias_*` is deliberately outside general asset assignment. It lets one clinic use another real location's `url_dejar_resena` without cloning `ClinicBusinessLocations`.

It must only affect review-purpose status/sends and `review_profile_alias_*` trace metadata. It must not change the clinic's assigned Business Profile, local metrics, location/directions, Campaigns local asset or Reports source status.

The contextual mapping UI must call
`POST /oauth/google/local/map-locations` with `mapping_purpose=reviews`.
That operation accepts exactly one target clinic and one already mapped active
location, validates source/target access and same-group scope, then updates only
the review alias. It must not change `ClinicBusinessLocations.clinica_id`.
`GET /oauth/google/local/mappings?mapping_purpose=reviews&clinic_id=<id>`
returns the effective review selection so the dialog can preselect it.
