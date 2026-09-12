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
| BD | Sin diagnóstico ni cambio | Ninguna consulta ejecutada en esta tarea | Metadata, TLS, backups, plan/restauración ficticia; corte real separado |

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
