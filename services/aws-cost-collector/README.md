# Costes AWS de integraciones y auditoría

Implementado y probado con datos ficticios, pendiente de despliegue, migración
de la BD compartida y verificación AWS. Paquete Node 24 con lockfile propio;
la API existente conserva Node 18. No instala ni reinicia runtimes utilizados.

## Flujo y contrato

El catálogo existente registra `awsInfrastructureCosts`, tipo durable
`aws_infrastructure_costs_refresh`, a las `03:40 Europe/Madrid`. Respeta los
gates de cron, leader y workers anteriores. `AWS_INFRA_COSTS_ENABLED` ausente
o distinto de `true` impide el encolado y la recogida. Una lectura de Ajustes
nunca encola, reactiva jobs ni llama a AWS.

El executor invoca `src/services/awsInfrastructureCosts.service.js`, que reserva
un lease en `AwsInfrastructureCostCaches`, ejecuta el colector y guarda el
snapshot. Trata mes actual y anterior UTC secuencialmente; la consulta diaria
excluye el día UTC aún abierto. Recalcula el anterior para recoger correcciones
de facturación. No carga pacientes, tokens ni estimaciones de IA.

La tabla nueva contiene clave de ámbito/mes, JSON saneado, fechas de recogida
e intento, error categorizado y lease UUID de 180 s. Un worker vencido no
sobrescribe al nuevo. El timeout del proceso es 90 s. Un fallo conserva el
último snapshot válido; uno incompleto no sustituye un importe disponible.
Sin importe completo el estado es `pending`; importe anterior con fallo o
antigüedad mayor de 36 h es `stale`. Fechas futuras también son atrasadas.
No hay reintento automático del lote fallido; el SDK limita a dos intentos
por llamada de lectura. Repetir manualmente un job habilitado sí puede
generar nuevas consultas; el lease impide concurrencia, no es un cupo de gasto.

`GET /api/metasync/jobs/usage/aws-infrastructure/costs?month=YYYY-MM`:
JWT y administración técnica global (IDs canónicos 1 y 44), `private, no-store`.
Solo mes actual/anterior; otro mes devuelve 400. Devuelve `month`,
`availableMonths`, `status`, `snapshot`, `lastAttemptAt`, `error`,
`collectionEnabled`, horario y referencia de Budget reportada. Sin tabla
devuelve pendiente con `cost_migration_required`; no ejecuta la migración.
El snapshot proyecta importes como strings decimales, moneda, desglose por
servicio/componente calculado en backend, UTC del periodo y de la recogida,
marcador de estimación, forecast separado y Budget. Nunca devuelve errores
SDK, cuenta/ARN, credenciales o campos adicionales del JSON guardado.

UI en Ajustes > Monitorización > Costes AWS (`tab=aws`), escritorio/móvil:
actualizar vista, elegir mes, gasto, previsión restante, presupuesto de
referencia, estados pendiente/atrasado y fecha mostrada en Madrid. No polling
del colector ni porcentaje del Budget mientras filtro/métrica difieran.

## AWS y precisión

`main.js` acepta por stdin un JSON cerrado: cuenta `137819318729`, entorno
`prod`, rol `clinicaclick-integrations-prod-cost-reader-role` y mes. No hay
opciones de endpoint, región, credenciales, filtro o consulta arbitraria.
La API usa `execFile` con binario absoluto `AWS_INFRA_COSTS_NODE_BINARY` y
script fijo, sin shell. El proceso hijo recibe solo PATH, TZ e IMDSv2 requerido:
excluye `.env`, credenciales AWS de la app, SSO, proxies y opciones de Node.

El SDK usa IMDS como principal origen y AssumeRole de 15 min al rol de costes,
sin cadena por defecto ni fallback a claves. Comprueba `GetCallerIdentity`
antes de facturación. STS región eu-west-3; CE y Budgets us-east-1. El
principal del host que ejecutará el cron debe verificarse y aprobarse antes
de habilitar el trust; no se presupone que sea el instance role del broker.
El manifiesto recibido solo confía en el SSO del aprovisionador.

Llamadas: `ListCostAllocationTags`, `GetCostAndUsage`, `GetCostForecast`,
`DescribeBudget`. Tres etiquetas activas obligatorias: application,
component, environment. Uso diario con métrica `UnblendedCost`, filtro AND
de cuenta, application=clinicaclick, component=integrations|audit y
environment=prod; agrupación SERVICE + component. Hasta 100 páginas de uso
por mes y 10 de metadata de tags; tokens repetidos, grupos duplicados,
monedas incompatibles o scope inesperado hacen fallar la recogida.
Importes/créditos se suman con BigInt a 18 decimales. Días ausentes no son cero.

