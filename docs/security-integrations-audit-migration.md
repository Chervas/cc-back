# Runbook: Migracion Segura De Integraciones Y Auditoria

Fecha: 2026-09-12. **Procedimiento pendiente de ejecucion**, no acta de migracion terminada.

Contrato e inventario AWS canonicamente documentados en el repositorio frontend:
`src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md`.
En este servidor: `/home/ubuntu/wt/front-dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md`.
Este runbook concreta orden, pruebas, publicacion y rollback; no duplica el manifiesto de recursos.

Prompt versionado: [instrucciones para el Codex delegado](./security-integrations-migration-codex-prompt.md).
Los recuentos de commits pendientes del apartado 5 son la foto previa al corte
completo a DEV autorizado despues por el usuario el 12/09. Recalcularlos al
retomar; esa autorizacion puntual no permite publicar nuevo trabajo ajeno.

## Estado de implementación inicial (12/09/2026)

Recibidos propuesta, plantilla y manifiesto final en
`docs/security/provisioning/received-2026-09-12`, con hashes; son evidencia
reportada, no verificación AWS. Matriz actual y diferencias de IAM/red/Budget
en `docs/security/implementation-status.md`. Inventario y cohortes en ese
directorio. El manifiesto final todavía declara varios IDs no capturados.

Existe el paquete `services/integrations-broker` y el transporte backend
`src/lib/integrationsBrokerClient.js`, probados offline. Solo hay proveedor
ficticio ejecutable. Colector de costes separado, caché, job diario con gate
apagado y UI implementados con QA ficticia; su
[contrato y lote de activación](../services/aws-cost-collector/README.md)
mantienen pendientes verificación AWS, migración compartida y despliegue.
Ninguna cohorte real ni auditoría completa
de plataforma, cifrado de BD o despliegue se consideran terminados.

BD: [diagnóstico y remediación preparada](./security/database-encryption-remediation.md).
Diez consultas reales de metadata por UNIX, sin filas clínicas: redo/undo/binlog
nativos apagados, transporte seguro no exigido y cuatro consultas denegadas.
Volumen/tablespaces/backups siguen sin acreditarse. TLS de clientes preparado
sin activar; restauración física cifrada solo con datos y claves ficticios.
Credencial incrustada retirada del código legacy; rotación real pendiente.

## 1. Entrada Y Limites

Leer `00-handoff-operativo`, `19-estado-actual`, `39`, `25-operacion-worktrees-entornos`, `30-despliegues-y-entornos` y `31-roadmap-arquitectura-entornos-gateway` en `front-dev/src/Documentacion`. Completar con `02`, `03`, `04`, `05`, `07`, `11`, `14.1`, `20.13` y `32` segun la fase. `25-desarrollo-paralelo` es un alias historico, no otro workflow.

Leer los handoffs de incidente de `/home/ubuntu/incident-handoff/`, en particular `meta-2026-09-11-prompt.md`, `meta-2026-09-12-asset-stats-remediation.md` y `meta-2026-09-12-token-lifecycle-audit.md`. Conservar originales y evidencia. No convertir esta tarea en otra investigacion activa sobre Meta.

No reutilizar autorizaciones de sesiones anteriores para probar proveedores. No usar ni renovar el token Meta invalidado, OAuth, credenciales alternativas, CAPI, WhatsApp o escrituras de publicidad para QA. No modificar campanas, presupuestos, anuncios, conversiones, SES, pagos ni planes. Nuevas operaciones externas necesitan alcance concreto aprobado.

Se permite desarrollar y verificar con datos ficticios. Antes de mover secretos reales, modificar IAM/red/retencion, ejecutar migraciones en BD compartida o desplegar sobre runtimes usados, presentar lote exacto, impacto, pruebas y rollback para aprobarlo. No pedir permiso rutinariamente para cada archivo o test offline.

## 2. Inventario Local Y Puntos De Integracion

