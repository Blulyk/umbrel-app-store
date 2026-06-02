# JARVIS Widget Engine

JARVIS usa un motor declarativo de widgets. El modelo o el parser de comandos no ejecutan JavaScript dentro del DOM principal; crean manifiestos JSON validados por Pydantic en el backend.

## Crear Widgets

Escribe en la barra inferior comandos como:

- `crea un monitor de red`
- `crea un widget de logs`
- `crea un dashboard con CPU RAM y disco`
- `crea un preview de URL`
- `crea un checklist de tareas`
- `crea una tabla`
- `mueve el widget arriba a la derecha`
- `hazlo más grande`
- `actualízalo cada 10 segundos`
- `limpia el canvas`

El micrófono usa push-to-talk con el botón `MIC` o `Ctrl + Space`. `Escape` cancela escucha/paneles.

## Manifiesto

Campos principales:

```json
{
  "id": "widget_network_monitor",
  "type": "metric_grid",
  "title": "Monitor de red",
  "description": "Latencia, trafico y estado del enlace",
  "status": "active",
  "layout": { "x": 420, "y": 260, "w": 420, "h": 260, "zIndex": 5 },
  "refreshInterval": 5000,
  "dataSource": {
    "type": "internal_tool",
    "toolName": "get_network_status",
    "params": {},
    "errorHandling": "stale"
  },
  "config": {},
  "actions": [],
  "permissions": { "canRead": true, "canWrite": false, "canExecuteActions": true }
}
```

## Tipos Disponibles

`status_card`, `metric_card`, `metric_grid`, `line_chart`, `bar_chart`, `table`, `log_viewer`, `markdown`, `checklist`, `form`, `image_preview`, `web_preview`, `command_panel`, `service_monitor`, `calendar_panel`, `file_panel`, `chat_panel`, `automation_panel`, `iframe_sandbox`.

Algunos conectores devuelven datos mock marcados como `mock: true` hasta conectar servicios reales.

## Data Sources

Tipos preparados: `static`, `mock`, `internal_tool`, `http_endpoint`, `websocket`, `local_storage`, `system_metric`, `manual_input`.

Herramientas iniciales: `get_system_status`, `get_network_status`, `get_cpu_ram_status`, `get_storage_status`, `get_recent_logs`, `get_service_status`, `restart_service`, `sync_workspace`, `get_calendar_preview`, `get_assets_list`.

## Persistencia

El layout se guarda en SQLite mediante `MemoryStore` bajo `jarvis_widget_layout_v1`.

```json
{
  "version": 1,
  "widgets": [],
  "canvas": {
    "zoom": 1,
    "offset": { "x": 0, "y": 0 },
    "grid": true
  }
}
```

Crear, mover, redimensionar, duplicar, borrar e importar layout guardan automaticamente.

## Seguridad

- No se ejecuta codigo JavaScript generado por IA.
- Los manifiestos se validan con Pydantic.
- Markdown se renderiza con sanitizacion basica.
- URLs peligrosas quedan bloqueadas: solo `http` y `https` para previews.
- `iframe_sandbox` usa sandbox.
- Acciones destructivas requieren confirmacion.
- Cada accion se registra en audit log.
- Los permisos de widget controlan lectura, escritura y ejecucion.
- No se guardan secretos en localStorage.

## Añadir Nuevos Tipos

1. Añade el tipo al literal `WidgetType` en `alfred/widget_engine.py`.
2. Añade un renderer en `alfred/static/app.js`.
3. Añade estilos en `alfred/static/styles.css`.
4. Si necesita datos, añade una herramienta en `alfred/tool_router.py`.

