# Corte de versiones de áreas médicas

> **Tipo:** runbook técnico, no estado ni roadmap.
> **Fuente de verdad funcional:** [18.2](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/18.2-sistema-tratamientos.md#configuración-de-áreas-versionada-por-clínica).
> **Última revisión:** 2026-09-27.

## Alcance

Una migración explícita por ejecución, exclusivamente del allowlist:

- `20260926180000-version-medical-area-contracts.js` (predeterminada): dos tablas,
  referencias desde la cabecera/mediciones y snapshots iniciales por clínica.
- `20260927103000-create-medical-area-adoptions.js`: diario append-only de
  adopciones revisadas. Requiere el corte inicial y no cambia asignaciones.

No ejecuta la cola de migraciones pendientes, no activa programas ni mensajes.
El script no carga modelos de la aplicación ni modifica su entorno.

La configuración HTTP de áreas pertenece a la API, no al gateway. Comprobar
`medical_area_api_boundary.test.js` y `medical_area_controller_scope.test.js`:
el gateway debe responder 404 `medical_area_api_required` en ambos prefijos de
áreas antes de sus controladores antiguos. No promocionar el router completo
ni otros módulos de DEV para cerrar esa vía: integrar únicamente la frontera
compatible en el router efectivo del gateway, con su preflight de seguridad.
Conservar MFA, namespaces, workers y proveedores; las rutas OAuth/webhook no
forman parte de este corte. Verificar después que las lecturas autenticadas de
áreas siguen respondiendo en la API de la aplicación. Este cierre no acredita
modernización de todos los servicios internos del gateway.

## Antes del corte

1. DEV limpio/commiteado, misma candidata front/back y pruebas focales:
   `medical_area_contracts.test.js`, `medical_area_controller_scope.test.js`,
   `nutrition_measurement_context.test.js`, `nutrition_workspace.test.js` y
   `medical_area_versions_mysql.integration.js`. La última usa exclusivamente
   MySQL temporal por socket con `CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1`.
2. Compilar frontend, verificar runtime y usuarios conectados. Elegir una ventana
   sin edición de áreas ni altas de clínicas durante el corte inicial. Hasta
   publicar el backend antiguo no crea asignaciones; comprobar cobertura al final.
3. Backup completo del **mismo entorno** en directorio nuevo privado con
   `cliniccloud-operator-backup.js --target dev|crm --private-directory RUTA`.
   Debe tener hash/gzip/final de dump verificados y menos de dos horas.
4. Comprobar la huella de la migración; nunca copiar credenciales o datos de CRM
   a DEV. Usar primero DEV ficticio; CRM requiere aceptación del candidato.

## Ejecución acotada

Desde `/home/ubuntu/wt/back-dev`, sustituir los valores por rutas/huella verificadas:

```bash
node src/scripts/medical-area-schema-release.js \
  --target dev \
  --migration 20260927103000-create-medical-area-adoptions.js \
  --approved-migration-sha256 HUELLA_SHA256 \
  --backup-manifest RUTA_PRIVADA/backup-manifest.json \
  --private-journal RUTA_PRIVADA/corte-areas.jsonl
```

El ejecutor registra commit, hash y respaldo antes de DDL. Comprueba cobertura
clínica/área, cabeceras y columna nullable antes de insertar `SequelizeMeta`.
Para el diario comprueba columnas, índice y FK restrictivas; conserva la huella
de todas las asignaciones antes/después. Si ya está aplicada, verifica el
esquema sin repetir DDL. No aplicar la DDL sobre una candidata sin commitear.
Un error conserva diario y DDL parcial para inspección; no reiniciar ni aplicar
migraciones genéricas. El DML se revierte conjuntamente. Un replay de la
migración conserva las versiones ya publicadas/asignadas.

## Publicación y aceptación

Publicar la release DEV aislada y sus assets según 25/30/31. Preflight de
seguridad no sustituye el anterior control SQL del módulo. Comprobar en Chromium:
versión visible, guardar idéntico sin nueva revisión, publicar una modificación
ficticia, clínica existente intacta, alta nueva con revisión publicada, conflicto
de edición concurrente y medición/informe con revisión de origen. Comprobar
clínica secundaria y cierre de permiso, además de escritorio/móvil.

Para la UI de adopción: `Áreas médicas > Versiones por clínica`, buscar una
clínica ficticia, comparar versiones, revisar cambios y marcar aceptación.
Comprobar actualización de esa clínica y diario en la misma transacción;
segunda clínica, ajustes locales e historias intactos. Simular conflicto
entre revisión y aplicación: debe exigir nueva revisión. El botón no puede
repetir automáticamente una escritura cuyo resultado no se confirmó.
Orden de publicación: diario aditivo → API compatible → frontend. API antigua
no accede al diario y sigue operando durante el corte; no habilitar la UI
nueva contra un backend que todavía acepte adopciones sin revisión.

La aceptación autenticada reproducible está en el frontend,
`scripts/tests/clinic_area_adoption_dev_chromium_qa.js`. Usa exclusivamente
`localhost:4203`, la clínica ficticia multiárea DEV `110`, una sesión normal del
Chromium local y un backup DEV verificado de menos de dos horas:

```bash
QA_MEDICAL_AREA_DEV_WRITES=versioned-config-only \
QA_BACKUP_MANIFEST=RUTA_PRIVADA_DEV/backup-manifest.json \
node scripts/tests/clinic_area_adoption_dev_chromium_qa.js
```

Publica cambios ficticios, provoca una revisión caducada real, adopta desde la
interfaz y restaura la asignación original desde móvil. Conserva publicaciones
y diario inmutables de QA; no los borra. Contrasta huellas de tablas clínicas,
económicas, consentimientos, configuración local y asignaciones de las demás
áreas/clínicas. No intercepta respuestas ni crea sesiones, firmas, cobros o
citas. Ante un error reconcilia el resultado y restaura por API con control de
versión, sin sobrescribir cambios ajenos. Evidencia en directorio privado.
Este ensayo DEV no autoriza ejecutarlo contra una clínica real ni sustituye la
comprobación de lectura de la release en CRM.

En CRM repetir backup/corte y promoción fast-forward autorizada, sin copiar
filas desde DEV. Usar solo una clínica/paciente DEMO autorizados para QA con
escrituras. Verificar consumidores compartidos antes de reiniciar. No cambiar
MFA, configuración de proveedores, recordatorios retenidos ni namespace.

## Recuperación

Conservar tablas, referencias e informes: `down` se rechaza deliberadamente.
Antes de que existan publicaciones nuevas, el código anterior sigue pudiendo
leer la cabecera inicial. **Después de publicar/adoptar revisiones nuevas, no
volver a un backend que ignore asignaciones por clínica**: usar reparación hacia
delante o una release compatible con resolución versionada. No restaurar la BD
completa ni normalizar de nuevo snapshots históricos para resolver un fallo.

Evidencia y commits en [99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md);
madurez vigente en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md).
