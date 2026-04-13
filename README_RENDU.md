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
