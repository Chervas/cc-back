# Estado de seguridad: referencia trasladada

> **Tipo:** alias de compatibilidad documental.
> **Fuente de verdad:** [documento central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).
> **Ultima revision:** 2026-09-14.

Este archivo conserva enlaces antiguos; no mantiene estado, plan ni historial propios.
Consultar [16: prioridades](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/16-roadmap.md#seguridad-de-acceso-e-integraciones),
[19: estado](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones),
[98: antecedentes y originales íntegros](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/98-estado-historico.md#seguridad-integraciones-2026-09) y
[99: entregas](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md).
La [matriz de aceptación AWS](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md#matriz-de-aceptacion-aws)
pertenece al contrato 39. Procedimientos: [índice técnico](../README.md#seguridad).

## Continuidad del visor y compatibilidad AWS (18/09/2026)

La carga aparente infinita era reproducible en el frontend bajo un padre Angular
`OnPush`; corregidos Auditoría/Seguridad/Costes y publicados CRM/DEV local. Backend
real: lecturas de 293–619 ms; 25 recibos S3 verificados en 337 ms antes del corte.
Las copias reales de lector/escritor AWS con overlay v16 pasan 72 pruebas cada
una; lector publicado 18:16 UTC y escritor 18:17, sin cambiar TLS/config/estado.
25/25 recibos previos vuelven a verificarse en 328 ms y peticiones sin firma se
rechazan. Quedan pendientes la entrega real v16 y la QA autenticada del alta
Google; no se activaron nuevas integraciones. Evidencia y estado canónico en
el manual frontend 19/99; detalle de la carga en `audit-query-health.md`.

Costes: consulta de caché publicada en CRM; tabla creada también en DEV. Snapshot
real inicial con Budget de 60 USD y gasto etiquetado pendiente, sin convertirlo
en cero. Recogida permanente/diaria aún pendiente. No modificar el trust del rol
como sustituto de diseñar la identidad del colector. Copias de seguridad al final
por prioridad explícita del titular; conservar rollback de cada despliegue.
