# Cache persistente de Informes Marketing

`GET /api/marketing/reports/overview` sirve el informe `Mi clínica` desde una
caché persistente backend cuando existe un snapshot fresco. La caché del
navegador queda solo como capa corta de experiencia SPA; la fuente autoritativa
es `MarketingReportOverviewCaches`.

## Cadencia

| Capa | Cadencia por defecto | Contrato |
|---|---:|---|
| Sincronización Ads | `00:20` Google Ads, `00:30` Meta Ads | Persiste facts diarios y campañas. |
| Social orgánico | `02:00` | Persiste seguidores, posts y agregados por asset. |
| Web/Search Console/PSI | `04:15` | Persiste series web y salud técnica reciente. |
| GA4 | `04:45` | Persiste sesiones, usuarios y dimensiones. |
| Perfil Google | `05:10` | Persiste rendimiento local, reseñas y publicaciones. |
| Snapshots `Mi clínica` | `06:30 Europe/Madrid` (`JOBS_MARKETING_REPORTS_CACHE_SCHEDULE`) | Materializa últimos 30 días por clínica activa y limpia snapshots antiguos. |
| Mapa local Competencia | semanal/stale bajo demanda | No entra en el refresco diario. |

El job `marketingReportsCacheRefresh` crea un `JobRequest` de tipo
`marketing_reports_cache_refresh`. El worker ejecuta el mismo builder que usa el
endpoint, por lo que el payload cacheado conserva el contrato JSON real del
front.

La timezone operativa del scheduler es `JOBS_TIMEZONE` y su valor por defecto es
`Europe/Madrid`. Las expresiones tipo cron de Informes se leen por tanto en hora
España, para que cuadren con la lectura habitual de logs y operación. Los
bridges OPS que migraron desde crontab conservan override `UTC` de forma
explícita para no desplazar su cutover histórico.

## TTL y estados

- Un snapshot de `Mi clínica` es `fresh` durante 24 horas
  (`MARKETING_REPORT_OVERVIEW_CACHE_FRESH_TTL_MS`).
- Después pasa a `stale` hasta 72 horas por defecto
  (`MARKETING_REPORT_OVERVIEW_CACHE_EXPIRES_TTL_MS`), para evitar pantallas
  vacías si una noche falla. Una lectura `stale` devuelve el dato conocido y
  encola un único refresco durable con lease de 30 minutos.
- `forceRefresh=true`, `force_refresh=true` o `refresh=true` fuerza recálculo y
  persiste el snapshot actualizado.
- La respuesta añade `cache.status`, `cache.generated_at`,
  `cache.fresh_until`, `cache.expires_at`, `cache.data_cutoff_at` y
  `cache.refresh_in_progress`. El resto del payload no cambia.

## Mapa local

El mapa de Competencia sigue usando `MarketingCompetitionHeatmapCaches`:
`fresh` 7 días, `stale` hasta 14 y `expired` después. Una lectura compacta con
`cached_only=true` solo hace `peek`: no crea fila, no toma lease, no llama a
Places y no encola jobs. La vista completa o una selección explícita de
Competencia puede encolar `marketing_competition_heatmap_refresh` si la
identidad está obsoleta y el proveedor está permitido.

## Operación

- Revisar programados: `GET /api/metasync/jobs/scheduled`.
- Reencolar manualmente desde monitor o mediante `JobRequest` de tipo
  `marketing_reports_cache_refresh` con `clinicIds` si se quiere acotar.
- Para un snapshot concreto, el payload puede llevar `cacheKey`, `identity` y
  `refreshToken`; este camino lo usa el stale-while-refresh del endpoint.
- `system_data_cleanup` y el propio job diario eliminan snapshots caducados,
  filas vacías antiguas y versiones de informe reemplazadas.
- El mapa local nunca debe añadirse al refresh diario general: si el cálculo es
  caro, se refresca al entrar en Competencia o al seleccionar esa medición.
