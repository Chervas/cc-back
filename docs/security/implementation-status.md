# Seguridad: implementación y evidencias

Estado inicial: 12/09/2026. Implementación en curso; ninguna cohorte migrada,
ningún despliegue, secreto real movido ni llamada a proveedor autorizada.

El usuario confirmó que la tarea concurrente ha terminado. Fetch de ambos
repositorios: backend `a681e49758b5336d34df9b6cc2e69db5585ce23c`, frontend
`5478ac10c8c145b030c71401c44fbb730eb69dcb`, limpios y 0/0 respecto de
`origin/dev`. Revalidar antes de cualquier commit/push. No modificar PM2,
pausas, staging/gateway ni la BD compartida por publicar código.

## Matriz de aceptación AWS

Los tres originales saneados están en `provisioning/received-2026-09-12/`, con
hashes de recepción en `sha256.json`. Las afirmaciones de esos documentos son
**reportadas**. La lectura de una plantilla verifica su contenido, no su estado
efectivo en AWS. `manifest.final.json` aún declara identificadores no capturados.

| Área | Reportado | Verificado localmente | Pendiente / responsable |
|---|---|---|---|
| Cuenta/región/stack | 137819318729, eu-west-3, UPDATE_ROLLBACK_COMPLETE | Coherencia de los artefactos | Identidad, eventos, outputs y template vivo; operador SSO + seguridad |
| EC2/red | t3.small AL2023, 20 GiB cifrados, IMDSv2, EIP fija | Plantilla sin ingress ni UserData de instalación | IDs/AMI/parches, TLS y canal de acceso del consumidor; cambio de red con aprobación |
| Runtime | Instance role lee prefijo Secrets y dos KMS | No concede asumir writer ni cost-reader; no escribe secretos | Trusts operativos y permisos efectivos; lote IAM separado |
| Despliegue | Rol dedicado | Permisos CF/inventario; sin SendCommand/StartSession ni canal de artefactos | Definir instalación aprobada sin entregar administración al backend |
| KMS | Secrets/payload/auditoría separadas | Rotación deshabilitada en las tres; políticas habilitan delegación IAM de cuenta | ARN payload exacto, políticas efectivas y aislamiento de principales anteriores |
| Auditoría | Bucket privado/versionado/KMS; smoke test ficticio | Writer/reader/retention-admin confían solo en OperatorPrincipalArn | Trusts de servicio; permisos de S3/KMS y entrega efectiva |
| Retención | 183 días actuales y no actuales en plantilla; Object Lock apagado | Retention-admin puede PutLifecycleConfiguration y PutBucketPolicy | DPD define cómputo, excepciones, eliminación y Governance; no acreditar inmutabilidad ni límite efectivo de borrado con esta separación nominal |
| CloudTrail | Regional, gestión read/write, validación | Sin eventos globales ni selectores de datos S3 en plantilla | Cobertura efectiva y coste de ampliarla, con aprobación |
| Budget | 60 USD, avisos 80%/100% real y 100% forecast | Filtro solo application; default de plantilla 45 USD (valor desplegado reportado 60) | Confirmar parámetros, filtro incremental y conciliación del aviso fuera de CF; sin recrear |
| Costes | Cost-reader creado | Trust solo SSO aprovisionador; tags application/component/environment/cost-center en recursos compatibles | Activación CE/tags y cobertura de gastos no etiquetados; sin tratar ausencia como cero |
| SSO | Propuesto impl-readonly-temp 1 h | No se ha asignado acceso a esta sesión | Usuario/aprovisionador aprueba y habilita relevo mínimo; no reutilizar AdministratorAccess |
| BD | Cifrado global no acreditado | Diez consultas reales de metadata, seis verificadas y cuatro denegadas; redo/undo/binlog nativos OFF, TLS no exigido | Tablespaces, componente de claves, sesiones/réplicas, volumen y backups; DBA/operador temporal. TLS/corte/rotación con aprobación |

Revisar además la política propuesta de lectura antes de solicitar su aprobación:
para inspeccionar controles hacen falta las acciones IAM correctas (por ejemplo
`s3:GetLifecycleConfiguration`, `s3:GetEncryptionConfiguration`), lectura de
versiones de políticas administradas y `kms:GetKeyPolicy`; Object Lock y SSM
status requieren metadata adicional. No ampliar permisos desde esta sesión.

## Orden de trabajo y cobertura

1. Inventario estático de consumidores y clasificación manual por cohorte.
2. Broker autocontenido, política de autoridad local, almacenamiento durable,
   controles de peticiones, secretos y entrega de auditoría, probado sin AWS.
