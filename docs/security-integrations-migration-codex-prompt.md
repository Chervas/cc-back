# Prompt Para Codex: Implementacion De Seguridad Con AWS Ya Aprovisionado

> Copia versionada para retomar desde el repositorio backend. Preparada en el corte autorizado de publicacion completa a DEV del 12/09/2026; comprobar SHAs remotos y estado actual antes de iniciar. La autorizacion de ese corte no permite publicar futuros cambios ajenos.

Actua como responsable de la migracion de seguridad de ClinicaClick. Esta es una tarea separada del desarrollo de Marketing/publicidad, que continua con otro Codex. Debes implementar y probar la solucion, no limitarte a proponerla; los cortes con datos reales y los cambios de infraestructura tienen las puertas de aprobacion indicadas abajo.

## Lo Que Te Encargo

1. Verificar la entrega AWS existente, sin volver a contratarla.
2. Implementar un servicio aislado de integraciones en la instancia preparada, con AWS Secrets Manager/KMS, y adaptar progresivamente los consumidores de ClinicaClick. Los tokens no deben estar disponibles para el front ni para la API general.
3. Integrar sus costes AWS en Ajustes usando el sistema de monitorizacion existente, datos de facturacion y cache persistente.
4. Implementar auditoria de accesos, acciones y permisos de la plataforma con almacenamiento externo protegido. El DPD pide seis meses de registros; confirmar el computo y la politica, no inventar que 183 dias satisfacen automaticamente ese requisito.
5. Auditar el cifrado real de la BD y preparar su remediacion si falta, con pruebas de restauracion y un corte aprobado por separado.
6. Actualizar documentacion, ejecutar QA, preparar commits propios y publicarlos a DEV sin arrastrar trabajo de publicidad. Desplegar solo el corte especificamente aprobado y devolver un handoff verificable.

AWS fue aprovisionado por otro Codex. Tu NO eres el aprovisionador inicial: no recrees la instancia, secretos, buckets, claves ni stack. Tampoco retomes el desarrollo de objetivos/campanas, la UX de su plan gestionado o el servidor de correo.

## Contexto De Seguridad Que No Puedes Perder

- El 11/09/2026 se detecto un incidente Meta con publicaciones no reconocidas atribuidas visualmente a ClinicaClick y cobros publicitarios. La atribucion no prueba el servidor origen ni el vector exacto.
- El token Meta comprobado fue rechazado con 190/460. No se renovo ni sustituyo. No pruebes ese token ni derivados o alternativas para eludir el bloqueo; encontrar una credencial no autoriza a usarla.
- Se corrigio una brecha real de autorizacion/exposicion de credenciales en `getAssetStats`. El parche esta en `src/controllers/socialstats.controller.js`, aplicado localmente a DEV/staging/gateway el 12/09. Debes preservarlo y mantener sus pruebas. No esta demostrado que fuera el vector del incidente.
- Campos de tokens siguen almacenados directamente en recorridos de la BD inspeccionados. Secrets Manager y KMS aprovisionados no significan que esos datos se hayan migrado.
- DEV y staging comparten BD. DEV tiene overrides PM2 de jobs/cron/resume/campanas pausados; staging y WhatsApp no estan globalmente pausados. No cambiar estos estados por arrancar tests o reiniciar.
- No se autoriza OAuth, renovacion/revocacion de proveedores, publicaciones, conversiones CAPI/Google, mensajes, nuevos anuncios, cambios de presupuesto ni pruebas activas de explotacion. Usa proveedores ficticios para QA y solicita una autorizacion acotada para cualquier prueba real necesaria.

## Donde Estas Y Que Debes Leer

Servidor conocido: `/home/ubuntu`, bash, sistema/BD UTC; presentar operaciones en Europe/Madrid conservando UTC. Comprueba el entorno actual antes de actuar. Si estas en Desktop sin acceso al servidor, solicita el canal autorizado; no configures Chrome MCP, tuneles ni reutilices sesiones personales para acceder.

Repositorios:

