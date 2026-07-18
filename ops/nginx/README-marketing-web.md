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
2. Port 80 must serve the ACME challenge and a valid certificate must exist at
   the paths in the template.
3. The backend runtime behind `127.0.0.1:3001` must include the hosted-origin
   middleware and the exact `POST /_clinicaclick/intake` and
   `POST /_clinicaclick/events` routes. Nginx keeps the ordinary hosted origin
   at 16 KiB and grants the event bridge 80 KiB so its validated 64 KiB
   canonical payload plus wrapper can cross the edge.
4. `/var/lib/clinicaclick-web-hosting` must be owned by the backend service
   user and must not be under a public document root.
5. `MARKETING_WEB_PUBLISHING_ENABLED`, signing keys, immutable artifact
   storage and `MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY` must be configured. A
   hosted pilot also needs its scope in `MARKETING_WEB_PUBLISHING_SCOPES`;
   staging currently limits publishing to `group:5`, but that permission does
   not make the hosted hostname operational.
6. Re-download the official Cloudflare IPv4/IPv6 lists and compare them with
   the real-IP snippet before every rollout. `CF-Connecting-IP` is trusted only
   from those direct peers; direct requests cannot select their own patient IP.

Validate with `nginx -t`, then test a disposable publication, its CSP, a native
form submission, an event relay (chat/teléfono/WhatsApp), health readback and
rollback before enabling customer scope.
Custom domains remain fail-closed until ownership, routing and a valid TLS
certificate have all been verified; never add a catch-all TLS vhost for them.