La previsión cubre solamente los días restantes del mes actual; no se suma
en la UI al gasto observado. El Budget consultado es el vigente al recoger,
identificado con `referenceMonth`, aunque se consulte gasto del mes anterior.
Solo reconoce el filtro y métrica canónicos exactos como comparables. El
Budget recibido es más amplio y su aviso ACTUAL 100% está fuera de CF.
Sin lectura de Budget, muestra los 60 USD reportados como no verificados.

Las etiquetas activas no demuestran que todos los cargos estén etiquetados ni
que exista backfill. La vista excluye gastos sin tags y no representa la
factura total. Los filtros del código tampoco acreditan aislamiento IAM por
tags: el permiso de lectura CE puede permitir consultar otros costes de la
cuenta; su alcance efectivo debe revisarse antes de asignar el rol.

## Lote pendiente para activar

1. SSO temporal mínimo autorizado: identidad, CE/tags, Budget, policies/trusts
   y host del cron leader. No leer valores de Secrets ni usar el SSO admin
   del aprovisionador. Registrar las diferencias antes de cambiar IAM.
2. Revisar el rol de costes existente: permisos CE de lectura citados
   (la entrega no incluye `ce:ListCostAllocationTags`), `budgets:ViewBudget`
   sobre el presupuesto exacto y trust al principal origen verificado con
   `sts:AssumeRole`. No conceder Secrets, KMS decrypt, escritura Budget ni
   permisos del broker a la API general. Comprobar restricciones de la
   billing view y permisos dependientes reales; ningún IAM cambiado aquí.
3. Aprobar commits exactos backend/frontend, Node 24 separado y dependencias
   en el host del cron; reservar ventana y copiar artefactos sin promover
   campañas. La API y UI pueden publicarse con el gate apagado.
4. Respaldar esquema/SequelizeMeta y aplicar únicamente
   `20260912180000-create-aws-infrastructure-cost-caches.js` a la BD compartida,
   verificando compatibilidad de runtimes. No usar `db:migrate` global.
   Esta tabla aditiva no migra credenciales ni acredita cifrado clínico.
5. Aprobar primer lote de lectura AWS y su coste; verificar filtros/importes,
   persistencia tras reload, IAM efectivo y una sola ejecución del cron.
   Activar solo el gate de costes, preservando las pausas previas.

Sin crear recursos nuevos, CE genera coste por consulta/página. AWS publica
0,01 USD por petición de la billing view primaria. Como estimación conservadora,
cinco peticiones CE diarias sin paginación ni reintentos serían 1,55 USD/31 días;
no es una factura ni un máximo. Los límites de páginas admiten un coste superior
al Budget si se agotan o se repite manualmente el job: medir el primer lote y
aprobar volumen/límites antes de activar. El Budget no detiene el gasto.
No se ha realizado ninguna de estas lecturas AWS.

Rollback: apagar solo `AWS_INFRA_COSTS_ENABLED`, volver a artefactos seguros
anteriores y conservar la caché; no hace falta borrar la tabla. El `down`
elimina únicamente esta tabla y sus snapshots: usar solo si el lote aprueba
esa eliminación y existe respaldo. No reiniciar ni reactivar otros jobs.

## QA reproducible

En este paquete, Node 24: `npm ci --ignore-scripts` y `npm test`.
En backend, Node 18:

```bash
node --test src/scripts/tests/aws_infrastructure_costs.test.js src/scripts/tests/aws_infrastructure_costs_http.test.js src/scripts/tests/social_asset_stats_security.test.js
node --require ./src/scripts/tests/fixtures/security_offline_runtime.cjs src/scripts/tests/scheduled_jobs_orchestration.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/aws_infrastructure_costs_mysql.integration.js
```

MySQL usa datadir/socket propios, TCP bloqueado y ningún modelo/entorno real.
La prueba HTTP usa JWT aleatorio efímero, nunca una sesión real. En frontend:
build Angular local a directorio de QA y
`QA_STYLES_DIR=<build-local> node scripts/tests/aws_costs_chromium_qa.js`.
Chromium usa perfil nuevo, servicio ficticio y red externa interceptada;
componentes/navegación reales, sin login contra la aplicación publicada.

Referencias oficiales consultadas 12/09/2026:
[uso](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html),
[previsión](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostForecast.html),
[Budget](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_Budget.html),
[permisos CE](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ce.html),
[permisos Budget](https://docs.aws.amazon.com/service-authorization/latest/reference/list_budgets.html).
AWS recomienda caché y describe facturación por página en sus
[buenas prácticas](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api-best-practices.html);
tarifa en [Cost Explorer Pricing](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing/).