| Area | Puntos de entrada verificados en el repositorio; ampliar con busqueda local |
|---|---|
| Meta HTTP y salud | `src/lib/metaClient.js`, `metaBatch.js`, `oauthConnectionHealth.js` |
| Google HTTP | `src/lib/googleAdsClient.js`; localizar todos los clientes Google adicionales |
| OAuth y WhatsApp | `src/routes/oauth.routes.js`, `whatsapp-embedded.routes.js` |
| Modelos de credenciales | `models/MetaConecction.js` (nombre real), `ClinicMetaAsset.js`, `googleconnection.js`, `googleconnectionassignment.js` |
| Hotfix que se debe conservar | `src/controllers/socialstats.controller.js` |
| Jobs | `src/config/scheduledJobCatalog.js`, `src/jobs/sync.jobs.js`, `src/services/jobExecutor.service.js` |
| Descubrimiento externo | `src/scripts/push_ops_global_discovery.js`; encontrar una URL de OPS no autoriza acceder a ese sistema |
| Costes existentes | `src/routes/metasync.routes.js`, `src/controllers/metasync.jobs.controller.js`, `src/services/aiRuntimeMonitoring.service.js` |
| UI de costes | Frontend `src/app/modules/admin/pages/settings/jobs-monitoring/` y `settings.component.*` |
| Contrato de campanas a preservar | `docs/campaign-workspace-implementation.md`; no desarrollar el plan gestionado |

Mapear tambien helpers legacy, SDK, batch, callbacks, webhooks, publicacion social, Lead Ads, formularios, CAPI, Google enhanced conversions, llamadas de plugins/CMS, diagnosticos, cron/colas, CI y copias operativas expresamente autorizadas. No basta con cambiar `metaClient` y `googleAdsClient`.

Inventario de cada consumidor: archivo/runtime/entorno, tipo y referencia de credencial, proveedor/App ID, operaciones, activo/scope, entrada/salida y plan de corte. Metadatos o huellas privadas solo si son necesarias; nunca imprimir secretos. No iniciar la app ni importar su bootstrap para leer la DB.

## 3. Fases Y Puertas De Salida

### A. Aceptar La Entrega Y Preparar El Cambio

1. Verificar rutas, ramas, cambios locales y procesos sin volcar `.env`, `pm2 jlist` completo ni `/proc/*/environ`. Preservar flags de pausa y hotfix antes de tocar despliegues.
2. Recibir plantilla y manifiesto final del aprovisionador. Con acceso AWS asignado, validar identidad y metadata de los recursos del contrato `39`, no de toda la cuenta indiscriminadamente. No recrear el stack por su `UPDATE_ROLLBACK_COMPLETE`.
3. Documentar lo que falta: runtime/deployer/cost role, red, dos KMS de integraciones, Cost Explorer/tags, retencion, drift del Budget y acceso SSO de relevo. Sin permisos AWS se puede avanzar en codigo offline; marcar bloqueado solo el corte dependiente.
4. Definir una politica operativa versionada: catalogo de operaciones, permisos por consumidor, secreto/activo permitido, quotas, estados bloqueados y matriz de auditoria. No desplegar una funcion generica de proxy.
5. Decidir alojamiento del codigo del broker. Preferir paquete/directorio autocontenido con artefacto y dependencias propios, sin importar el arranque ni modelos clinicos del backend. No crear otro repo/remoto por iniciativa propia. Separar identidad de despliegue de identidad de la API antigua.

Salida: inventario, diagrama textual de confianza, matriz de pruebas y plan por cohortes. Indicar riesgos residuales de una instancia y de un backend comprometido que conserve permisos para operar.

### B. Implementar Y Probar Sin Credenciales Reales