- Backend DEV: `/home/ubuntu/wt/back-dev`, rama `dev`, runtime `pm2-back-dev`, puerto 3004.
- Frontend DEV: `/home/ubuntu/wt/front-dev`, rama `dev`, preview `http://localhost:4203`.
- Backend staging: `/home/ubuntu/wt/back-staging`, `pm2-back-staging`, puerto 3001.
- Gateway: `/home/ubuntu/wt/gateway`, `pm2-gateway`, puerto 3000, fuente staging.
- Frontend staging: `/home/ubuntu/wt/front-staging`, build publicado `/home/ubuntu/www/front-staging`.

Orden obligatorio de lectura, sin cargar todo el historico:

1. `/home/ubuntu/wt/front-dev/src/Documentacion/00-handoff-operativo.md`.
2. `19-estado-actual.md` y **`39-seguridad-integraciones-cifrado-auditoria.md`** del mismo directorio. El 39 contiene el inventario AWS recibido, arquitectura, alcance y requisitos de auditoria/costes/BD.
3. `/home/ubuntu/wt/back-dev/docs/security-integrations-audit-migration.md`. Es el runbook tecnico con fases, puntos del codigo, matriz QA, commits, push, despliegue y rollback.
4. Front docs `25-operacion-worktrees-entornos.md`, `30-despliegues-y-entornos.md`, `31-roadmap-arquitectura-entornos-gateway.md`. Las instrucciones acotadas del runbook de seguridad prevalecen sobre ejemplos genericos que promoverian todo DEV.
5. `02-base-de-datos.md`, `03-variables-entorno.md`, `04-autenticacion-jwt.md`, `05-oauth-integraciones.md`, `07-roles-permisos.md`, `11-sistema-jobs.md`, `14.1-whatsapp-integracion-meta.md`, `20.13-marketing-conexiones-y-activos-efectivos.md`, `32-storage-publico-y-clinico.md` segun el componente que toques.
6. `/home/ubuntu/wt/back-dev/docs/README.md`, `src/Documentacion/13-backend.md` y `docs/campaign-workspace-implementation.md` para preservar contratos, no para continuar su producto.
7. `/home/ubuntu/incident-handoff/meta-2026-09-11-prompt.md`, `meta-2026-09-12-asset-stats-remediation.md`, `meta-2026-09-12-token-lifecycle-audit.md`. Evidencias historicas, no permisos externos reutilizables.

La documentacion distingue contrato, estado implementado y entradas historicas. Verifica codigo/runtime antes de afirmar que algo funciona. No trates antiguos ejemplos de documentacion como jobs realmente desplegados.

## AWS Entregado: Punto De Partida, No Verificacion Tuya

- Cuenta `137819318729`, region `eu-west-3`.
- Stack `clinicaclick-integrations-prod-foundation`, estado comunicado `UPDATE_ROLLBACK_COMPLETE` por actualizacion de Budget. El aprovisionador declara los recursos conservados y la notificacion ACTUAL 100% anadida fuera de CloudFormation. Verifica eventos y concilia el estado sin borrar/recrear.
- Instancia `i-0cf40cfe823f160fa`, salida fija `13.39.100.55`.
- Prefijo `/clinicaclick/integrations/prod/`; secreto ficticio de smoke test, no token real.
- Log group `/clinicaclick/integrations/prod/app`.
- Bucket de auditoria `clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu` y KMS `alias/clinicaclick/audit/prod/logs`.
- Roles de auditoria writer/reader/retention-admin, CloudTrail y SNS detallados con ARNs en documento 39.
- Budget comunicado 60 USD/mes, alertas reales >80% y >100%, forecast >100%. Destinatario acordado `carlos@clinicaclick.com`. Comprobar filtro incremental de esta infraestructura; no es limite duro ni presupuesto total de AWS.
- S3 versionado/cifrado y `NoncurrentDays=183` reportados. Ese dato no prueba retencion minima ni inmutabilidad. El deny del writer se probo con simulador IAM, no demuestra todos los controles efectivos.
- KMS auditoria no tiene rotacion automatica habilitada. Object Lock Governance, plazo DPD y retirada del SSO temporal siguen pendientes. No actives Compliance ni acortes retencion para cerrar un checklist.

