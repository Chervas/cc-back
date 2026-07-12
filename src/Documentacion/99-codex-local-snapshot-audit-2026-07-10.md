# Auditoria de cambios locales y snapshots Codex - 2026-07-10

## Objetivo

Dejar todos los cambios locales relevantes empujados o inventariados para poder investigar un problema de recordatorios en staging con otra linea de Codex, sin contaminar `dev`, `staging` ni runtimes activos.

## Estado de runtimes activos

- `pm2-back-dev` ejecuta `/home/ubuntu/wt/back-dev`, rama `dev`. El ultimo commit de codigo previo a esta auditoria era `1980145`; el HEAD actual de `dev` pasa a ser `2ab3b45` por este documento.
- `pm2-front-dev` ejecuta `/home/ubuntu/wt/front-dev`, rama `dev`, commit `20a5e229`.
- `pm2-back-staging` ejecuta `/home/ubuntu/wt/back-staging`, rama `staging`, commit `2d1dcf6`.
- `pm2-gateway` ejecuta `/home/ubuntu/wt/gateway`, rama `staging`, commit local `84c3e79`.

Nota importante: `/home/ubuntu/backendclinicaclick` no sirve staging. Ese checkout estaba en detached HEAD y el proceso PM2 asociado (`clinicaclick-auth`) aparece parado.

## Ramas principales

- `/home/ubuntu/wt/front-dev`: limpio y alineado con `origin/dev` en `20a5e229`.
- `/home/ubuntu/wt/back-dev`: limpio y alineado con `origin/dev` en `2ab3b45` (`docs: audit local snapshots for staging reminder debug`).
- `/home/ubuntu/wt/front-staging`: limpio y alineado con `origin/staging` en `e87aa5ec`.
- `/home/ubuntu/wt/back-staging`: limpio y alineado con `origin/staging` en `2d1dcf6`.
- `/home/ubuntu/wt/gateway`: limpio, pero despues de `git fetch` queda 60 commits por detras de `origin/staging`. No se ha actualizado ni reiniciado para no tocar runtime de gateway mientras se investiga staging.

## Snapshots empujados

Se han creado ramas `codex/local-snapshot-*` para preservar cambios locales sin mezclarlos en ramas de producto:

- `cc-back`: `codex/local-snapshot-20260710-110734-backendclinicaclick`, commit `2158bad`.
  - Origen local: `/home/ubuntu/backendclinicaclick`.
  - Base previa: detached HEAD `742deda`.
  - Incluye cambios en `appointmentAutomationV2Runtime`, `automationsV2Resume`, `flowEngineV2`, `jobExecutor`, `jobRequests`, `whatsapp`, `queue.workers`, rutas/controlador de conversaciones, documentacion backend y scripts de push ops.
  - Excluido: `.env` y `logs/`.
- `cc-front`: `codex/local-snapshot-20260710-110734-frontend-clinicaclick`, commit `29a3c410`.
  - Origen local: `/home/ubuntu/frontend_clinicaclick`.
  - Incluye cambios de actividad/sesion auth.
  - Excluido: `src/assets/temp/` y `temp/`.
- `cc-back`: `codex/local-snapshot-20260710-110734-back-crm`, commit `fa32731`.
  - Origen local: `/home/ubuntu/wt/back-crm`.
  - Incluye `src/services/socket.service.js`.
- `cc-back`: `codex/local-snapshot-20260710-110734-back-personal`, commit `bc4d51f`.
  - Origen local: `/home/ubuntu/wt/back-personal`.
  - Incluye `src/services/jobRequests.service.js` y `src/services/socket.service.js`.
- `cc-front`: `codex/local-snapshot-20260710-110734-front-integracion-campaign-fix`, commit `875d8f83`.
  - Origen local: `/home/ubuntu/wt/front-integracion-campaign-fix-1773725081`.
  - Incluye cambios de campanas/leads en marketing.

## Cambios excluidos expresamente

No se han empujado:

- `/home/ubuntu/backendclinicaclick/.env`: contiene configuracion sensible.
- `/home/ubuntu/backendclinicaclick/logs/`: salida local.
- `/home/ubuntu/frontend_clinicaclick/src/assets/temp/`: assets temporales.
- `/home/ubuntu/frontend_clinicaclick/temp/`: temporales locales.

## Lectura para recordatorios en staging

- La investigacion de recordatorios en staging debe empezar por `/home/ubuntu/wt/back-staging`, porque es el cwd real de `pm2-back-staging`.
- No hay cambios sin commitear en `/home/ubuntu/wt/back-staging`.
- Los cambios recientes de frontend de tratamientos (`20a5e229`) estan en `origin/dev` de front, pero no estan promovidos a `origin/staging`; no deberian afectar staging salvo que se promocione dev.
- Los cambios backend de `origin/dev` posteriores a staging incluyen paneles, roles, quickchat y nutricion. Si el problema esta en recordatorios/colas, revisar especificamente diferencias en `appointmentAutomationV2Runtime.service.js`, `jobRequests.service.js`, `jobExecutor.service.js`, `queue.workers.js` y configuracion/PM2 de staging.
- El snapshot de `/home/ubuntu/backendclinicaclick` toca ficheros relacionados con automatizaciones y WhatsApp, pero no esta activo en staging. Sirve como referencia de trabajo local antiguo o paralelo, no como runtime actual.

## Vuelta atras

- Para revertir el ultimo cambio de tratamientos en front dev: `git -C /home/ubuntu/wt/front-dev revert 20a5e229 && git -C /home/ubuntu/wt/front-dev push origin dev`.
- Las ramas snapshot no afectan a `dev` ni `staging`. Para eliminarlas del remoto si se decide descartarlas: `git push origin --delete <rama-snapshot>`.
- No se ha hecho merge ni pull en `/home/ubuntu/wt/gateway`; si se decide actualizarlo, tratarlo como cambio de runtime separado con reinicio y logs.