3. Adaptadores y referencias aditivas; compatibilidad de todos los consumidores
   antes de cortar cada cohorte, sin fallback a credenciales legacy.
4. Auditoría de plataforma, colector/cache de costes e integración en Ajustes.
5. Diagnóstico de cifrado y restauración aislada, QA de contratos y UI.
6. Publicación selectiva y lotes concretos de despliegue/migración para aprobar.

El código nuevo no convierte el estado reportado en verificado. Las fases sin
SSO avanzan con ficticios; AWS, cohortes reales, retención y BD real permanecen
pendientes hasta la evidencia y autorización específicas.

## Primer bloque implementado (sin despliegue)

`services/integrations-broker`: Node 24 aislado, TLS/Ed25519, grants exactos,
schemas cerrados, nonce y cuota durables, bloqueo persistente, idempotencia y
resultado incierto, outbox SQLite con leases/reintentos, adaptadores SDK de
Secrets Manager y S3 probados con dobles. Solo operación ficticia ejecutable.
`src/lib/integrationsBrokerClient.js`: transporte para Node 18 del backend,
sin bootstrap/modelos/credenciales AWS; sin conexión a consumidores legacy.
El núcleo de costes inicialmente incluido en el broker se ha trasladado al
paquete separado `services/aws-cost-collector`; ver el segundo bloque debajo.

El inventario y las cohortes están en `consumer-inventory.json` y
`consumer-cohorts.md`. SSO continúa pendiente: cero verificaciones AWS propias.
El destino Node 24 tampoco está instalado ni aprobado en la instancia entregada.

El espejo API frontend ya divergía de la fuente backend antes de esta tarea
(1.212 inserciones/467 eliminaciones al sustituirlo entero). Se sincroniza solo
el bloque nuevo de seguridad para conservar documentación ajena; la conciliación
histórica completa queda al integrador, fuera de este corte selectivo.

QA completada: 23 pruebas del paquete nuevo con red externa bloqueada; 11
casos HTTP existentes del hotfix y 7 comprobaciones MySQL 8.0.42 en socket
privado/BD ficticia. Mysqld de QA terminó con exit 0. Controlador conserva
SHA-256 `0d14de2cb70b183e35e88f4561a48e190fc164c8bcb0628021e727f48770b8c5`.
`npm audit --omit=dev` del paquete nuevo: cero vulnerabilidades reportadas.
Evidencia saneada fuera de rutas públicas:
`/home/ubuntu/qa-evidence/security-migration-20260912/initial-offline-qa.json`.

## Segundo bloque: costes integrados, sin activar

Colector Node 24 separado, rol fijo/IMDS/STS, validación de tags, uso paginado
y forecast/Budget; caché persistente nueva, leases CAS, errores cerrados,
endpoint protegido por JWT/admin técnico y cron durable `03:40 Europe/Madrid`
apagado por defecto. UI Costes AWS con mes actual/anterior, estados y moneda,
presupuesto vigente diferenciado del histórico y de gasto/estimación de IA.
Contrato, permisos pendientes, coste y rollback en
`services/aws-cost-collector/README.md`.

QA: 12 casos del paquete de costes, 8 servicio, 2 HTTP del endpoint y los
11 HTTP del hotfix. Suite existente de orquestación pasa con preload que
bloquea red y carga de .env. MySQL 8.0.42: 6 comprobaciones de migración,
concurrencia, persistencia, lease vencido, rollback y reaplicación, con
datadir/socket temporal y cierre 0. Build Angular development
`a27e86a5f068637e`; aviso CommonJS existente de socket.io-parser/debug.
Chromium: seis capturas reales del componente con datos ficticios, desktop
1440 y móvil 390, navegación/tabla desplazables y sin overflow de página,
mes anterior, error/recuperación, escape de HTML y ninguna llamada externa.
Sin sesión de aplicación real; ACL probada con JWT ficticios por HTTP.

Migración `20260912180000` aplicada solo a MySQL ficticio. Gate de costes
no configurado en PM2. No se ha creado la tabla compartida, instalado Node
en hosts utilizados ni desplegado la UI. SSO/IAM/tags/CE/Budget siguen
reportados o pendientes. El resto de consumidores, auditoría de plataforma
y diagnóstico/corte de BD continúan en las siguientes fases.
Evidencia: `/home/ubuntu/qa-evidence/security-migration-20260912/costs-offline-qa.json`.

## Tercer bloque: BD diagnosticada parcialmente y corte preparado

