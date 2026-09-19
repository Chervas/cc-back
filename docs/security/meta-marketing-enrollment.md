# Selección y activación Meta: núcleo del broker

Preparado sobre backend `3f5d61f5`, 19/09/2026. No desplegado ni aceptado con
proveedor real. Contrato canónico en
[13-backend](../../src/Documentacion/13-backend.md#selección-y-activación-meta-dentro-del-broker-preparado-19092026).
Este núcleo todavía necesita el consumidor SQL/API/UI de selección de CRM.

## Operación y autoridad

`assetEnrollment=true` exige discovery y añade prepare/activate/status/revoke.
Gateway OAuth y su control conservan identidades separadas; lector de activos y
su control añaden otras dos claves únicas. Todos limitados al entorno/ámbito del
slot. No grants estáticos ni derechos enviados por el llamador: una selección
activa deriva solo las dos lecturas existentes y control de retirada del activo.

Prepare verifica un conjunto de 1–100 activos de un candidato; activate verifica
otra vez la misma identidad y relación Instagram/página. Una selección por flujo,
conjunto inmutable y claims físicos únicos entre ámbitos. Claims del padre son
exclusión de conflictos, no permisos para leer un activo no seleccionado.
El registro y el recibo comparten transacción con la auditoría técnica v2. Comandos
inciertos conservan evidencia; no vuelve a canjearse código ni a escribirse token.

OAuth, selección, claims, comandos y auditoría comparten el único SQLite propietario.
Los guards leen la política vigente del Broker, estado del flujo y bloqueos durante
el I/O. Falta un claim o aparece una baja: no hay datos. El control de un activo
invalida la selección atómica completa, incluidos los restantes; conservar este
efecto al diseñar el consumidor y la confirmación humana. No borrar historial para
reenrolar un activo. Los tombstones anteriores a prepare solo bloquean esa selección.

## Credencial y retención de versión

Se reutiliza el VersionId/digest del candidato y se exige que conserve AWSPENDING
antes/después del uso. AWSCURRENT sigue siendo el slot vacío. No Put, List, Create,
Delete o UpdateSecretVersionStage durante selección/activación/lectura. La inspección
comprueba USER/app/scopes/granular/caducidad; los pins de app/slot/KMS se revalidan.
Una lectura de activo consulta su endpoint fijo, con comprobación del padre para IG.
Estado del token hace dos inspecciones y no acredita acceso al activo concreto.

AWS permite leer por [VersionId](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html).
Una versión que pierde su última etiqueta puede eliminarse; por eso este nuevo
consumidor exige conservar la etiqueta, además de identidad y digest. Véase
[gestión de etiquetas](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html).
No mover AWSPENDING, activar rotación, limpiar versiones o promover AWSCURRENT
para recuperar un fallo. Comprobar IAM y retención reales antes de publicar.
El contrato anterior de diagnóstico de candidatos por UUID permanece separado.

## Recursos y publicación

Misma unidad/SQLite, dos solicitudes ordinarias y una de control reservada;
una operación ordinaria por selección, 20/minuto/principal, 25 s por operación y
8 s HTTP. El índice
`meta_marketing_revoked_asset` y consultas por lotes evitan escanear todas las bajas
por cada activo; claims y selecciones se consultan por claves. Esto no reserva CPU,
disco, red o SQL ni acredita la carga real del proveedor o del CRM.

El lector preexistente de Meta continúa disponible como componente independiente.
El nuevo recorrido requiere dirigir los clientes de lectura/control al runtime
que posee la selección, con sus identidades y configuración exactas; no hacer
fallback al lector anterior, a tokens SQL o a otra base SQLite. Antes del corte,
verificar e incorporar el historial físico autorizado de todos los consumidores;
el código no puede conocer bajas de otro archivo/servidor no incorporado.

Falta el escritor CRM: sesión/MFA, permiso de todas las clínicas, identidad,
asignaciones, aliases/primarias/shares, historial independiente y commit local tras
resultado del broker. Una activación solo en broker no permite afirmar conexión
clínica completada. El consumidor nuevo añadirá auditoría humana y UI antes de
aceptar la fase. No se añade un job ni DDL MySQL aquí, ni se migra el callback legacy.

No desplegar todo DEV. Seleccionar dependencias, revisar migraciones anteriores,
IAM/slots/grants/TLS, registros y fuente de configuración por entorno. Mantener
compatibilidad del lector AWS antes de escritores/productores humanos. Este corte
usa técnica v2 y no añade versión humana al v23 preparado. Archivo/seis eventos
del canary v19 sin modificar. No tocar MFA, pausas, Vitaldiet o jobs clínicos DEV.

## Diagnóstico y recuperación

- `not_found`: aún no hay selección registrada; no implica permiso para activar.
- `prepared`: selección verificada y reservada, sin lectura concedida.
- `active/accessBlocked=false`: grants locales válidos en ese instante; no es una
  comprobación nueva de Meta ni un commit de asignaciones del CRM.
- `revoked/accessBlocked=true`: conservar tombstone, claims y bajas.
- `outcome_unknown`: consultar status con el mismo enrollmentId. Recuperar recibo
  completado con la UUID original; si no hubo commit, una nueva operación explícita
  puede usar otra UUID sobre esa misma selección. No reenviar código OAuth.
- `secret_version_changed`: verificar pins y etiqueta de la versión aprobada;
  mantener bloqueado. No sustituir credencial ni mover etiquetas automáticamente.

Para cerrar altas nuevas conservando retirada/lectura existente, deshabilitar el
principal gateway OAuth en la configuración validada y publicar selectivamente;
los dos controles permanecen. Para bloquear también lecturas, deshabilitar además
el lector. No quitar el módulo y sus controles mientras existan selecciones a
conciliar. Conservar el SQLite y su recuperación; los cambios de configuración
requieren el procedimiento de reload/reinicio, no basta editar el archivo.
Abortar OAuth deja sin acceso sus selecciones. No bajar esquema ni restaurar un
SQLite antiguo que borre revocaciones. Copias/restauración general al final.

## Pruebas reproducibles

Desde `services/integrations-broker`, Node 24 y red exterior cerrada:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/meta-marketing-enrollment.test.js test/meta-marketing-enrollment-runtime.test.js
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
```

Regresión y capacidad desde backend:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_CRM_VISUAL=1 META_OAUTH_DISCOVERY_TEST=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
node --test src/scripts/tests/meta_marketing_oauth_http.test.js src/scripts/tests/google_oauth_broker_http.test.js
node --require ./services/integrations-broker/test/offline-guard.cjs --test src/scripts/tests/meta_marketing_enrollment_capacity.test.js
```

SQLite/TLS y cliente de lectura CRM reales; Secrets/Meta/S3 ficticios. La regresión
MySQL/Chromium recorre OAuth/inventario ya existente, no una selección CRM nueva.
Ninguna prueba usa token histórico, abre Facebook o activa campañas/leads/envíos.
Evidencia, conteos finales y commits en 99 y en la carpeta privada
`qa-evidence/security-resume-20260917/meta-enrollment-20260919/`.


## Evidencia local del 19/09/2026

- Suite completa del broker: 734/734. El subconjunto de enrollment tiene 19 casos;
  los 65 casos dirigidos de enrollment/OAuth/discovery/TLS están incluidos en el total.
- Cliente CRM real sobre HTTPS firmado, SQLite y reinicio reales; prueba de selección
  concurrente de dos ámbitos y bloqueo de una relación Instagram/página compartida.
- Capacidad separada: 1/1, con 100 seleccionados y 10.000 bajas ficticias preexistentes.
  Prepare 51 ms, activate 58 ms, una lectura 60 ms; 48 llamadas Secrets y 11 Graph
  simuladas entre las tres operaciones. Una baja nueva bloquea antes de Secrets.
  No extrapolar a AWS/Meta ni a CPU/SQL del servidor CRM bajo carga.
- Muestra de tres activos, seis operaciones: 96 Secrets / 20 Graph. El chequeo extra
  de etiqueta se incluye en estas cifras, sin atribuirle coste facturado inexistente.
- Regresión de routers OAuth/Google: 6/6; MySQL/Chromium y sintaxis finales en99.
  Frontend solo cambia documentación; no se publica ni añade pantalla de selección.

Coste incremental real `null`; no se consultó Cost Explorer ni se crearon recursos.
Estado/push/hashes en `source-final.json` privado y fuentes cambiadas en
`meta-marketing-enrollment-consumers.json`. La medición es ficticia y no acepta
la migración de conexiones reales ni reemplaza las comprobaciones del titular.