1. Broker con esquema de peticiones cerrado, autenticacion entre servicios, autorizacion de activos, timeout, rate limit, idempotencia, trazas saneadas y estados bloqueados persistentes. Separar rutas de lectura y mutacion por permisos independientes.
2. Adaptador de almacen de secretos/referencias, cache limitada y borrado de cache al bloquear/rotar; cifrado envelope solo con SDK/primitivas mantenidos y politica independiente. El broker no devuelve el token, ni siquiera en errores.
3. Adaptadores del backend preservando los contratos actuales. Migraciones de referencias aditivas y reversibles a nivel de esquema, primero solo contra BD de prueba aislada. No borrar columnas ni importar datos reales todavia.
4. OAuth/webhooks: definir el recorrido de intercambio, firma y almacenamiento dentro del limite de confianza. No dejar app secrets en el gateway por olvido; conservar validacion de firma con bytes originales y anticlonado de entregas. Probar con fixtures, no OAuth real.
5. Emisor de auditoria durable, consumidor externo y lector paginado con ACL. Instrumentar auth/permisos y matriz priorizada de actividad; declarar explicitamente endpoints pendientes. No atribuir retrospectivamente identidades que los logs antiguos no guardaron.
6. Colector de costes con cache persistente, tags/metricas/currency explicitos y refresco diario del catalogo existente con `Europe/Madrid`. Una peticion de UI no lanza una consulta AWS. No despausar el cron global para probar un nuevo job.

Salida: tests locales sin red de proveedores, migraciones en BD ficticia, builds y evidencias de UX. La ausencia de Meta real se muestra como bloqueo real, nunca como conexion saludable simulada.

### C. Desplegar El Broker Con Ficticios

Tras aprobar destino y despliegue, construir un artefacto versionado, desplegar por la identidad dedicada y verificar unicamente operaciones ficticias permitidas. No transferir credenciales de SSO al runtime. No ejecutar `set -x`, registrar secretos en UserData ni usar parametros CLI que expongan su contenido.

Verificar TLS, identidades, acceso cruzado denegado, permisos AWS efectivos, stdout/errors saneados y recuperacion tras reinicio. Comparar flags antes/despues. Probar escritura y lectura de auditoria ficticia, entrega durable, duplicate/retry, fallo de destino y alerta de backlog. Cualquier prueba de borrado se limita a recursos de prueba identificados y autorizados; no tocar evidencias del incidente.

Salida: manifiesto de version/roles/configuracion no secreta, pruebas efectivas diferenciadas de simulaciones, sin proveedor real activado.

### D. Migracion Aprobada Por Cohortes

1. Presentar lista de conexiones/consumidores, referencias objetivo, respaldo restringido, cambios de esquema, tiempos, corte de writers y rollback. No incluir Meta bloqueado como candidato activo. No llevar tokens bajo investigacion al almacen operativo; preservar evidencia aparte si corresponde.
2. Compatibilizar todos los runtimes con BD compartida: DEV, staging, gateway, cron, colas y scripts autorizados. No retirar campos antiguos mientras un consumidor dependa de ellos.
3. Copiar solo secretos expresamente autorizados mediante proceso protegido y trazable, sin stdout/argumentos visibles; no renombrar el fichero ficticio para usarlo con tokens reales. Validar integridad local y mapeos sin exponer valores.
4. Migrar lectura primero y sin mutaciones del proveedor; documentar las consultas reales permitidas. Activaciones, escrituras, recepcion y renovacion tienen su propia aprobacion y tests. Un GET que revoca o cambia estado sigue siendo mutacion.
5. Cambiar una fuente activa por cohorte; no doble publicacion, dobles conversiones ni fallback a valores de DB. Gestionar comandos en vuelo y reintentos con idempotencia y receipt del proveedor cuando exista.
6. Verificar cohortes y despues retirar la capacidad de lectura/uso de secretos del runtime antiguo, segun plan aprobado. Limpiar almacenamiento/cache/backups operativos de forma compatible con preservacion forense y retencion; no afirmar que desaparecieron copias ajenas.

Salida: tabla por consumidor `migrado / bloqueado / pendiente`, campos legacy retirados o pendientes justificados, sin ampliar permisos del producto. Reiniciar no debe reactivar ningun proveedor bloqueado.

### E. Auditoria Completa Y Cifrado De BD

Completar las categorias de auditoria de `39`, pruebas end-to-end y visor de acceso restringido. Implementar politica de retencion confirmada por DPD/usuario; mantener una lista explicita de decisiones pendientes. No afirmar cobertura completa con solo logins y llamadas AWS.

