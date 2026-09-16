# Runbook: Migración Segura De Integraciones Y Auditoría

> Guía de ejecución vigente, revisada el 13/09/2026 a las 22:25 UTC.
> Arquitectura y contrato de producto: frontend `39-seguridad-integraciones-cifrado-auditoria.md`.
> **Fuente de verdad:** ejecución de candidatos, QA, publicación y rollback; estado y prioridades en el manual central.
> **Relacionado con:** [00-README](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/00-README.md), [índice técnico](README.md#seguridad).

## Punto de partida operativo

Consultar [19: estado de seguridad](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones)
y [99: cortes públicos](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md).
El [acta técnica](security/admin-session-deployment-20260913.md) contiene
versiones, rama de gateway, pruebas, respaldos y rollback. Comprobar esos
datos antes del corte: publicar código no cambia el runtime ni sus pausas.

## Elegir el siguiente corte

### Preparar la identidad WhatsApp de DEV

El contrato de entornos está en [31](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md#identidad-whatsapp-de-dev).
Generar una clave Ed25519 propia en el directorio privado DEV; nunca copiar la
clave de staging. El broker acepta el principal opcional `dev:whatsapp` con
clave distinta y grants por clínica, conexión, teléfono y operación. Sin grants,
la identidad no permite consultar ni enviar. No retirar grants públicos al
incorporar DEV, ni concederle la operación de revocación de control.

En el servidor de la aplicación, publicar primero el adaptador compatible y
configurar `WHATSAPP_DEV_BROKER_ENABLED=true` y
`WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE=/etc/clinicaclick-whatsapp-authorized/dev/config.json`.
El arranque exige BD/colas DEV y workers/cron generales apagados. El firewall
solo añade salida a `13.39.100.55:8447`. El registro empieza sin bindings; una
prueba firmada contra una conexión sin grant debe devolver `scope_denied`.

Antes de añadir un número: completar OAuth nuevo si su token anterior fue
revocado, fijar clínicas y exclusiones, y conservar el control de bloqueos
persistentes. Añadir el grant DEV y el binding de su BD aislada como un corte
conjunto. La recepción pública conserva un único consumidor; una copia DEV no
puede volver a disparar automatizaciones. No declarar operativo el número hasta
probar envío manual, recepción, catálogo y adjuntos en ambos recorridos.

Rollback de esta base: retirar exclusivamente el principal/grants DEV y su
configuración, cerrar su salida de red y volver al release anterior. Conservar
el registro público, las autorizaciones y las claves idempotentes de staging.

El orden se mantiene en [16: prioridades](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/16-roadmap.md#seguridad-de-acceso-e-integraciones). Esta tabla localiza procedimientos.

| Trabajo | Guía y condición de salida |
| --- | --- |
| Mantener el acceso ya desplegado | [Contrato y conservación en promociones](security/admin-password-session-cut.md), [acta inicial](security/admin-session-deployment-20260913.md). Estado del login y cortes posteriores en 19/99. |
| Mantener MFA por correo | Verificar DDL/configuración antes de cada promoción; [dependencias](security/admin-password-session-cut.md#preparación-del-mfa-completo-y-pendientes-reales). El MFA público ya activo no requiere repetir su instalación. No usar el lote histórico completo Meta/Google por defecto. |
| Preparar/reconectar WhatsApp | [Recorrido gateway](security/whatsapp-onboarding-gateway.md), [condiciones de reconexión](security/whatsapp-reconnection-readiness.md). Aislar credenciales, validar proveedor/activos y recepción → cola → staging; permiso explícito antes de activar. |
| Retención, Budget, costes y cifrado | Inventario AWS y contrato 39, [matriz de aceptación AWS](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md#matriz-de-aceptacion-aws), fases C–E inferiores. No recrear recursos ni declarar controles reportados como verificados. |
| Continuar otra tarea de producto | [Relevo para importación](security/admin-session-deployment-20260913.md#continuidad-para-el-siguiente-codex). Código en DEV, QA de su dominio, sin promover o activar esta migración por arrastre. |

## Lista de ejecución por entrega

1. Leer el acta vigente y confirmar estado, HEAD/diff y propietarios de cambios.
   Inventariar consumidores, workers, permisos y tablas realmente afectados.
2. Definir candidato y dependencias desde una base concreta; código propio
   publicado en DEV, sin quitar dependencias para aparentar aislamiento.
3. Ejecutar QA del comportamiento, errores y rollback con proveedores ficticios.
   En auth: `npm run test:security:auth-cut` en backend y frontend, más MySQL y
   HTTP/Socket.IO/Chromium pertinentes. El modelo Sequelize del login debe ser
   real en la fixture, sin cargar modelos/BD de producción.
4. Antes de un corte real nuevo, presentar archivos/versiones, DDL exactas,
   configuración, permisos, coste, respaldo, ventana, prueba y rollback. La
   aprobación del corte de acceso anterior no habilita MFA ni proveedores.
5. Verificar hashes y flags, desplegar únicamente el candidato aprobado y
   comprobar cada entrada. No usar `--update-env`, migración global o promoción
   completa de DEV como atajo; cualquier cambio de configuración debe figurar
   en el lote. No restaurar JWT vulnerables o credenciales revocadas al revertir.
6. Publicar los commits propios, comprobar SHA remoto, documentar versión
   instalada y diferencias respecto de DEV. Actualizar contrato/API/estado,
   mantener evidencias privadas y entregar un handoff que no requiera el chat.

Para WhatsApp, el [runbook de reconexión](security/whatsapp-reconnection-readiness.md)
concentra ahora los prechecks de contención, DDL, slots, aislamiento, bandeja
cifrada y piloto. La prueba KMS/SQLite/S3 sintética no autoriza sustituir el
webhook 503 por un ACK 200 ni abrir consumidores. No aplicar sus propuestas IAM
pendientes como parte de un push de código.

## Esquema de seguridad y publicación entre entornos

El contrato `ops/security/schema-contract.json` fija las tablas, columnas,
collations, índices y migraciones que necesita esta capa de código. Se actualiza
junto a las migraciones revisadas, nunca copiando automáticamente lo que haya en
la BD. Admite tablas y columnas adicionales de otros módulos. La validación no
certifica todos los módulos ni sustituye QA funcional, claves, permisos o flags.
Los hashes corresponden a los archivos revisados del candidato: `SequelizeMeta`
histórico solo guarda nombres y no acredita el hash que se ejecutó en el pasado.

Antes de publicar DEV, el publicador aislado ejecuta esta comprobación sobre la
release candidata **antes de parar el servicio o cambiar el enlace**. Si falta
DDL, conserva el runtime anterior y deja la release fallida para inspección.
Para staging/gateway ejecutar el mismo preflight como paso obligatorio del corte,
con `--source` apuntando al candidato que se va a publicar. Es de solo lectura;
no instala automáticamente migraciones en la BD clínica. Ejecutar desde un
checkout que ya tenga esta herramienta:

```bash
sudo /usr/bin/node src/scripts/security-schema-release.js check --runtime staging --source /ruta/absoluta/candidato --out /ruta/privada/preflight-staging.json
sudo /usr/bin/node src/scripts/security-schema-release.js check --runtime gateway --source /ruta/absoluta/candidato --out /ruta/privada/preflight-gateway.json
```

Los candidatos necesitan el contrato y las migraciones incluidas en él. Los
archivos de evidencia deben ser nuevos; no se sobreescriben. Código de salida
`0` = compatible, `2` = diferencias de esquema, `1` = fallo operativo. No ignorar
un resultado incompatible ni generar un contrato nuevo para silenciarlo.

Para migrar **solo DEV**, con el checkout limpio y comprometido, crear un plan
con las migraciones concretas, en el orden necesario. El plan guarda versión,
hashes y metadata previa; no contiene datos clínicos ni contraseñas. Ejemplo del
ajuste inicial: primero normalizar el default de texto, después crear la bandeja.

```bash
sudo /usr/bin/node src/scripts/security-schema-release.js plan-dev --migration 20260916120000-align-security-monitoring-collations.js --migration 20260915040000-create-whatsapp-inbox-imports.js --out /ruta/privada/dev-plan.json
sudo systemctl stop clinicaclick-back-dev.service
sudo /usr/bin/node src/scripts/security-schema-release.js apply-dev --plan /ruta/privada/dev-plan.json --out /ruta/privada/dev-journal.jsonl
sudo python3 ops/security/publish-isolated-dev.py
```

El ejemplo es un corte inicial, **no una receta que repetir en cada despliegue**.
La herramienta rechaza migraciones ya registradas, un plan caducado por cambios
de esquema/código o un destino distinto de `clinicaclick_dev_isolated`. Usa un
bloqueo SQL y la misma conexión para DDL y registro. No llama a `sync()` ni aplica
todo el historial pendiente. Las migraciones se revisan antes: también pueden
contener código JS con efectos ajenos a SQL.

MySQL confirma DDL de forma implícita. Ante fallo, DEV queda detenido, la
migración incompleta no se registra y el diario conserva el último paso. Revisar
metadata/diario y crear un plan nuevo explícito; no reintentar a ciegas ni hacer
`down` destructivo. Para revertir código conservar el esquema aditivo y usar una
release compatible. Los cambios destructivos requieren una fase posterior
cuando todos los consumidores hayan dejado de utilizar los campos antiguos.

Pruebas sin BD pública ni proveedores:

```bash
node --test src/scripts/tests/security_schema_release.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node --test src/scripts/tests/security_schema_release_mysql.test.js
```

## Fuentes del contrato y registro

- **Contrato de producto:** frontend 39, 04 y documentos del dominio afectado.
- **API:** `src/Documentacion/13-backend.md`, seguido del espejo frontend.
- **Estado verificable de un corte:** acta con SHAs, flags, DDL y evidencia.
- **Estado y prioridades:** [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones) y [16](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/16-roadmap.md#seguridad-de-acceso-e-integraciones).
- **Historial:** [98](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/98-estado-historico.md#seguridad-integraciones-2026-09) y [99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md).

Si estas fuentes divergen, comprobar código/runtime y corregirlas antes del
corte. Los estados históricos no prevalecen sobre una comprobación actual.

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

#### Writer HTTPS en la instancia de seguridad

`services/platform-audit/src/writer-https-main.js` prepara el receptor de lotes;
`reader-main.js` conserva lectura/conciliación. Ambos exigen Node 24, configuración
privada y roles de servicio. El contrato y los límites se mantienen en
[39](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md#entrega-autenticada-de-auditoría).

Antes de instalar, verificar el lote IAM y un canal de bootstrap revisado para
`i-0cf40cfe823f160fa`. La instancia está registrada en SSM, pero el rol deployment
actual no permite ejecutar comandos. `cc-impl-assume-temp` por sí solo tampoco
añade ese permiso. No sustituir el rol de servicio por credenciales SSO ni abrir
SSH/puertos generales para salvar ese bloqueo.

El lote IAM inicial ya se contrastó con AWS: SSO de implementación, trusts y política
de asunción del rol EC2 coinciden con lo autorizado. El canal inicial delega la
ejecución de documentos fijos al operador. Si se aprueba autonomía temporal, usar
el procedimiento siguiente; no inferir nuevos permisos de la asunción del rol.
Evidencia y artefactos fechados en
[99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-iam-aplicado-instalador-2026-09-14).

##### Autonomía temporal de instalación y diagnóstico

Usar el permission set temporal autorizado y comprobar STS y la política efectiva
antes de operar. `cc-osadmin-temp` permite administrar solo la EC2 y su SG; no
es el rol permanente del servicio. La propuesta anterior de ampliar deployment
no debe aplicarse además. Comparar hashes, caducidad absoluta y recursos del
permiso recibido; no inferir capacidades por el nombre del permission set.

Crear y ejecutar documentos Command propios permite administrar como root la
EC2 de destino: un prefijo de nombres no restringe el contenido del script ni
impide acceder a archivos o a la identidad de instancia. Documentar ese poder
efectivo en la autorización. Separar límites IAM de controles operativos:
versión/hash, scripts sin secretos, alcance de servicios y JSON de ingreso fijo
se revisan antes de cada ejecución. `GetCommandInvocation` requiere recurso
global; consultar solo los CommandIds conocidos. El permiso de ingress se acota
al SG, mientras puertos/CIDR se verifican contra el lote aprobado. Referencias
oficiales de acciones/recursos: [SSM](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html)
y [EC2](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html).

La fecha de expiración impide nuevas solicitudes autorizadas por la ampliación;
no para sesiones/comandos ya iniciados ni deshace cambios. Cerrar sesiones y
retirar la asignación temporal al terminar. Si Run Command devuelve `AccessDenied`
sin ejecutar, no confundirlo con un error del instalador. Session Manager es un
canal alternativo solo cuando está expresamente autorizado: verificar el plugin
oficial, ejecutar el mismo diagnóstico congelado y conservar salida saneada.
Sin documento de preferencias creado, omitir el nombre utiliza el shell por defecto.
Comprobar también `TerminateSession`: el prefijo efectivo de la sesión federada
puede diferir de `${aws:userid}`. Una regla declarada no acredita cierre efectivo.
Evidencia del acceso y reparación en
[99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-auditoria-aws-operativa-2026-09-14).

El artefacto debe contener solo `services/platform-audit/src`, `package.json` y
su lockfile, con hashes revisados; nunca `.env`, modelos clínicos o secretos.
Instalar dependencias del lockfile sin scripts de instalación y ejecutar bajo un
usuario de servicio con directorios de estado separados. Conservar versión y
configuración anteriores para rollback; no retirar el journal ni objetos S3.

Configuración del writer (campos ilustrativos; no es configuración activada):

```json
{
  "port": 8443,
  "listenAddress": "0.0.0.0",
  "sourceRoleArn": "arn:aws:iam::137819318729:role/clinicaclick-integrations-prod-ec2-role",
  "stateFile": "/var/lib/clinicaclick-audit/writer/state.sqlite",
  "tlsKeyFile": "/etc/clinicaclick-audit/writer/tls.key",
  "tlsCertFile": "/etc/clinicaclick-audit/writer/tls.crt",
  "principals": [{ "keyId": "staging-writer-v1", "enabled": true, "publicKey": "PUBLIC_ED25519_KEY" }]
}
```

El fichero de configuración, certificado y claves deben ser absolutos, sin
symlinks y 0600; el directorio del journal, 0700. La clave TLS permanece en el
host aislado; staging recibe el certificado público autorizado y conserva su
propia clave de firma. Permitir en red únicamente los orígenes/puertos del corte
revisado. Configurar el lector con su propio journal y claves separadas para
`confirmed` y `reconcile`; no reutilizar la clave del writer.

#### Instalación con una única EC2 y roles por servicio

La configuración anterior ilustra el writer IMDS. El lector IMDS exige otra
identidad de origen: no pasar el mismo rol EC2 como readerSourceRoleArn y
writerSourceRoleArn. En la instancia única se usa explícitamente
`credentialMode=unix-scoped`, mediante `services/platform-audit/deploy/bootstrap.py`.

El instalador crea `cc-audit-credentials`, `cc-audit-writer` y `cc-audit-reader`.
Solo credentials consulta IMDSv2 y puede asumir los dos roles autorizados;
entrega sesiones STS de 900 s por sockets Unix separados, sin archivos de claves
AWS. Writer y reader verifican con STS su rol efectivo antes de S3. Cada socket
es 0660, con grupo propio, y el directorio 0711. Los consumidores carecen del grupo
ajeno. `credentialBrokerUid` se obtiene del usuario creado, y
`brokerSourceRoleArn` identifica el rol EC2 verificado.

Las unidades de writer/reader deshabilitan el proveedor IMDS y deniegan por
systemd sus direcciones IPv4/IPv6. `ExecStartPre` exige una denegación efectiva
de metadata y del socket ajeno antes de cada arranque; fallar esta prueba impide
arrancar. No aceptar únicamente que la directiva figure en el fichero. Root y
credentials pertenecen al ámbito de confianza; esto no separa hosts físicos ni
protege frente a un compromiso de root. Contrato en
[39](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md#roles-de-auditoría-en-una-instancia).

El filtro de paquetes de systemd puede producir `TIMEOUT`, no `EACCES`. El
comprobador abre dos listeners locales efímeros: exige conexión a `127.0.0.1`
y denegación a `127.0.0.2`, incluida en `IPAddressDeny`. Solo después admite
el timeout de IMDS; rechaza endpoints cerrados y conexiones de metadata exitosas.
Los listeners se cierran al terminar. Probar también el comprobador sin filtro:
debe rechazar antes de tocar metadata. No retirar controles para salvar el arranque.

El corte inicial usa un documento SSM sin parámetros ejecutables, versión y hash
fijados, con artefacto dentro del documento. Antes de crear usuarios o instalar,
comprueba cuenta/instancia, AL2023/x86_64, herramientas, espacio y ausencia de
rutas/usuarios/unidades propias previas o puertos ocupados. No sobrescribe otra
instalación. Descarga Node aislado con SHA-256 fijado, instala dependencias del
lockfile sin scripts como usuario sin login y deja código propiedad de root.
La configuración npm de usuario y global usa dos ficheros vacíos, distintos y
de solo lectura. No apuntar ambos a `/dev/null`: npm 11.19.0 rechaza cargar el
mismo fichero con dos funciones antes de instalar dependencias.

Puertos: writer 8443 y reader 8444; SG restringido al IPv4 /32 del emisor verificado.
Genera certificados TLS separados de 90 días y devuelve solo la parte pública
para fijarla en el cliente. Registrar vencimientos y preparar renovación antes
del corte; el instalador no proporciona renovación automática. La instalación
solo prueba arranque/aislamiento y HTTPS local: después se exige la prueba real
de escritura/lectura/conciliación con eventos ficticios.

Si falla, no abrir el SG ni reintentar automáticamente: conserva los archivos y
devuelve la fase fallida; detiene los servicios propios cuyo arranque intentó.
Rollback de una instalación completa: revocar únicamente las reglas de ingreso
creadas y ejecutar el documento de parada que valida instancia/hash. Detener y
deshabilitar los tres servicios conservando usuarios, claves, código y journals.
No reinicia la aplicación ni aplica DDL. La instancia/disco/IP existentes bastan;
sí habrá consumo de CPU/red y operaciones STS/S3/KMS que medir en costes.

#### Recuperación limitada de dependencias

`bootstrap.py --resume-dependencies` se limita al artefacto inicial conocido y
al estado anterior a configurar los servicios. Primero verifica cuenta/instancia,
usuarios/grupos, directorios raíz, fuentes exactas y ausencia de configuración,
journals, unidades y manifiesto final. Si hay diferencias, se detiene antes de
crear nuevos directorios. No convertir esta opción en un reintento genérico.

Conserva el árbol parcial original, reutiliza únicamente los usuarios verificados
y crea árboles `-recovery1` para Node y release. Node vuelve a descargarse con
SHA-256 fijado; su árbol y el código final quedan propiedad de root. La corrección
de npm se ensaya con el Node/npm oficiales y un usuario sin login, instalando
el lockfile completo en un directorio de QA. Los errores externos solo devuelven
fase y un código permitido; no imprimir el stderr arbitrario del gestor.

La recuperación requiere un documento SSM nuevo fijado por versión/hash. Mantiene
las comprobaciones de aislamiento/HTTPS y deja ingress cerrado hasta éxito.
El documento de parada anterior sirve tras completar la recuperación porque
el hash del runtime se conserva; no sirve para deshacer una instalación parcial
sin manifiesto final. Evidencias y lotes exactos en
[99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-recuperacion-npm-2026-09-14).

#### Diagnóstico de un fallo posterior al configurar servicios

Si la recuperación supera npm y falla en `start_writer`, ya existen claves,
configuraciones y unidades: `--resume-dependencies` debe rechazar ese estado.
Conservar los artefactos ejecutados y no generar otra instalación a ciegas.
La fase identifica el comando fallido, pero no demuestra si falló `ExecStartPre`,
systemd o una dependencia. La limpieza intenta detener las unidades cuyo arranque
se intentó; contrastar su estado antes de afirmar que están detenidas.

`services/platform-audit/deploy/diagnose_startup.py` permite preparar un documento
SSM de diagnóstico sin parámetros, fijado por versión/hash e instancia. Recoge
solo propiedades permitidas de las tres unidades, categorías filtradas de sus
journals, metadatos de permisos y cotejo de hashes de código/unidades/Node. La
ventana de journal y los hashes esperados se congelan para el incidente concreto.
Nunca devuelve logs completos ni lee contenidos de configuración, claves o BD.
Las pruebas deben comprobar el filtrado con valores ficticios sensibles y el
rechazo de rutas de secretos y enlaces simbólicos.

`diagnostic_collected_not_repaired` significa únicamente que la recogida terminó.
No arranca servicios ni permite abrir ingress. Si el error corresponde al control
de aislamiento, identificar la comprobación concreta manteniendo las barreras;
un timeout por sí solo no prueba una denegación de permisos. Los sockets pueden
desaparecer tras la parada del broker y su ausencia posterior no explica el fallo
anterior. Evidencia del incidente en
[99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md#seguridad-diagnostico-arranque-auditoria-2026-09-14).

Para reparar el comprobador, congelar un lote nuevo y verificar antes los hashes
de fuentes, Node y unidades, usuarios/permisos, servicios inactivos y ausencia de
manifiesto final. Copiar a otra release conservando las dependencias ya verificadas,
respaldar unidades y cambiar únicamente código/unidades revisados. Ante fallo,
parar los servicios, restaurar las unidades y conservar archivos para diagnóstico.
Tras éxito, registrar el hash nuevo y comprobar TLS, escritura/lectura/conciliación
ficticias y recuperación tras reinicio. El documento de parada fijado al hash
anterior deja de servir: preparar uno compatible con el nuevo manifiesto, sin
borrar claves, journals ni objetos S3. Lote y evidencia en el corte enlazado arriba.

En staging, preparar `PLATFORM_AUDIT_WRITER_TRANSPORT=https`, origen HTTPS,
CA/key-id/key-file y rol fuente. Gateway y DEV no arrancan el consumidor. Con
el esquema aprobado, verificar un evento ficticio completo por TLS, S3 y
conciliador; comprobar un recibo real, duplicado, timeout, firma incorrecta,
reinicio y recuperación del outbox. Solo entonces ejecutar el corte MFA del
[runbook de acceso](security/admin-password-session-cut.md#secuencia-del-corte-público).

### D. Migracion Aprobada Por Cohortes

1. Presentar lista de conexiones/consumidores, referencias objetivo, respaldo restringido, cambios de esquema, tiempos, corte de writers y rollback. No incluir Meta bloqueado como candidato activo. No llevar tokens bajo investigacion al almacen operativo; preservar evidencia aparte si corresponde.
2. Compatibilizar los consumidores de la BD pública: staging, gateway, cron, colas y scripts autorizados. DEV ensaya el mismo esquema en su BD aislada; no volver a compartir usuarios SQL. No retirar campos antiguos mientras un consumidor dependa de ellos.
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

No reutilizar recuentos históricos de commits pendientes. Antes de cada publicación, comprobar el remoto y el rango completo de ambas ramas. El último corte de acceso y sus versiones se describen en el acta enlazada al inicio.

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

- DEV backend: fuente `/home/ubuntu/wt/back-dev`, release `/opt/clinicaclick-dev/current`, `clinicaclick-back-dev.service`, puerto local `3004`. Publicar con `sudo python3 ops/security/publish-isolated-dev.py`, Git limpio y dependencias aisladas; no arrancar el PM2 antiguo.
- Staging backend: `/home/ubuntu/wt/back-staging`, `pm2-back-staging`, puerto `3001`.
- Gateway: `/home/ubuntu/wt/gateway`, `pm2-gateway`, puerto `3000`; entradas externas OAuth/webhooks y sin jobs de negocio propios.
- Preview frontend: `cc-front-preview-4203` sirve `/home/ubuntu/www/front-dev-preview`; fuente `/home/ubuntu/wt/front-dev`. Seguir `30` para build y `/home/ubuntu/scripts/cc-front-preview-sync.sh`, no arrancar otro ng serve que sustituya el preview.

El perfil aislado DEV mantiene JobRequests de negocio, cron, resume y gates de campañas pausados. `clinicaclick-dev-security.service` entrega solo correo de autenticación y auditoría; no habilita proveedores clínicos. Su lector usa el certificado CA del reader, distinto del writer cuando son autofirmados. Staging conserva sus workers autorizados; gateway mantiene worker/cron apagados. El propietario reportó revocación de credenciales y parada de WhatsApp; el corte de acceso no lo reactiva. Leer y preservar los flags actuales sin confundir la pausa DEV con el aislamiento de credenciales. No repetir reparaciones o rotaciones ya realizadas.

Hotfix `socialstats.controller.js` de 12/09/2026 ya aplicado localmente a DEV/staging/gateway. Preservarlo e integrarlo en el corte aprobado; una promocion que lo pierda reabre la brecha. Su SHA historico esta en el acta de seguridad, no usarlo para deshacer mejoras posteriores legitimas.

Rollback: volver al artefacto seguro anterior del broker/adaptador, o detener solo la cohorte afectada y conservar lecturas de cache con estado obsoleto explicito. Nunca reabrir el endpoint vulnerable, restaurar tokens revocados, devolver tokens al front o recuperar escrituras desde DB como fallback. Preservar auditoria, comandos pendientes e idempotencia.

Cerrar actualizando contrato `39`, docs afectados, `19` y `99`; API primero en `src/Documentacion/13-backend.md`, despues espejo frontend. Entregar al Codex de publicidad solo cambios de contrato necesarios, errores/flags nuevos, rutas y estado de proveedores, sin secretos.