Pedir al usuario/aprovisionador los tres artefactos saneados de:
`/Users/modmarketing/Documents/New project/clinicaclick-aws-provisioning-2026-09-12/`
(`propuesta-aprobacion.md`, `manifest.initial.json`, `clinicaclick-integrations-infra.yaml`) y un manifiesto FINAL posterior al rollback. Estan en su Mac, no presumas que existen en este servidor.

Faltan por acreditar tipo/AMI/red/SSM/IMDS de la instancia, runtime/deployer/cost role y trusts, las dos claves de integraciones, aislamiento de principales antiguos, Cost Explorer/tags y alcance real de CloudTrail. Verifica con sesion AWS temporal expresamente asignada a esta tarea, empezando por metadata. Nunca root ni access keys permanentes. No ampliar por tu cuenta el permission set temporal del aprovisionador.

## Como Debe Funcionar La Solucion

- Una instalacion inicial del broker, sin DB clinica ni permisos administrativos del backend antiguo. Autenticacion entre servicios mas autorizacion por operacion/activo; la IP es defensa adicional, no identidad suficiente.
- Ningun proxy generico. Operaciones y esquemas permitidos, limites, controles de tenant, idempotencia, auditoria y errores sin tokens. Ninguna API de recuperar el secreto para el front o backend general.
- Secrets Manager/KMS con roles separados; si hay envelope adicional, segunda clave independiente, no una clave global en el `.env` antiguo. El token sigue siendo necesario en memoria al hablar con el proveedor: no prometas que doble cifrado elimina ese riesgo.
- Meta appsecret_proof y restricciones de origen solamente donde esten documentadas y soportadas; cambios de configuracion en Meta requieren aprobacion. No afirmar que la IP fija ya vincula todos sus tokens.
- Mantener referencias de conexion/activos y contratos de negocio. Inventariar TODOS los consumidores: Google, Meta social/Ads, WhatsApp, recepcion, webhooks, OAuth, jobs y scripts, no solo los dos clientes HTTP nuevos.
- Persistir bloqueo/revocacion y propagarlos a caches/reinicios. Renovar por tipo y capacidades oficiales sin consentimiento repetitivo innecesario, pero renovar no invalida necesariamente la credencial anterior. No establecer rotacion horaria/semanal indiscriminada.
- Corte por cohortes aprobado, con unica fuente activa y sin fallback a tokens de DB ni doble ejecucion publicitaria. Meta bloqueado sigue bloqueado. No presentar una prueba ficticia como recepcion real de leads o ejecucion real de Optimiza.
- Auditoria de login, lecturas, cambios, exportaciones y permisos con actor/scope/resultado/correlacion, entrega durable, acceso restringido y retencion definida; nunca contenido clinico ni secretos en logs. No reconstruir seis meses de historial que no existe.
- Costes en Ajustes: cache persistente, job diario Europe/Madrid, IAM de solo lectura, filtros correctos, estado pendiente/atrasado, moneda y distincion presupuesto/gasto/estimacion. No sumar dos veces costes de IA y factura AWS.
- Cifrado BD: primero topologia y metadata, despues plan y restauracion ficticia. Cualquier migracion de BD real, nuevo coste o downtime se aprueba por separado.

## Que Puedes Hacer Y Donde Debes Parar Para Aprobar

Avanza de forma autonoma leyendo codigo/documentacion, implementando en el alcance acordado, escribiendo tests aislados, migraciones sobre BD ficticia y contratos. Elige patrones existentes y no mezcles refactors de Marketing. Actualiza progreso brevemente y pide solo informacion que realmente falte.

