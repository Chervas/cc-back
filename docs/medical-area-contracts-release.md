# Corte de versiones de áreas médicas

> **Tipo:** runbook técnico, no estado ni roadmap.
> **Fuente de verdad funcional:** [18.2](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/18.2-sistema-tratamientos.md#configuración-de-áreas-versionada-por-clínica).
> **Última revisión:** 2026-09-26.

## Alcance

Solo `20260926180000-version-medical-area-contracts.js`: dos tablas,
referencias desde la cabecera/mediciones y snapshots iniciales por clínica.
No ejecuta la cola de migraciones pendientes, no activa programas ni mensajes.
El script no carga modelos de la aplicación ni modifica su entorno.

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
  --approved-migration-sha256 HUELLA_SHA256 \
  --backup-manifest RUTA_PRIVADA/backup-manifest.json \
  --private-journal RUTA_PRIVADA/corte-areas.jsonl
```

El ejecutor registra commit, hash y respaldo antes de DDL. Comprueba cobertura
clínica/área, cabeceras y columna nullable antes de insertar `SequelizeMeta`.
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