El cifrado requiere antes un diagnostico de topologia/metadata. Preparar remediacion con restauracion ensayada y costes. La migracion de datos reales, adquisicion de recursos y cambios irreversibles de retencion requieren aprobacion separada; no incorporarlos ocultamente al despliegue de un adaptador.

## 4. Matriz Minima De QA

| Prueba | Evidencia exigida |
|---|---|
| Fuga original | `getAssetStats`: anonimo denegado, scope ajeno denegado, autorizado sin secretos; preservar sus pruebas existentes |
| Serializacion | Sentinel ficticio ausente de respuestas, errores, trazas, URLs, cache y bundles |
| Aislamiento | Consumidor sin permisos de leer/descifrar secretos, administrar el broker o usar otra conexion/activo; separar simulador de prueba efectiva |
| Broker | Operacion/host/redireccion/payload no permitidos denegados; identidad falsa, replay y scope cruzado denegados |
| Ciclo de vida | Renovacion concurrente controlada con mocks, bloqueo durable tras reinicio, no fallback a token invalidado |
| Contratos | Lecturas y errores compatibles; webhooks firmados ficticios; idempotencia de formularios/conversiones sin envios reales |
| Jobs | Pausas/gates previos preservados, unico leader y timezone Madrid, ningun resume accidental |
| Auditoria | Login exitoso/fallido, lectura, cambio, permiso y exportacion sinteticos trazables hasta almacen externo; actor correcto y campos sensibles ausentes |
| Fallos de auditoria | Caida, reintento, backlog y duplicado verificables; politica de bloqueo/degradacion documentada |
| Retencion | Roles diferenciados, integridad, fechas/zonas y recuperacion; datos ficticios para pruebas activas, no evidencia real |
| Costes | ACL, paginacion, cache sobre reload, dato atrasado/no disponible distinto de cero, moneda y no doble conteo de IA |
| UX | Chromium desktop y movil: login QA autorizado, costes/auditoria legibles, sin datos clinicos en capturas; no usar perfil personal del PC |
| BD | Metadata y TLS, migracion aislada, restauracion y dependencias de KMS documentadas; datos reales solo con aprobacion |
| Rollback | Reversion de version/configuracion sin reaparecer tokens en API, ni activar Meta o jobs pausados |

Hay tests `src/scripts/tests/social_asset_stats_security.test.js` y `social_asset_stats_mysql.integration.js`. Leer fixtures y variables antes de ejecutarlos; MySQL de integracion debe ser efimero y ficticio, nunca la BD compartida. No usar suites que arranquen workers o accedan a proveedores por efectos de importacion. No desactivar guards de red para poner pruebas en verde.

## 5. Commits Y Push Sin Arrastrar Publicidad

Estado observado al preparar este handoff: backend `dev` 46 commits por delante de `origin/dev`; frontend `dev` 35 por delante. Ambos tienen cambios sin commit de campanas, seguridad y documentacion. Es una foto local de refs, no del remoto actualizado; repetir comprobacion al iniciar.

**Un `git push origin dev` publicaria todos sus ancestros pendientes. Seleccionar archivos al hacer commit no evita eso.** No ejecutar `git add .`, `git add -A`, `commit -am`, force push, `reset --hard`, limpieza ni restauraciones de cambios ajenos.