Antes de mover secretos reales, desplegar a servicios utilizados, modificar IAM/red/KMS/retencion/SSO o ejecutar migraciones sobre BD compartida, presenta un lote concreto: recursos, permisos, consumidores, respaldo, coste, ventana y rollback. Pide aprobacion de ese lote, no de cada linea. No interpretes permisos tecnicos disponibles como autorizacion para cambios ajenos al encargo.

No contratar recursos adicionales ni superar el alcance presupuestario sin nueva aprobacion. No desactivar TLS, abrir SSH publico, exponer tokens por debug, leer paginas sospechosas del incidente, usar perfiles personales de Chrome, modificar SES ni eliminar evidencia. No cambiar la hora del SO/BD para mostrar Madrid: usar zona explicita en jobs y visualizacion.

## Git, Push Y Despliegue

**Hay trabajo concurrente y no publicado.** Al preparar este prompt, backend DEV estaba 46 commits y frontend DEV 35 commits por delante de sus refs `origin/dev`, ademas de muchos cambios locales. Verifica otra vez; un push directo de DEV podria publicar todo ese trabajo.

1. Lee el apartado 5 del runbook tecnico completo. Inventaria estado/HEAD/upstream y coordina archivos compartidos con el Codex de publicidad. No revertir cambios ajenos, no `git add .`, `git add -A`, `commit -am` ni reset/force push.
2. Desarrolla y crea commits propios primero en DEV con hunks revisados; no trabajes directamente en staging. No incluir un archivo entero si contiene cambios ajenos.
3. Haz fetch autorizado y revisa TODO `origin/dev..HEAD`, no solo el ultimo commit. Antes del push, el rango publicado debe contener solo tu trabajo y dependencias explicitamente aprobadas.
4. Si DEV tiene ancestros ajenos sin publicar, prepara con coordinacion un candidato en worktree temporal limpio basado en origin/dev, aplica commits propios/dependencias aprobadas y repite pruebas. No quitar dependencias necesarias para aparentar un corte aislado. Si no es viable, entrega el bloqueo concreto al integrador.
5. Publica por fast-forward a `dev` solo el candidato validado; verifica SHA remoto. No `main`, no remotos nuevos, no promover toda la rama de campanas. No afirmes push sin comprobarlo.
6. Push no equivale a despliegue. Staging/gateway y broker requieren el lote aprobado, sin ejecutar todas las migraciones pendientes. Preserva el hotfix local de getAssetStats y los flags actuales; conserva rollback seguro, no el codigo vulnerable.

## QA, Documentacion Y Entrega

Ejecuta la matriz del runbook: regresion de fuga/ACL, sentinel sin secretos, aislamiento de roles, broker/scope, bloqueo tras reinicio, contratos/webhooks ficticios, idempotencia, caida/recuperacion de auditoria, costes/cache y migracion/restauracion aislada. No pruebas con pacientes reales ni guards de red deshabilitados. QA Chromium desktop/movil de la UI que cambies con sesion de prueba autorizada, sin conectarte al Chrome personal del usuario.

Actualiza `39`, runbook tecnico, docs de dominios realmente cambiados, `19` y `99`. Si cambia la API, fuente `back-dev/src/Documentacion/13-backend.md` primero y despues espejo frontend. Guardar evidencia saneada fuera de rutas publicas; jamas commitear `.env`, dumps, tokens, cookies, sesiones AWS o backups privados.

Entregables finales: consumidores inventariados/migrados/bloqueados, manifiesto final sin secretos, arquitectura/permisos, version desplegada, pruebas y limites, costes/filtros/job, cobertura/retencion de auditoria, diagnostico/corte de BD, hashes y SHAs realmente pusheados, rollback y pendientes con responsable. Devuelve al Codex de publicidad solo el contrato necesario para continuar, sin credenciales.

Tu primera respuesta debe resumir lo recibido, accesos disponibles y pendientes, y los tres primeros pasos. Despues empieza por lectura local, inventario y comprobaciones seguras. No esperes a resolver el permiso de Meta para trabajar offline ni declares toda la migracion terminada si faltan cohortes, trazabilidad o validacion real.
