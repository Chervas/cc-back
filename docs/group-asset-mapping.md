# Group Asset → Clinic Mapping

## Overview

Groups can now map the same marketing asset to multiple clinics without duplicating the underlying record. This applies to:

- Meta ad accounts
- Google Ads accounts
- Meta assets (Facebook pages / Instagram business accounts)
- Google properties (Search Console, Analytics, Business Profile)

Assignments are stored in the `GroupAssetClinicAssignments` table and are served to the frontend through `getGroupConfig`.

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

### Group configuration (`groupAssets.service.js`)

- `getGroupConfig` now enriches each asset/ad account with `assignedClinicIds`.
- `_updateMetaAssignments`, `_updateGoogleAssignments`, `_updateMetaAdAccounts` and `_updateGoogleAdAccounts` write to `GroupAssetClinicAssignments` when operating in clinic mode.
- Switching a section to group mode clears any per-clinic assignments for that asset type.
- Automatic Ads attribution clears Meta/Google ad-account assignments for the group.

### Frontend (`list.component.ts/.html`)

- The selector for clinics shows any asset/ad account surfaced for the group, allowing the same resource to be picked by several clinics.
- Summary cards list shared assets multiple times (one entry per clinic) so the UI reflects compounded assignments.

## Compatibility Notes

- The legacy `clinicaId` column is still populated with the *primary* clinic (first in the assignment list) to keep existing jobs and reports working.
- Backfill / sync jobs continue to run once per distinct asset/account; clinic-level splits rely on delimiters or mapping logic already in place.
- Future jobs that need explicit multi-clinic context can query `GroupAssetClinicAssignments`.