`security-database-metadata.js` recoge exclusivamente metadata, con proyección
cerrada y errores categorizados. Ejecutado por UNIX con la identidad ya
configurada, sin modelos ni filas clínicas. MySQL 8.0.42 local, datadir
`/var/lib/mysql/`; cuatro denegaciones conservadas, sin recurrir a otro
usuario ni elevar privilegios. El volumen ext4 puede estar cifrado por el
proveedor: el estado de su cifrado/backups no queda probado por la inspección.
Resultados y lotes en `database-encryption-remediation.md`.

`databaseTlsConfig.js` prepara CA/nombre verificados y TLS >=1.2 para la
config canónica, conexiones secundarias y scripts inventariados. Sin activar
`DB_TLS_REQUIRED`, sin PM2 ni consultas de los scripts de mantenimiento.
Credencial incrustada retirada de `src/config/db.js`, que ahora exige config
canónica sin fallback de identidad; rotación y exposición en historia/copias
siguen pendientes. No se probó la credencial encontrada.

QA: nueve casos unitarios; cuatro comprobaciones de metadata sobre MySQL
temporal; ocho comprobaciones de cifrado/TLS/backup/restauración con dos
tablas sintéticas. CA/nombre ajenos y TCP sin TLS rechazados; backup cifrado
dañado/identidad GPG ajena denegados; MySQL sin keyring correcto falla;
restauración con claves conserva datos/relación/unicidad/cifrado. Tres
procesos propios terminaron (0/1 esperado/0), ninguno forzado. No prueba
RPO/RTO clínico ni recuperación con KMS o backups reales.

Inventario SQL estático en `database-client-inventory.json`. Evidencia
privada: `/home/ubuntu/qa-evidence/security-migration-20260912/database-offline-qa.json`
y `database-local-metadata-20260912.json`. Corte de BD, TLS real, claves,
SSO, auditoría completa y consumidores de proveedores siguen pendientes.

## Cuarto bloque: auditoría semántica inicial, apagada

Tres accesos de autenticación preparan evento de intento/resultado y actor
verificado, JTI no secreto y DTO sin hash de contraseña. Cola MySQL aditiva,
lease/idempotencia/recibo/health, writer S3 condicional y conciliador separado,
probados solo con ficticios. No se ha creado la tabla compartida ni asignado
identidad AWS. Faltan bootstrap/worker/alarma, visor, auth restante,
permisos y actividad clínica. Matriz completa, fallos/retención y lotes en
`../../services/platform-audit/README.md`.

Inventario heurístico: 60 archivos, 869 declaraciones de ruta, 3 preparadas y
apagadas; no acredita cobertura runtime. QA: 5 casos contrato/S3, 6 auth
(incluye HTTP real sobre servidor propio), 11 hotfix y 28 correo. MySQL
ficticio: 8 comprobaciones, cierre limpio, sin conexiones externas. SDK del
paquete nuevo auditado: cero vulnerabilidades reportadas. Evidencia privada
`/home/ubuntu/qa-evidence/security-migration-20260912/platform-audit-offline-qa.json`.
Sin despliegue, migraciones compartidas, secretos, proveedores ni PM2.

## Quinto bloque: worker de entrega y monitor de panel preparados

Dos jobs nuevos apagados en el catálogo durable, cada minuto/cinco minutos
Madrid. Proceso Node 24 solo writer, IMDSv2/STS con identidades comprobadas en
código antes de S3, endpoints fijos y entorno/archivos AWS aislados. Lotes de
50, paralelismo 4, sin credenciales en payload/logs/resultado. Lease global
270 s y por evento 120 s; ACK dudoso permanece sin confirmar.

Estado y alertas de panel durables, dedupe/recuperación y transacción de todos
los destinatarios técnicos. No dispatch email/WhatsApp. Endpoint privado de
salud por JWT/admin técnico, solo contadores/fechas, sin consultas AWS ni
acceso a eventos. No es el visor, ni su propia consulta está auditada todavía.
Watchdog externo pendiente; se declara incluso en la respuesta.

QA: 10 pruebas paquete, 5 entrega/monitor y 10 regresiones costes, 1 HTTP salud, 6 auth y 11 hotfix;
suite de orquestación de 42 definiciones/executores, 9 comprobaciones MySQL
ficticias y SDK npm audit 0. Ambas migraciones de auditoría solo ensayadas en
instancias temporales. Inventario actual: 870 declaraciones/60 archivos,
solo 3 capturas semánticas preparadas; ninguna cobertura operativa acreditada.

Evidencia `platform-audit-delivery-offline-qa.json` y publicación verificada
`platform-audit-delivery-publication.json` bajo el directorio privado de QA.
Siguen pendientes instalación, identidad/trust AWS asignados, lector operativo,
visor, cobertura clínica/permisos/auth restante y DPD. No se activa ninguna
captura ni se despliega con este push.