1. Inventariar `git status --short --branch`, HEAD, upstream y diff propio con datos sensibles saneados. Coordinar la propiedad de archivos compartidos antes de editar clientes, controladores, jobs, entornos y documentos que otro Codex este tocando.
2. Trabajar y commitear primero en DEV, como establece el runbook de worktrees. Preparar commits pequenos por fase con archivos/hunks propios revisados. Si un archivo contiene trabajo ajeno, no incluirlo completo; no tocar un indice ya preparado por otra tarea sin coordinarlo.
3. Con acceso Git autorizado: `git fetch origin`, revisar `git rev-list --left-right --count origin/dev...HEAD` y `git log --oneline origin/dev..HEAD` por repositorio. No hacer `pull` ciego. No mostrar remotos con credenciales embebidas.
4. Antes del push, el rango completo a publicar debe contener solo cambios de esta tarea y dependencias explicitamente aprobadas. Si aparecen commits ajenos, NO publicar la rama DEV completa.
5. Para un corte aislado, coordinar un worktree temporal limpio basado en `origin/dev`, con una rama temporal solo de transporte. Aplicar los commits propios y dependencias aprobadas, resolver sin alterar DEV ajeno y repetir QA sobre ese candidato. No usarlo para mantener otra linea de desarrollo permanente. Si necesita campanas no publicadas, pedir coordinacion; no quitar dependencias para forzar el push.
6. Solo con rango revisado, pruebas correctas y contrato de API compatible: publicar por fast-forward a `dev` (`git push origin HEAD:dev` desde el candidato correcto). Si se rechaza por cambios remotos, actualizar el candidato y repetir revision/pruebas, nunca forzar. No crear remotos ni publicar a `main`.
7. Verificar SHA remoto y comunicar commits exactos, repositorios, pruebas y si realmente se hizo push. Mantener los worktrees canonicos y cambios ajenos intactos; la reconciliacion de sus ramas se coordina con su responsable, no con un reset automatico.

Si no existe un candidato aislable o falta permiso de push, entregar commits/patch acotados y dependencia pendiente. No declarar publicado algo que solo esta local. El prompt/handoff bajo `/home/ubuntu/incident-handoff` no esta dentro del repo: no hacer `git add` de toda esa carpeta; los contratos versionables viven en los repositorios.

## 6. Despliegue Y Rollback

Push a DEV no es despliegue ni permiso para promover todo a staging. Antes de desplegar, acordar commits exactos, migraciones concretas, respaldo, canary, flags y servicios a reiniciar. No copiar recetas generales de `merge origin/dev`, `npm install` o `db:migrate` que ejecuten todos los cambios pendientes.

- DEV backend: `/home/ubuntu/wt/back-dev`, `pm2-back-dev`, puerto `3004`.
- Staging backend: `/home/ubuntu/wt/back-staging`, `pm2-back-staging`, puerto `3001`.
- Gateway: `/home/ubuntu/wt/gateway`, `pm2-gateway`, puerto `3000`; entradas externas OAuth/webhooks y sin jobs de negocio propios.
- Preview frontend: `cc-front-preview-4203` sirve `/home/ubuntu/www/front-dev-preview`; fuente `/home/ubuntu/wt/front-dev`. Seguir `30` para build y `/home/ubuntu/scripts/cc-front-preview-sync.sh`, no arrancar otro ng serve que sustituya el preview.

Los overrides PM2 de DEV mantienen JobRequests, cron, resume y gates de campanas pausados; staging/WhatsApp no estan globalmente pausados. Leer valores permitidos actuales, preservarlos en reinicios y no equiparar pausa de desarrollo a contencion total. No ejecutar reparaciones de Propdental ya realizadas.

Hotfix `socialstats.controller.js` de 12/09/2026 ya aplicado localmente a DEV/staging/gateway. Preservarlo e integrarlo en el corte aprobado; una promocion que lo pierda reabre la brecha. Su SHA historico esta en el acta de seguridad, no usarlo para deshacer mejoras posteriores legitimas.

Rollback: volver al artefacto seguro anterior del broker/adaptador, o detener solo la cohorte afectada y conservar lecturas de cache con estado obsoleto explicito. Nunca reabrir el endpoint vulnerable, restaurar tokens revocados, devolver tokens al front o recuperar escrituras desde DB como fallback. Preservar auditoria, comandos pendientes e idempotencia.

Cerrar actualizando contrato `39`, docs afectados, `19` y `99`; API primero en `src/Documentacion/13-backend.md`, despues espejo frontend. Entregar al Codex de publicidad solo cambios de contrato necesarios, errores/flags nuevos, rutas y estado de proveedores, sin secretos.
