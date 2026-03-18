> **Módulo:** Arquitectura del Backend
> **Última actualización:** 2026-03-18
> **Relacionado con:** [20.1-motor-flujos-v2](./20.1-motor-flujos-v2.md)

---

## 2026-03-18 - Contratos de Backend para Campañas v4 (`new_patients`)

> **Estado:** Definición

Esta sección documenta los contratos de backend necesarios para dar soporte a la nueva UX y al modelo de datos del wizard de `new_patients`.

### 1. Persistencia de la Estrategia (`Strategy`)

Se crea una nueva tabla `Strategies` para almacenar la configuración de cada campaña. El modelo de datos se corresponde con el definido en el documento `20.10-modelo-datos-campanas-v4.md`.

**Endpoints CRUD para `Strategy`:**

-   `POST /api/marketing/strategies`: Crea una nueva estrategia (en estado `draft`).
-   `GET /api/marketing/strategies`: Lista las estrategias para el scope actual.
-   `GET /api/marketing/strategies/:id`: Obtiene el detalle de una estrategia.
-   `PUT /api/marketing/strategies/:id`: Actualiza una estrategia (solo en estado `draft`).
-   `DELETE /api/marketing/strategies/:id`: Elimina una estrategia (solo en estado `draft`).

### 2. Gestión del Lifecycle de la Estrategia

-   `PATCH /api/marketing/strategies/:id/status`: Transiciona el estado de una estrategia (ej: de `draft` a `pending_approval`).

### 3. Medición y Métricas

-   `GET /api/marketing/strategies/:id/metrics`: Obtiene las métricas de rendimiento de una estrategia activa (ROI, CPL, etc.).
-   `POST /api/intake/pageview`: Nuevo endpoint para que el snippet `intake.js` registre las visitas a la web, alimentando las audiencias de **remarketing**.

### 4. Capacidad de Llamadas desde Anuncio

-   El backend debe tener la capacidad de recibir webhooks o datos de la API de Google Ads para registrar las llamadas iniciadas desde anuncios.
-   Se añadirá un campo a la tabla de leads o a una tabla relacionada para registrar `call_from_ad_timestamp` y `call_from_ad_duration`.
-   **Estado:** **Futuro.** No se implementará en el MVP inicial.

### 5. Capa de Recomendación de Automatizaciones

-   Se creará una nueva tabla `AutomationRecommendationRules`.
-   **Campos:** `objective_id`, `treatment_id` (o `discipline_id`), `automation_template_key`.
-   **Endpoint:** `GET /api/marketing/automation-recommendations?objective_id=...&treatment_id=...`
-   Este endpoint será consumido por el wizard de `new_patients` para sugerir la automatización más adecuada.

### 6. Estados Futuros de Aprobación

-   El enum `StrategyStatus` incluirá estados como `pending_human_approval` y `rejected`.
-   Se creará un panel de administración (futuro) para que el equipo de ClinicaClick revise y apruebe las campañas de los modos gestionados, lo que implicará nuevos endpoints de admin para listar y accionar sobre estas estrategias pendientes.

---

(El resto del documento sobre la arquitectura de conexiones OAuth por scope se mantiene sin cambios para preservar el contexto histórico).
