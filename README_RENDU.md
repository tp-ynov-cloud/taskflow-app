## A. Instrumenter l'application

### SDK OpenTelemetry — `tracing.js`

Chaque service expose un fichier `src/tracing.js` qui :

1. **Initialise le SDK** avec `NodeSDK`
2. **Déclare la ressource** via `new Resource({ SERVICE_NAME: serviceName })` — permet d'identifier le service dans Tempo/Grafana
3. **Exporte les traces** vers l'OTel Collector en OTLP HTTP (`/v1/traces`)
4. **Active les auto-instrumentations** HTTP, Express et PG via `getNodeAutoInstrumentations`
5. **Gère le shutdown proprement** : écoute `SIGTERM` et `SIGINT`, appelle `sdk.shutdown()` pour vider les buffers de traces/métriques avant de quitter

Le fichier est chargé en premier dans chaque `index.js` via `require("./tracing")` (première ligne), ce qui garantit que l'instrumentation est active avant tout démarrage de service.

S'assurer qu'en cas de shutdown, les traces et métriques en attente soient bien exportées :
![shutdown-open-telemetry](screenshots/shutdown-open-telemetry.png)

Il faut se gréffer sur l'évènement shutdown du process pour faire un `sdk.shutdown()`

---

### OTel Collector — `infra/otel/config.yml`

Le collector est configuré avec :

1. **Receivers** : `otlp` avec les deux protocoles — gRPC (port 4317) et HTTP (port 4318)
2. **Exporter Tempo** : `otlp/tempo` en gRPC vers `tempo:4317` (plus performant qu'HTTP pour du backend-to-backend), TLS désactivé en local
3. **Exporter console** : `debug` pour inspecter les traces/métriques en développement
4. **Métriques internes** : exposées sur `0.0.0.0:8888` via `service.telemetry.metrics`, scrapable par Prometheus
5. **Pipelines** :
   - `traces` : `otlp` → `batch` → `[otlp/tempo, debug]`
   - `metrics` : `otlp` → `batch` → `[debug]`

---

### Tempo — `infra/tempo/tempo.yml`

1. **API/UI sur le port 3200** : `server.http_listen_port: 3200` — c'est l'adresse que Grafana utilise comme datasource Tempo
2. **Réception gRPC** : `distributor.receivers.otlp.protocols.grpc` sur `0.0.0.0:4317` — protocole plus performant qu'HTTP pour la communication OTel Collector → Tempo
3. **Stockage local** : `storage.trace.backend: local` avec `path: /tmp/tempo/traces`
4. **Write-Ahead Log** : `wal.path: /tmp/tempo/wal` — buffer temporaire sur disque qui protège les traces en cas de crash avant leur écriture définitive

---

### Prometheus — `infra/prometheus/prometheus.yml`

**Config globale** : `scrape_interval: 15s` et `evaluation_interval: 15s` — Prometheus scrape les cibles toutes les 15 secondes.

**Scrape configs** :

| job_name | target |
|---|---|
| `prometheus` | `localhost:9090` (auto-scrape) |
| `api-gateway` | `api-gateway:3000` |
| `user-service` | `user-service:3001` |
| `task-service` | `task-service:3002` |
| `notification-service` | `notification-service:3003` |
| `otel-collector` | `otel-collector:8888` |

Chaque service expose un endpoint `/metrics` en format Prometheus. Le collector OTel expose ses métriques internes sur le port 8888 (configuré via `service.telemetry.metrics` dans `infra/otel/config.yml`).

---

### Grafana — provisioning automatique

#### Datasources — `infra/grafana/provisioning/datasources/datasources.yml`

Grafana charge automatiquement les datasources au démarrage via le système de provisioning. Deux datasources sont configurées :

- **Prometheus** (`http://prometheus:9090`) — définie comme datasource par défaut (`isDefault: true`)
- **Tempo** (`http://tempo:3200`) — port 3200 configuré dans `tempo.yml`

#### Dashboards — `infra/grafana/provisioning/dashboard/dashboard.yml`

Le provider `file` indique à Grafana de charger tous les JSON présents dans `/var/lib/grafana/dashboards` au démarrage. Ce dossier sera monté via un volume Docker pointant vers `infra/grafana/dashboards/`.

---

### docker-compose.infra.yml

#### Services et dépendances

| Service | Image | Ports exposés |
|---|---|---|
| `tempo` | `grafana/tempo:latest` | `3200` (API/UI) |
| `otel-collector` | `otel/opentelemetry-collector-contrib:latest` | `4317` gRPC, `4318` HTTP, `8888` métriques internes |
| `prometheus` | `prom/prometheus:latest` | `9090` |
| `grafana` | `grafana/grafana:latest` | `3100` → `3000` |

#### Chaîne de dépendances

```
tempo
  └── otel-collector (depends_on: tempo)
        └── prometheus (depends_on: otel-collector)
              └── grafana (depends_on: prometheus + tempo)
```

Tempo doit démarrer en premier car l'OTel Collector lui envoie des traces dès le lancement. Prometheus dépend du collector pour scraper ses métriques internes. Grafana attend Prometheus et Tempo pour que ses datasources soient disponibles.

---

## B. Visualisation de l'application

### Métriques métier

Ajout des metrics customs dans chaque services.
