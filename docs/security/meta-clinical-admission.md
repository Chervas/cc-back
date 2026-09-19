# Admisión del corte Meta y recuperación — 19/09/2026

Estado de este intento a las 15:15 UTC: **cancelado antes de respaldo/DDL;
estado operativo previo recuperado**. El esquema clínico se aplicó después a las
15:40 UTC; acta vigente en [meta-clinical-cut.md](meta-clinical-cut.md).
Complementa el primer intento documentado en `meta-clinical-schema.md`.

Código primero en DEV `5e23a433`, candidata `0cbf9214`: barrera SQL de admisión,
pausas BullMQ con recibo de propiedad y coordinador. Siete pruebas pasan en la
candidata, con MySQL/Redis aislados y los dos métodos reales de reclamación.
No equivalen a aceptación del ejecutor público que conecta esos componentes.

## Segundo intento y recuperación

- Inicio 15:09:58 UTC; conserva siete colas previamente pausadas y pausa otras
  cinco. Detiene las dos unidades WhatsApp; toma la barrera SQL.
- Aborto 15:10:00, `ddlStarted=false`, antes de solicitar parada de API/gateway.
  No se creó respaldo ni diario DDL. El error primario se redujo a
  `inspect_evidence`; no se conserva detalle suficiente para atribuir su causa.
- El recuperador rechazó la identidad de API/gateway: el plan contiene PID Node
  1963399/1963398, pero la inspección PM2 devuelve los padres npm
  1963371/1963381. No hubo reinicio de esas API. Quedaron las dos unidades
  detenidas y las cinco pausas temporales hasta la recuperación explícita.
- A las 15:15:16 se comprobó ausencia de la conexión/barrera SQL, esquema y
  hashes de las 43 filas originales, cola histórica gateway, fuentes y
  configuración, los PID originales y todos los recibos de pausa. Solo se
  iniciaron las dos unidades cuya parada estaba registrada; se retiraron solo
  las cinco pausas propias, conservando las otras siete.
- Unidades activas, `NRestarts=0`, PID 1966284/1966294. CRM HTTP 200 y
  `/api/auth/me` de ambas API 401 sin sesión. DEV y sus PID intactos. Esta
  verificación no es una prueba de MFA autenticado ni de entrega WhatsApp.

## Antes de volver a intentar

No ejecutar otra vez `cut-coordinated.cjs`, borrar recibos/actas ni reutilizar el
plan `meta-crm-20260919-0cbf9214`. Corregir y probar el vínculo entre PID del
gestor y PID de aplicación, preservar el error primario aunque falle recuperar
y diagnosticar ese aborto antes de cualquier nueva intervención. El diario DDL
no existe; no hay migraciones de este intento que revertir o repetir.

No hubo publicación de fuente/UI, cambio AWS, coste consultado, nueva conexión
Meta ni activación de sus gates. Las copias generales siguen aplazadas.
Evidencia privada: `qa-evidence/security-resume-20260917/meta-crm-admission-20260919/`;
`recovery-complete.json`, `candidate-admission-tests.log` y `CHECKPOINT.md`.
