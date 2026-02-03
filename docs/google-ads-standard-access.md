# ClinicaClick – Google Ads API Standard Access Design Doc (Draft)

**Company:** Mod Marketing / ClinicaClick  
**MCC (manager) ID:** 286-322-4233  
**Contact:** google-ads-api@modmarketing.net (or carlos.hervas@modmarketing.net)  
**Use case:** Healthcare marketing platform for clinics. We run and optimize Google Ads campaigns (Search / PMax / Display) and ingest leads from web, Meta Lead Ads, and WhatsApp. We send server-side conversions (lead, contact, schedule, purchase) for attribution and optimization.

## 1. Architecture Overview
- **Frontend (Angular):** Admin UI for clinics. Modules for Accounts, Campaigns, Web/Snippet, and Reporting.
- **Backend (Node.js/Express + MySQL):**
  - OAuth Google (scopes include `adwords`) for account linking.
  - Google Ads client used for:
    - Fetching accounts, campaigns, ad groups, ads, and performance metrics.
    - Creating/ managing campaigns (Search, Performance Max, Display).
    - Creating conversion actions (Lead, Purchase) per client.
    - Sending server-to-server conversions (enhanced conversions, gclid/gbraid/wbraid).
  - Intake pipeline: `/api/intake/leads` and `/api/intake/events` receive web/Meta leads; dedupe, hash PII, and store attribution.
  - CAPI Meta already active; Google Ads conversions will mirror the same events.
- **Data flow (high level):**
  1) User links Google account (OAuth) → store access/refresh + scopes.
  2) Map the customer account (185-121-5478 and others) to clinic(s).
  3) Snippet `intake.js` on client sites captures forms/click-to-call/chat → POST to backend.
  4) Backend creates Lead, then fires conversions:
     - `Lead` (form submit), `Contact` (call/chat), `Schedule` (appointment), `Purchase` (treatment value).
     - Meta CAPI and Google Ads API (ConversionUploadService) with hashed PII and gclid/gbraid/wbraid when present.
  5) Reporting panels pull Ads performance + conversion stats for clinics.

## 2. API Endpoints (Google Ads)
- Campaign management: list/create campaigns, budgets, ad groups, ads (Search/PMax/Display).
- Conversion actions: create “Lead – ClinicaClick” and “Purchase – ClinicaClick” per account.
- Conversion uploads: server-side uploads with enhanced conversions data (hashed email/phone, external_id).
- Reporting: daily/periodic metrics (cost, clicks, impressions, conversions, conv value, CPA/ROAS).

## 3. Data & Privacy
- PII (email, phone, external_id) hashed SHA-256 before upload.
- gclid/gbraid/wbraid passed when available; otherwise match on hashed PII + timestamp/IP/UA (when allowed).
- Tokens stored encrypted at rest; access restricted to service accounts.

## 4. Campaign Types Supported
- Search
- Performance Max
- Display
(Future: Video/Discovery as needed.)

## 5. Capabilities
- Account mapping and permissions.
- Campaign creation and management (budgets, geo, ads).
- Conversion action creation and server-side conversion uploads.
- Reporting and alerting (CPL/CPA health checks).

## 6. Users / Access
- External clients (clinics) and internal operators via the ClinicaClick platform (not a public tool).

## 7. Compliance
- Uses official OAuth with explicit scopes; respects rate limits and policy.
- No scraping; only Google Ads API and official endpoints.
- Honors user revocation; tokens can be revoked per clinic.

## 8. Rollout
- Start with MCC 286-322-4233 and customer 185-121-5478 (Propdental).
- Mirror Meta events into Google conversions for consistent attribution.

## 9. Manual conversion creation (while dev token is Basic)
- Account: 185-121-5478 (Propdental)
- Actions to create (Webpage):
  1) Lead – ClinicaClick  
     - Category: Lead  
     - Value: 0 (default), one-per-click, include in conv metrics, attribution Last Click (or DDA if available)  
  2) Purchase – ClinicaClick  
     - Category: Purchase  
     - Value: dynamic per event (leave default 0), one-per-click, include in conv metrics, attribution Last Click (or DDA)
- Capture after creation: Conversion Action ID/resource name (and `send_to`/label if gtag is generated) for backend/server-side uploads.

Labels confirmed (Propdental 185-121-5478):  
- Lead: AW-16577852979/hBIWCIL55vEbELPs9-A9  
- Purchase: AW-16577852979/a6hoCIaV5_EbELPs9-A9
