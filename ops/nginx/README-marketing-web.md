# Marketing Web origin

`sites.clinicaclick.com.conf` is the reviewed origin template for hosted Web
projects. It is not installed by a migration or application process. Install
`clinicaclick-cloudflare-real-ip.conf` as
`/etc/nginx/snippets/clinicaclick-cloudflare-real-ip.conf` at the same time;
otherwise all visitors can collapse into the Cloudflare edge IP for rate
limiting and audit evidence.

Preflight before enabling it:

1. `sites.clinicaclick.com` must resolve to this origin (or the Cloudflare
   proxy must reach it). As of 2026-07-18 it still resolves through Cloudflare
   to DonDominio parking and HTTPS returns 521; do not claim the hosted channel
   is available until the DNS record targets `51.44.225.192` and public
   readback succeeds.
2. For the first certificate, install only
   `sites.clinicaclick.com.acme.conf`, validate/reload Nginx and point DNS at
   the origin. Issue the certificate with the webroot
   `/var/www/letsencrypt`; ordinary requests intentionally receive `503` in
   this bootstrap phase. Once the certificate exists, replace that vhost with
   `sites.clinicaclick.com.conf`, validate/reload again and verify the HTTPS
   origin before enabling the application flag. This avoids installing a TLS
   configuration that references certificate files which do not yet exist.
3. The backend runtime behind `127.0.0.1:3001` must include the hosted-origin
   middleware and the exact `POST /_clinicaclick/intake` and
   `POST /_clinicaclick/events` routes. Nginx keeps the ordinary hosted origin
   at 16 KiB and grants the event bridge 80 KiB so its validated 64 KiB
   canonical payload plus wrapper can cross the edge.
4. `/var/lib/clinicaclick-web-hosting` must be owned by the backend service
   user and must not be under a public document root.
5. `MARKETING_WEB_PUBLISHING_ENABLED`, signing keys and the immutable artifact
   storage must be configured. A hosted pilot also requires
   `MARKETING_WEB_HOSTED_CHANNEL_ENABLED=true`, a safe
   `MARKETING_WEB_HOSTING_ROOT` and its scope in
   `MARKETING_WEB_PUBLISHING_SCOPES`; staging currently limits publishing to
   `group:5`, but that permission does not make the hosted hostname
   operational. The backend parses both Ed25519 keys and verifies that the
   public key is derived from the configured private key.
6. Re-download the official Cloudflare IPv4/IPv6 lists and compare them with
   the real-IP snippet before every rollout. `CF-Connecting-IP` is trusted only
   from those direct peers; direct requests cannot select their own patient IP.

Validate with `nginx -t`, then test a disposable publication, its CSP, a native
form submission, an event relay (chat/teléfono/WhatsApp), health readback and
rollback before enabling customer scope.
Custom domains remain fail-closed until ownership, routing and a valid TLS
certificate have all been verified; never add a catch-all TLS vhost for them.

The hosted origin verifies `manifest.json`, `manifest.sig.json`, Ed25519
signature, exact file set, hashes, sizes and pointer containment before serving
content. Ancestor/descendant routes on the same host are rejected. The hourly
health monitor only observes bundle + public marker and records
unhealthy/recovered transitions; it never republishes or rolls back. This
hardening is integrated in backend `dev` `4e4b555` and staging/live
`5e57431`; a
controlled monitor run checked one WordPress publication as healthy. It does
not make the hosted origin available: DNS still terminates at DonDominio/
Cloudflare 521 and hosted/custom remain disabled pending their own public E2E.

Renderer `clinicaclick-web-renderer/1.3.0` can include a global header/footer
on every page and a global intake form with a separate signed page contract per
route. That artifact shape is covered by the origin's existing exact-manifest
verification; it does **not** make this vhost operational. The WordPress-only
upgrade rule —keep a real `alpha.6` rollback including
`config/installation.php`, install the provisioned `alpha.7` ZIP, run
`CCW_Plugin::activate(false)` as the site owner and require DB=`alpha.7` before
publishing a global form; legacy documents and header/footer-only globals are
not blocked by that minimum— is already satisfied for the Propdental plugin,
but must not be misread as authorization to enable hosted/custom. Those
channels still require their own DNS/TLS/origin, relay/intake and rollback E2E.

The separate CRM edge route used by the live WordPress pilot is exact-match
`POST /_clinicaclick/events`, allows 80 KiB, replaces `X-Forwarded-For` with
`$remote_addr` and proxies to `127.0.0.1:3001`. It is not evidence that the
`sites.clinicaclick.com` vhost has been installed.
