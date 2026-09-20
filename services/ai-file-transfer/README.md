# Temporary AI file delivery

This independent Node 18+ daemon runs on the CRM host. Application workers upload
through a private Unix socket; providers download directly through a dedicated
HTTPS reverse-proxy route. AWS receives only a signed typed reference, never PDF,
image or audio bytes. It does not download the file itself.

The issuer creates 256-bit opaque capabilities, stores only their hashes and
expires them after five minutes. The client revokes in `finally`, including
provider failures. A failed revoke never retries an accepted AI operation; expiry
and cleanup still apply. A capability authorizes read access to one immutable
copy; keep it out of UI, telemetry, access/error logs and public storage. Anyone
holding an unexpired capability can read that copy within its download budget.

Run one daemon per environment, with a dedicated OS identity, state directory,
Unix socket, fixed loopback port and HTTPS origin. Only authorized application
identities may reach the socket. Application ACLs and the AI pause are checked
before minting. The AWS binding pins the origin; the descriptor also binds the
environment, request UUID and use case. No inline-file fallback is accepted.

Limits: 32 MiB per file, eight live transfers, 128 MiB total disk reservations,
four active downloads, sixteen GET/HEAD requests and three file sizes of reserved
download bytes per capability. Downloads stream in 64 KiB chunks and time out
after 30 seconds or expiry. Incomplete uploads reserve capacity immediately and
are erased on failure. Cleanup runs every ten seconds; expiry is enforced on
every read even before cleanup. A fixed listener prevents duplicate recovery.

Configuration (private JSON, owner root or service, mode 0600):

```json
{"version":1,"environment":"staging","origin":"https://crm.clinicaclick.com","directory":"/var/lib/clinicaclick-ai-files-staging","controlSocket":"/run/clinicaclick-ai-files-staging/control.sock","controlGroupId":1000,"port":3098}
```

Start with `node services/ai-file-transfer/src/main.js /absolute/config.json`.
The socket parent must belong to the daemon and forbid group write and all other
access. Its group needs execute access for authorized clients. The state directory
must be owned by the daemon, mode 0700. The package has no external dependencies;
include `services/integrations-broker/src/ai-file-reference.js` alongside it.

Client configuration is a separate mode-0600 JSON file selected by
`AI_FILE_TRANSFER_CONFIG_FILE`:

```json
{"version":1,"environment":"staging","origin":"https://crm.clinicaclick.com","controlSocket":"/run/clinicaclick-ai-files-staging/control.sock","serverUid":1234}
```

Replace the illustrative UID with the actual service UID. The client verifies
socket ownership and response metadata. DEV must have distinct paths, identity
and origin and must not belong to the staging socket group.

Reverse proxy only `/api/ai-file-transfers/v1/` to the loopback download listener.
Disable access **and error** logs for this location, response buffering, cache,
request buffering and proxy retries. Do not forward cookies or authorization.
Allow only GET/HEAD; never expose `/v1/transfers` or `/v1/status` control endpoints.
HTTP must reject capability paths without redirects or logging. Bound the process
with systemd memory, CPU, tasks and file limits; the staging preparation uses
MemoryMax=256M, MemoryHigh=192M, CPUQuota=50%, TasksMax=32 and LimitNOFILE=256.

Tests: `node --test services/ai-file-transfer/test/*.test.js` from repository root.
Tests use fictitious documents, local HTTP/Unix listeners and no provider keys.
Real provider/UI verification remains a separate rollout requirement. Installing
this daemon alone does not enable any application AI broker flag.
