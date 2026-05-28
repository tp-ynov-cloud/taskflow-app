Arnaud Gaydamour - Elias El Oudghiri

# Partie 1 - Observer l'application dans Grafana

## A. Instrumenter l'application

### SDK OpenTelemetry — `tracing.js`

Chaque service a un `src/tracing.js` qui init le SDK avec `NodeSDK`, déclare la ressource via `new Resource({ SERVICE_NAME: serviceName })` et exporte les traces vers l'OTel Collector en OTLP HTTP.

Auto-instrumentations HTTP, Express et PG activées via `getNodeAutoInstrumentations`. Le fichier est require en premier dans chaque `index.js` pour que l'instrumentation soit active avant tout démarrage.

Shutdown propre : on écoute `SIGTERM`/`SIGINT` et on appelle `sdk.shutdown()` pour vider les buffers.

![shutdown-open-telemetry](screenshots/shutdown-open-telemetry.png)

---

### OTel Collector — `infra/otel/config.yml`

Receivers `otlp` en gRPC (4317) et HTTP (4318). Export vers Tempo en gRPC (`tempo:4317`).

Métriques internes du collector exposées sur `0.0.0.0:8888` pour Prometheus. Deux pipelines : `traces` (otlp → batch → tempo + debug) et `metrics` (otlp → batch → debug).

---

### Tempo — `infra/tempo/tempo.yml`

API + UI sur 3200 (datasource Grafana). Réception des traces en gRPC sur 4317.

Stockage local (`/tmp/tempo/traces`) avec WAL (`/tmp/tempo/wal`) qui protège les traces en cas de crash avant écriture.

---

### Prometheus — `infra/prometheus/prometheus.yml`

Scrape interval 15s. Cibles : `api-gateway:3000`, `user-service:3001`, `task-service:3002`, `notification-service:3003`, `otel-collector:8888`.

---

### Grafana — provisioning automatique

Datasource Prometheus (`http://prometheus:9090`) en `isDefault`. Tempo sur `http://tempo:3200`. Les dashboards JSON dans `/var/lib/grafana/dashboards` sont chargés au démarrage.

---

### docker-compose.infra.yml

Ordre de démarrage : `tempo` → `otel-collector` → `prometheus` → `grafana`. Tempo doit être prêt avant le collector.

---

## B. Visualisation de l'application

### Métriques

Métriques métier déclarées dans `metrics.js` de chaque service.

- `task-service` : `tasks_created_total{priority}`, `tasks_status_changes_total{from_status,to_status}`, `tasks_gauge{status}` (mise à jour par `COUNT(*) GROUP BY status` après chaque mutation).
- `user-service` : `user_registrations_total`, `user_login_attempts_total{success}`.
- `api-gateway` : `upstream_errors_total{service}` (incrémenté à chaque proxy error).
- `notification-service` : `notifications_sent_total{event_type}`.

---

### Dashboards Grafana

Exportés dans `infra/grafana/dashboards/`, chargés au démarrage.

---

### Traces

#### Compréhension

Un `POST /api/tasks` génère une trace qui traverse api-gateway → task-service → PostgreSQL.

![scenario](screenshots/scenario.png)

Spans reliés par un `traceId` propagé via le header `traceparent`. Auto-instrumentation gère la propagation sans code.

Spans HTTP : `http.method`, `http.route` (pattern Express, pas l'URL), `http.status_code`, `span.kind` (`SERVER` côté receveur, `CLIENT` côté émetteur).

Spans PostgreSQL : `db.statement` (SQL complet, utile pour les requêtes lentes / N+1), `db.system=postgresql`, `net.peer.name=postgres`.

![alt text](screenshots/scenario_span_database.png)

`service.name` est commun à tous les spans d'un service, défini via `OTEL_SERVICE_NAME`.

#### Ajout de spans custom

Redis pub/sub n'est pas couvert par l'auto-instrumentation. Span manuel dans `task-service/src/routes.js` autour de la publication :

```js
const { trace } = require("@opentelemetry/api");
const tracer = trace.getTracer("task-service");

const span = tracer.startSpan("publish.task.created");
await publish("task.created", { taskId: task.id, title: task.title, assigneeId: task.assignee_id });
span.end();
```

Visible dans le waterfall entre `POST /tasks` et la fin de la requête. Recherche Tempo :

```traceql
{ name = "publish.task.created" }
```

![alt text](screenshots/public-task-created.png)

---

## C. Logs

### Configuration

Promtail en `docker_sd_configs` lit l'API Docker pour récupérer les métadonnées des conteneurs. Pipeline : extraction `level` et `msg` depuis le JSON Pino, puis conversion des niveaux numériques (30→info, 40→warn, 50→error) via `template`. Loki utilise le store `tsdb` avec stockage `filesystem`.

---

### Visualisation

#### Filtrer les logs du task-service

`{job="task-service"}` — sélecteur entre accolades, comme PromQL.

LogQL opère sur des lignes de texte, pas des valeurs. On filtre sur le contenu (`|= "error"`), on parse (`| json`), on extrait des champs. Résultat = flux de logs, pas un graphe.

![alt text](screenshots/loki-syntax.png)

Erreurs du task-service :

```logql
{service_name="/taskflow-app-task-service-1", level="error"} |= ``
```

![alt text](screenshots/loki-error.png)

#### Logs d'erreur et filtrage sur statusCode 500

Tous services, niveau error :

```logql
{job=~".+"} | json | level="error"
```

Filtrage 500 :

```logql
{job=~".+"} | json | statusCode=`500`
```

Prometheus = compteur agrégé indexé, conçu pour alerter. Loki = parsing à la lecture, plus coûteux. Pour compter les 500 → Prometheus. Pour voir le détail de chaque requête en erreur → Loki. Complémentaires.

![alt text](screenshots/prometheus-logs.png)
![alt text](screenshots/loki-logs.png)

#### Corrélation logs ↔ traces

`traceId` relevé après un `POST /api/tasks` : `cb67f832b3533ede816e99f2f420738c`

Retrouvable dans Loki car l'auto-instrumentation OTel injecte le `trace_id` dans le contexte et Pino le logue :

```logql
{job=~".+"} |= "cb67f832b3533ede816e99f2f420738c"
```

Pour automatiser : configurer les **Derived Fields** dans la datasource Loki (regex sur `trace_id` → lien cliquable vers Tempo).

![alt text](screenshots/loki-trace-id.png)

#### Démarche d'investigation face à un pic d'erreurs

1. Prometheus : `rate(http_requests_total{status=~"5.."}[5m])` ventilé par `job` → service concerné + fenêtre.
2. Loki : `{job="task-service"} | json | level="error"` → message exact + route.
3. Tempo : ouvrir un `trace_id` vu dans les logs → waterfall pour voir où ça a coincé.

---

# TP — Stress test avec k6

## Étape 1 — Lancer un premier test léger

**Question 1** — p95 = **32.29ms**, sous le seuil de 200ms.

![alt text](screenshots/1-first-stress-test.png)

**Question 2** — `http_req_failed` à 100%, erreurs 401 : le token n'est pas transmis à la requête.

![alt text](screenshots/1-first-stress-test-error.png)


## Étape 2 — Monter la charge progressivement

**Question 3** — À 50 VUs, `tasks response < 500ms` passe : p95 81.1ms, 0% d'échecs.

![alt text](screenshots/2-k6-result-run.png)

À 100 VUs : OK. À 150 VUs : 1352/1605 échecs (14%), p95 globale 2.79s — système dégradé. À 200 VUs : 0% de succès, p95 2.45s. Seuil de rupture **~150 VUs**.

**Test 150 VUs**
![alt text](screenshots/2-k6-result-run-150-vus.png)

**Test 200 VUs**
![alt text](screenshots/2-k6-result-run-200-vus.png)

**Question 4** — Par itération, l'API Gateway reçoit 4 requêtes :
- 1 → user-service (POST login)
- 2 → task-service (GET tasks + POST create task)
- 1 → notification-service (GET notifications)

L'API Gateway encaisse 4× le trafic du user-service ou du notification-service, et 2× celui du task-service.

![alt text](screenshots/2-first-stress-test.png)

**Question 5** — Le `task-service` reçoit 2 requêtes par itération mais chacune coûte cher : GET = `SELECT` complet, POST = `INSERT` + `COUNT GROUP BY` pour la gauge + publication Redis.


## Étape 3 — Tester les limites de `docker scale`

**Question 6** — `docker compose up --scale task-service=3` échoue : port déjà alloué. Cause : mapping statique `"3002:3002"` dans `docker-compose.yml` — les 3 replicas tentent de binder le même port hôte. Fix : retirer les ports du task-service (l'api-gateway accède au service via le réseau Docker interne).

![alt text](screenshots/scale-port-error.png)

**Question 7** — Après le fix, les 3 replicas démarrent et reçoivent du trafic. `tasks response < 500ms` passe à 36% (vs 15%), p95 tombe à 1.41s (vs 2.79s).

Mais nouvelles erreurs : 5 `create task 201` échoués + 35 `notifs response < 500ms` dépassés. Cause : chaque replica maintient son pool de connexions PostgreSQL → à 150 VUs on atteint `max_connections=100` → Postgres refuse → 500. Limite du scaling horizontal naïf — la base reste un goulot partagé. En prod : PgBouncer.

Sur Prometheus, une seule target `task-service` malgré les 3 replicas : `prometheus.yml` pointe sur l'adresse statique `task-service:3002`, Docker résout ce DNS vers un replica au hasard.

![alt text](screenshots/3-k6-scale-error.png)

**Question 8** — `docker scale` ne suffit pas en prod :
- Pas de service discovery (Prometheus ne voit pas les nouvelles instances).
- Pas de health check au niveau du LB (un replica down continue de recevoir du trafic).
- Pas de rolling update / rollback.

Kubernetes résout ça : Deployments avec health checks, service discovery natif, intégration Prometheus Operator (`ServiceMonitor`).

## Étape 4 — Limites de l'instrumentation

**Question 9** — Le panel affiche "No data" car les erreurs k6 ne sont pas des 5xx. `tasks response < 500ms` échoue quand le serveur répond en >500ms mais retourne quand même 200 → Prometheus ne voit pas de 5xx. Le panel ne détecte pas la dégradation de perf, juste les erreurs applicatives.

**Question 10** — Le panel mesure la latence **à l'intérieur** du service, à partir du moment où Node accepte la connexion TCP. Sous charge, les requêtes font la queue au niveau OS avant Express — ce temps n'est pas mesuré. k6 mesure la latence end-to-end depuis le client.

D'où k6 = p95 2.45s mais Grafana flat — Grafana ne voit que les requêtes qui ont passé la file. Pour corriger : `k6 run --out experimental-prometheus-rw`, ou un Blackbox Exporter qui sonde depuis l'extérieur.

---

# Partie 3 — Kubernetes

## Étape 3 — Déploiement du `user-service`

### Diagnostic du `ImagePullBackOff`

**Question 1** — Après `kubectl apply -f k8s/base/user-service/`, les pods sont en `ImagePullBackOff`. On regarde les Events :

```bash
kubectl describe pod -l app=user-service -n staging
```

```
Failed to pull image "mageas/taskflow-user-service:v0.0.1":
  rpc error: code = NotFound desc = failed to pull and unpack image:
  failed to resolve reference: not found
Warning  Failed     ErrImagePull
Warning  Failed     ImagePullBackOff
```

Le tag `v0.0.1` n'existe pas sur le registry. Je n'avais pas push l'image en arm.

---

**Question 2** — En Compose, `build: ./user-service` construit l'image **localement** sur le daemon Docker, qui sert directement le conteneur. Pas de pull.

Sur kind, les nœuds tournent dans des conteneurs Docker isolés avec leur propre containerd. Ils ne voient pas le daemon Docker local — l'image **doit venir d'un registry distant** ou être chargée explicitement. Concrètement, le tag `v0.0.1` n'avait pas été publié : `release.yml` ne se déclenche que sur `git push tag v*.*.*`.

### Correction

Push de l'image sur Docker Hub puis update du deployment :

```bash
git tag v0.0.3
git push origin v0.0.3
```

```yaml
image: mageas/taskflow-user-service:v0.0.3-arm64
```

`imagePullPolicy: IfNotPresent` (déjà présent) pour éviter un re-pull.

Création des secrets :
```bash
kubectl create secret generic postgres-secret -n staging \
  --from-literal=POSTGRES_USER=admin \
  --from-literal=POSTGRES_PASSWORD=admin \
  --from-literal=POSTGRES_DB=taskflow \
  --from-literal=DATABASE_URL='postgresql://admin:admin@postgres:5432/taskflow' \
  --from-literal=JWT_SECRET='change-me-in-prod'
```

Pods en `1/1 Running` :

```bash
kubectl get pods -n staging -o wide
NAME                            READY   STATUS    RESTARTS   AGE   NODE
user-service-6fd54dcb6b-4dh8p    1/1     Running   0          12s   taskflow-worker
user-service-6fd54dcb6b-5bzmv    1/1     Running   0          12s   taskflow-worker2
```

![alt text](screenshots/k8s-user-service-running.png)

---

## Étape 4 — Déployer PostgreSQL (StatefulSet)

3 fichiers `k8s/base/postgres/` complétés :
- `secret.yaml` : `POSTGRES_USER/PASSWORD/DB`, `DATABASE_URL`, `JWT_SECRET`.
- `service.yaml` : headless (`clusterIP: None`) sur 5432.
- `statefulset.yaml` : 1 replica, `volumeClaimTemplates` 1Gi RWO, probes `pg_isready`, image `postgres:16-alpine`.

```bash
$ kubectl get pods -n staging -o wide
NAME                            READY   STATUS    NODE
postgres-0                      1/1     Running   taskflow-worker2
user-service-6fd54dcb6b-4dh8p   1/1     Running   taskflow-worker2
user-service-6fd54dcb6b-5bzmv   1/1     Running   taskflow-worker

$ kubectl get pvc -n staging
NAME                          STATUS   VOLUME    CAPACITY   ACCESS MODES
postgres-data-postgres-0      Bound    pvc-...   1Gi        RWO
```

3 pods Running. Le StatefulSet a un nom ordinal stable (`postgres-0`) au lieu d'un hash. Le PVC `postgres-data-postgres-0` est créé auto à partir du `volumeClaimTemplates`, Bound à un PV provisionné par la `StorageClass standard` de kind.

### Questions Deployment vs StatefulSet

**Question 1** — Identité stable + `volumeClaimTemplates`. Chaque Pod du StatefulSet a un nom ordinal (`postgres-0`, `postgres-1`...) et un PVC dédié (`postgres-data-postgres-0`). À la recréation, le contrôleur réassocie le Pod au même PVC (le PVC n'est pas détruit avec le Pod). Un Deployment génère des hashs aléatoires → aucune corrélation possible.

**Question 2** — Un Deployment serait inadapté pour Postgres :

- **Pas d'identité stable** : nouveau hash à la recréation → tentative de monter le PVC RWO encore attaché à l'ancien pod → `Multi-Attach error`.
- **Stratégie de mise à jour incompatible** : rolling update démarre le nouveau pod **avant** d'arrêter l'ancien → 2 Postgres sur le même répertoire de données → interdit.
- **Pas d'ordre garanti** : pour de la réplication primary/replica, il faut `pod-0` → `pod-1` → `pod-2` séquentiel. StatefulSet le garantit, Deployment non.
- **Pas de DNS stable** : le Service headless du StatefulSet expose `postgres-0.postgres.staging.svc` — utile pour la réplication.

**Question 3** — **Redis** est le meilleur candidat à un StatefulSet en prod. Ici Redis est un bus pub/sub entre `task-service` et `notification-service`. En staging on perd les données au redémarrage (d'où le Deployment), mais en prod :

- Persistance Redis (RDB/AOF) → volume stable → `volumeClaimTemplates`.
- Redis cluster (Sentinel / Redis Cluster) → identité réseau stable pour que les nœuds se référencent → DNS stable du Service headless.
- Ordre de démarrage : un master élu doit rester master après reschedule.

Les autres restent stateless :
- `notification-service` : worker pub/sub, pas d'état persistant local.
- `api-gateway` : proxy HTTP stateless.
- `frontend` : nginx + bundle React, immuable.

---

## Étape 5 — Déployer le `task-service` et le `notification-service`

6 fichiers créés sur le pattern du `user-service` :

- `k8s/base/task-service/` : ConfigMap (PORT 3002, REDIS_URL, OTEL), Deployment (image `taskflow-task-service`, probes `/health`, secret `postgres-secret`), Service ClusterIP 3002.
- `k8s/base/notification-service/` : ConfigMap (PORT 3003, REDIS_URL, OTEL), Deployment (image `taskflow-notification-service`, probes `/health`, **pas de DATABASE_URL** — notifications stockées en mémoire), Service ClusterIP 3003.

Tous les pods en `1/1 Running` après apply.

### Choix du nombre de replicas

**Question 1 — Comment le `notification-service` consomme les événements Redis ?**

Dans `notification-service/src/subscriber.js` : API Pub/Sub native Redis. `subscriber.subscribe('task.created', cb)` et `subscriber.subscribe('task.status_changed', cb)`. Chaque instance ouvre sa propre connexion. Notifications stockées dans un tableau en mémoire (`const notifications = []`).

**Question 2 — Implication sur le nombre de replicas ?**

Pub/Sub Redis = broadcast : **tout subscriber reçoit une copie de chaque message**. Pas de répartition de charge (contrairement à un Stream + consumer group).

Avec 2 replicas, chaque `task.created` est livré aux 2 → notification stockée 2 fois (tableaux en mémoire distincts) + métrique incrémentée 2 fois. À la lecture, le client tape un replica au hasard via le Service → vue partielle.

**Question 3 — Justification**

`notification-service` à `replicas: 1`. Pour scaler, il faudrait soit Redis Streams + consumer group, soit persister en base partagée (Postgres).

Les autres restent à 2 :
- `task-service` : HTTP stateless, état dans Postgres, publish Redis = fire-and-forget côté producer.
- `user-service` : pareil.

---

## Étape 6 — Déployer Redis (Deployment)

2 fichiers `k8s/base/redis/` : Deployment 1 replica, image `redis:7-alpine` sur 6379, Service ClusterIP 6379.

### Choix d'un Deployment plutôt qu'un StatefulSet

Cohérent avec étape 4 Q3 : en staging on tolère la perte de données. Pub/sub = broadcast en mémoire sans persistance par défaut — un message non livré au moment du publish est perdu de toute façon. Pas de volume → pas besoin de StatefulSet.

### Adaptation de la `readinessProbe`

Redis ne parle pas HTTP, il parle RESP. Probe en `exec` qui lance `redis-cli ping` → Redis répond `PONG` quand prêt :

```yaml
readinessProbe:
  exec:
    command: ["redis-cli", "ping"]
  initialDelaySeconds: 5
  periodSeconds: 10
```

Alternative : `tcpSocket` sur 6379 — plus léger mais valide juste l'ouverture du port, pas la commande.

Pod en `1/1 Running` après apply, le `notification-service` s'abonne aux canaux via `redis:6379`.

---

## Étape 7 — Déployer l'`api-gateway` et le frontend

### `api-gateway`

3 fichiers dans `k8s/base/api-gateway/` :
- **ConfigMap** : `PORT=3000`, URLs internes (`USER_SERVICE_URL=http://user-service:3001`, `TASK_SERVICE_URL=http://task-service:3002`, `NOTIFICATION_SERVICE_URL=http://notification-service:3003`), conf OTEL.
- **Deployment** : 2 replicas, image `taskflow-api-gateway`, `JWT_SECRET` depuis `postgres-secret`, probes `/health` sur 3000.
- **Service** : ClusterIP 3000.

### `frontend`

2 fichiers dans `k8s/base/frontend/` :
- **Deployment** : 2 replicas, image `taskflow-frontend` (nginx + bundle React), probes `/` sur 80. Pas de ConfigMap — la conf nginx est embarquée et `/api` → `api-gateway:3000` se résout via le DNS Kube.
- **Service** : ClusterIP 80.

### Justification (replicas et ressources)

**`api-gateway`** : reverse-proxy qui valide le JWT et route vers les services internes. Stateless (le JWT contient toute l'info). Point d'entrée unique → `replicas: 2` pour la résilience. Node parse JSON + valide HMAC-SHA256 + reproxie HTTP → `requests: 100m / 128Mi`, `limits: 200m / 256Mi`.

**`frontend`** : nginx qui sert un bundle React + proxy `/api`. Stateless, fichiers immuables. UI down = API utilisable mais pas l'interface → `replicas: 2`. nginx fait quasi rien à chaque requête → `requests: 25m / 32Mi`, `limits: 100m / 64Mi`.

L'écart de ressources reflète la différence : exécution de logique vs. fichiers statiques.

4 pods (`api-gateway` ×2, `frontend` ×2) en `1/1 Running` après apply.

---

## Étape 8 — Vérifier que tout tourne

```bash
kubectl get all -n staging
```

11 pods en `1/1 Running` :

- `postgres-0` (StatefulSet, 1)
- `redis-*` (Deployment, 1)
- `user-service-*` ×2
- `task-service-*` ×2
- `notification-service-*` ×1
- `api-gateway-*` ×2
- `frontend-*` ×2

Répartis sur `taskflow-worker` et `taskflow-worker2`.

![alt text](screenshots/k8s-all-running.png)

### Note sur les erreurs OTEL dans les logs

```bash
kubectl logs -n staging deployment/task-service
```

```
Error: connect ECONNREFUSED otel-collector:4318
```

Attendu : la stack d'observabilité est dans `docker-compose.infra.yaml` et n'a pas été portée en manifests Kube. Les services tentent de pousser les traces toutes les 10s, échouent, loguent. Pas d'impact sur les requêtes HTTP. Pour la porter : manifests Tempo / Prometheus / Grafana / Collector + `ServiceMonitor` (Prometheus Operator) pour la découverte dynamique.

---

## Partie 2 — Exposer avec un Ingress

### Inscription depuis l'interface

**Question 1 — L'inscription fonctionne ?**

Non. 500 sur `POST /api/users/register`.

**Question 2 — Logs et accès à PostgreSQL**

D'abord l'`api-gateway` :

```bash
kubectl logs -n staging deployment/api-gateway --tail=50
```

Pas de trace du `register`, juste les `/health`. Le proxy ne logue pas les requêtes réussies. On descend au `user-service` :

```bash
kubectl logs -n staging -l app=user-service --tail=200 | grep -iE "error|register"
```

Le 500 est là, mais peu informatif :

```json
{
  "level": 50,
  "req": { "method": "POST", "url": "/users/register", ... },
  "res": { "statusCode": 500 },
  "err": { "type": "Error", "message": "failed with status code 500" },
  "msg": "request failed : failed with status code 500"
}
```

C'est pino-http qui logue génériquement — l'erreur SQL réelle n'apparaît pas. Dans `routes.js` :

```js
} catch (err) {
  if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
  res.status(500).json({ error: 'Internal server error' });  // err jamais loggué
}
```

Le `catch` swallow l'erreur. Pour voir la cause, accès direct à la base. Le Service `postgres:5432` est ClusterIP → port-forward :

```bash
kubectl port-forward -n staging svc/postgres 5432:5432
```

```bash
PGPASSWORD=admin psql -h localhost -U admin -d taskflow -c "\dt"
```

`Did not find any relations.` Aucune table. L'`INSERT INTO users` tape sur une table inexistante → 500.

**Question 3 — Comparaison avec `docker-compose.yaml`**

Dans le compose, le service postgres monte explicitement le script d'init :

```yaml
volumes:
  - postgres_data:/var/lib/postgresql/data
  - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
```

L'image officielle `postgres` exécute tout `*.sql`/`*.sh` placé dans `/docker-entrypoint-initdb.d/` au premier démarrage si le data directory est vide → création des tables `users`, `tasks`, `notifications` + insertion d'Alice et Bob.

Mon StatefulSet ne montait que le PVC, pas le script d'init. Base vide → 500.

### Correction

ConfigMap `postgres-init` qui contient `scripts/init.sql`, monté dans le pod :

`k8s/base/postgres/init-configmap.yaml` :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-init
  namespace: staging
data:
  init.sql: |
    CREATE TABLE IF NOT EXISTS users (...);
    CREATE TABLE IF NOT EXISTS tasks (...);
    CREATE TABLE IF NOT EXISTS notifications (...);
```

Update du `statefulset.yaml` :

```yaml
volumeMounts:
  - name: postgres-data
    mountPath: /var/lib/postgresql/data
    subPath: pgdata
  - name: postgres-init
    mountPath: /docker-entrypoint-initdb.d
volumes:
  - name: postgres-init
    configMap:
      name: postgres-init
```

⚠️ `/docker-entrypoint-initdb.d/` ne tourne que si le data directory est vide. Comme le PVC contient déjà le précédent démarrage, il faut le supprimer :

```bash
kubectl delete -f k8s/base/postgres/
kubectl delete pvc -n staging postgres-data-postgres-0
kubectl apply -f k8s/base/postgres/
```

`\dt` montre les 3 tables, l'inscription marche.

### Service vs Ingress

**Question 1 — Pourquoi `localhost:5432` ne marche pas sans port-forward ?**

Le Service `postgres` est en `ClusterIP` : IP virtuelle routable seulement à l'intérieur du cluster (kube-proxy + iptables sur chaque nœud). Pas exposée sur l'hôte.

Le `extraPortMappings` de kind expose juste 80/443 du `taskflow-control-plane` pour l'Ingress — pas le 5432.

`kubectl port-forward` ouvre un tunnel TCP via l'API Server qui relaie au pod. Debug ponctuel, pas de la prod.

**Question 2 — Qui fait le routage HTTP de l'Ingress ?**

L'objet `Ingress` est juste une déclaration YAML dans etcd — il ne fait rien sans contrôleur. Le routage est assuré par l'**ingress-nginx-controller** (namespace `ingress-nginx`). Le controller watch l'API Kube, traduit chaque `Ingress` en blocs `server { location ... proxy_pass ... }` NGINX, recharge à chaud.

`nodeSelector: ingress-ready: "true"` force le scheduling sur `taskflow-control-plane`, seul nœud où kind expose 80/443 sur l'hôte.

**Question 3 — Qui load-balance entre les replicas de `task-service` ?**

Pas l'Ingress, pas NGINX : le **Service ClusterIP** via **kube-proxy**. Pour `GET /api/tasks` : kind → pod nginx → match `/api` → proxy vers `api-gateway:3000` → CoreDNS → IP virtuelle → kube-proxy redirige (round-robin iptables) vers un des 2 replicas. Idem pour `task-service:3002`.

LB à chaque saut de Service, en L4. NGINX ne voit que l'IP du Service. L'Ingress = routeur HTTP L7 d'entrée (host/path → Service), pas un LB applicatif.

---

## Partie 3 — Scénarios d'observation

### Scénario 1 — Self-healing

```bash
kubectl delete pod -n staging -l app=task-service
```

Dans le Terminal A :

1. Les 2 pods `task-service-*` passent en `Terminating`.
2. 2 nouveaux pods (nouveau hash) apparaissent en `Pending` → `ContainerCreating` → `Running` une fois la readiness verte.
3. État stable rétabli, mais avec un `AGE` récent (31s) vs les autres services intacts (9m+).

![alt text](screenshots/k8s-self-healing.png)

**Pourquoi Kube recrée les pods ?**

Deployment controller + ReplicaSet. Le Deployment déclare `replicas: 2` = état désiré dans etcd. Le contrôleur réconcilie en boucle.

`kubectl delete` retire les pods → ReplicaSet voit l'écart → crée 2 nouveaux. Même mécanisme pour le self-healing crash (OOMKilled, exit 1, nœud down). Échoue uniquement si la spec est invalide (image inexistante, `requests` irréalisables).

### Scénario 2 — Readiness probe

Modif du `deployment.yaml` avec un path inexistant + recréation du cluster :

```yaml
readinessProbe:
  httpGet:
    path: /does-not-exist
    port: 3002
```

```bash
kind delete cluster --name taskflow
kind create cluster --name taskflow --config k8s/kind-config.yaml
kubectl create namespace staging
kubectl apply -f k8s/base/ --recursive
```

⚠️ `kind delete` détruit aussi `ingress-nginx` et le patch `nodeSelector`. À réinstaller :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl patch deployment ingress-nginx-controller -n ingress-nginx \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/nodeSelector/ingress-ready","value":"true"}]'
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
```

**Question 1 — État des pods `task-service` ?**

`STATUS: Running` mais `READY: 0/1`. Le kubelet `GET /does-not-exist` toutes les 10s → 404 → probe failed → pod retiré des `Endpoints`.

```bash
kubectl get endpoints -n staging task-service
NAME           ENDPOINTS   AGE
task-service   <none>      2m
```

Pas d'IP → Service sans backend.

**Question 2 — Quels services répondent ?**

Login (`POST /api/users/login`) et `GET /api/notifications` : OK, leurs Endpoints sont peuplés. `GET /api/tasks` et `POST /api/tasks` : 502 — proxy api-gateway → Service vide. `http-proxy-middleware` logue un `proxy error` et incrémente `upstream_errors_total{service="task-service"}`.

App partiellement fonctionnelle : auth + notifications OK, tâches KO. C'est ce que la readiness garantit — isoler les replicas pas prêts sans casser le reste.

**Question 3 — Après remise du path à `/health`**

```bash
kubectl apply -f k8s/base/task-service/deployment.yaml
```

Rolling update : 2 nouveaux pods avec le bon path → `READY: 1/1` → termine les anciens.

```bash
kubectl get endpoints -n staging task-service
NAME           ENDPOINTS                    AGE
task-service   10.244.1.21:3002,10.244.2.18:3002   3m
```

2 IPs de retour. Création de tâche en 201, span `POST /tasks` visible dans Tempo.

### Readiness probe vs Liveness probe

| | Readiness | Liveness |
|---|---|---|
| **Question** | Prêt à recevoir du trafic ? | Encore vivant ou bloqué ? |
| **Si échoue** | Retiré des `Endpoints`. Ni tué ni redémarré. Réinjecté dès que la probe repasse. | Conteneur tué (SIGTERM puis SIGKILL). Pod redémarré, `RESTARTS` s'incrémente. |
| **Cas d'usage** | Démarrage lent, dépendance temporairement KO, surcharge transitoire. | Process bloqué (deadlock, fuite mémoire) qu'un restart corrige. |

**Que se serait-il passé avec une liveness cassée ?**

Boucle infernale. À chaque check, kubelet → 404 → conteneur tué → ReplicaSet recrée → check → 404 → tué. `RESTARTS` explose, pod en `CrashLoopBackOff` avec backoff exponentiel (10s, 20s, 40s..., max 5 min). Pendant les fenêtres `Running`, la readiness `/health` repasse vert quelques secondes → pod réintégré aux endpoints → reçoit du trafic → tué au check suivant. Connexions abruptement coupées côté client.

Readiness cassée = dégradation silencieuse (pods hors-jeu, on investigue). Liveness cassée = `CrashLoopBackOff` permanent. D'où des seuils plus tolérants sur la liveness (`failureThreshold` plus haut, `initialDelaySeconds` plus long).


### Scénario 3 — Rolling update

**`CHANGE-CAUSE` ?**

```bash
kubectl rollout history -n staging deployment/frontend
```

Affiche `<none>` partout. Inutile en l'état — on sait qu'il y a eu N rollouts mais pas pourquoi. Impossible de retrouver le rollout `v0.0.4-arm64` (thème rose/violet) sans aller voir le tag d'image de chaque ReplicaSet à la main.

![alt text](screenshots/k8s-rollout-history.png)

Utile uniquement avec annotation :

```bash
kubectl annotate deployment/frontend -n staging \
  kubernetes.io/change-cause="passage à v0.0.4 - thème rose/violet"
```
![alt text](screenshots/k8s-rollout-history-2.png)
![alt text](screenshots/k8s-rollout-history-theme.png)


`kubectl rollout undo` ramène à la révision précédente (thème noir/jaune).

![alt text](screenshots/k8s-rollout-history-rollback.png)

### Questions rolling update

**Question 1 — Le nombre de pods disponibles a-t-il diminué ?**

Non. Default `RollingUpdate` avec `maxSurge: 25%` et `maxUnavailable: 25%`. À `replicas: 2`, jusqu'à 3 pods en vol et au moins 1 dispo.

Un 3ᵉ pod `frontend-*` apparaît (nouveau hash) → `Pending` → `Running 1/1`. C'est seulement après readiness verte qu'un ancien passe en `Terminating`. Le Service garde toujours ≥2 endpoints prêts.

**Question 2 — Si le nouveau pod n'était jamais passé en 1/1 ?**

Rollout bloqué, prod intacte. Kube refuse de retirer l'ancien tant que le nouveau n'est pas prêt (`maxUnavailable`). Nouveau pod en `0/1 Running` en boucle, anciens replicas servent tout le trafic, `kubectl rollout status` attend.

Au bout de `progressDeadlineSeconds` (600s par défaut) : `Progressing: False, reason: ProgressDeadlineExceeded`. Signal pour la CI/CD. Soit on diagnostique (logs, image cassée), soit `rollout undo`.

**Question 3 — Pourquoi annoter en équipe ?**

Sans annotation, `rollout history` = liste de numéros opaques. En équipe :
- Post-mortem : rollback vers quelle révision ?
- Traçabilité : un déploiement n'est pas qu'un changement d'image (ticket, hotfix, contexte).
- Onboarding : zéro info utile.
- `rollout undo --to-revision=N` exige de savoir laquelle.

À automatiser depuis la CI : `kubernetes.io/change-cause="<sha> <pr-title> by <author>"`.

**Question 4 — `kubectl rollout undo` suffit en prod ?**

Non, dépannage manuel. Limites :
- `revisionHistoryLimit` 10 par défaut.
- Couvre que le manifest du Deployment — une migration DB destructive ne se rollback pas.
- Présume que la version N-1 marche encore (dépendance externe disparue ?).
- Pas d'audit trail.
- Granularité = tout le Deployment, pas une feature.

En prod : feature flags pour désactiver sans redéploiement, canary / blue-green (Argo Rollouts, Flagger) avec rollback auto sur métriques, GitOps (ArgoCD, Flux) où le rollback = `git revert` + sync, migrations DB compatibles ascendant/descendant.

---

## Réflexion théorique — duplication dans les manifests

**Identifier au moins 3 valeurs répétées et l'impact en prod**

Dans les ~20 manifests de `k8s/base/` :

1. **`namespace: staging`** dans tous les fichiers (~20 occurrences). Pour passer en prod, faut tout modifier un par un.
2. **Le tag `v0.0.4-arm64`** dans chaque `deployment.yaml` (5 services). Bump de version = 5 fichiers à modifier sans oubli.
3. **URLs internes** (`http://user-service:3001`, `http://task-service:3002`...) dans plusieurs ConfigMaps. Changement de port = multi-fichier.
4. **Labels `app: <service>`** dupliqués 3× par service (selector du Deployment + labels du template + selector du Service). Faute de frappe = Service qui ne route plus.

### Impact en prod

Pour créer un environnement `production` à côté de staging : dupliquer en `k8s/production/`, find/replace `staging` → `production` dans chaque fichier (risque d'oubli silencieux), changer le tag dans chaque Deployment, adapter les ressources, changer le `host` de l'Ingress + TLS, gérer les Secrets séparément.

À chaque modif structurelle (port, image, namespace) → risque de désynchro. Changer le port du `task-service` 3002 → 8080 = chercher `3002` partout (configmap task, service, configmap api-gateway, prometheus.yml...) à la main.

### Pourquoi ça motive Helm / Kustomize

- **Kustomize** : on garde `k8s/base/` et on applique des overlays par environnement. Du YAML pur, sans templating.
- **Helm** : chart paramétré par un `values.yaml` par environnement. Namespace, tag, replicas → `{{ .Values.* }}`. Packaging réutilisable, versioning, hooks de migration.
- **GitOps + ArgoCD** : combine Kustomize/Helm avec un sync Git → cluster.

Après avoir écrit ces 20 fichiers à la main, on comprend pourquoi personne ne maintient des manifests raw en prod multi-env.

---

# Partie 4A — Helm

## Prérequis — Réflexion théorique

**Question 1 — Comment Helm résout la répétition ? Quel fichier est central ?**

Helm transforme les manifests en templates Go dans `templates/` et extrait les valeurs variables (namespace, tag, replicas, ports, URLs) dans un seul `values.yaml`. Au lieu de dupliquer `namespace: staging` 20 fois, on écrit `namespace: {{ .Values.namespace }}` une fois.

Pour un nouvel environnement, on crée un `values.production.yaml` qui override uniquement ce qui change.

Fichier central : **`values.yaml`** — source unique de vérité. `Chart.yaml` = métadonnées (nom, version, deps). `templates/_helpers.tpl` mutualise les blocs YAML communs (labels, probes) via `define`/`include`.

**Question 2 — Quand devient-il indispensable ?**

Autour de **3-4 services × 2 environnements**. En dessous, manifests bruts ou Kustomize léger suffisent.

Le vrai déclencheur = produit **services × environnements × fréquence de changement**. 5 services × 2 envs = 40 manifests à synchroniser. Ajouter un preprod ou un env de review par PR fait exploser le produit. Chaque bump devient une opération multi-fichiers à risque.

Helm est aussi indispensable dès qu'on consomme des charts tiers (Bitnami Redis, Prometheus Operator, ingress-nginx) — c'est le format standard de l'écosystème.

---

## Étape 1 — Créer le chart de Taskflow

### Manipulations

Templates créés en suivant le pattern de `user-service.yaml` :

- `templates/task-service.yaml` — port 3002, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, OTEL.
- `templates/notification-service.yaml` — port 3003, `REDIS_URL`, OTEL (pas de DB, notifs en mémoire).
- `templates/api-gateway.yaml` — port 3000, URLs internes des 3 services, `JWT_SECRET`, OTEL.
- `templates/frontend.yaml` — port 80, nginx + bundle React, probes sur `/`.

`values.yaml` complété avec `image.tag` global, `jwt.secret`, et les blocs `taskService` / `notificationService` / `apiGateway` / `frontend` (replicaCount + resources).

### Dépendance Redis Bitnami

Ajout dans `Chart.yaml` :

```yaml
dependencies:
  - name: redis
    version: "~18.19.4"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
```

```bash
$ helm dependency update ./helm/taskflow
Saving 1 charts
Downloading redis from repo https://charts.bitnami.com/bitnami
```

Vérification du nom du Service :

```bash
$ helm template taskflow ./helm/taskflow \
    --values ./helm/taskflow/values.yaml \
    --show-only charts/redis/templates/master/service.yaml
...
metadata:
  name: redis-master
```

`REDIS_URL` mis à jour dans les templates `task-service` et `notification-service` :

```yaml
- name: REDIS_URL
  value: redis://redis-master:6379
```

### Réflexion théorique

**Question 1 — Pourquoi Redis se prête à un chart officiel ?**

Le critère : Redis est un composant d'**infrastructure stable et standard**, pas du métier. Sa config (auth, persistance, replication, sentinel) suit les mêmes patterns partout — Bitnami l'a déjà packagé proprement. On consomme, on n'invente rien.

À l'inverse, nos services métier (`task-service`, `api-gateway`...) sont spécifiques à TaskFlow : pas de chart officiel possible, on doit écrire le nôtre.

**Question 2 — Pourquoi garder un template maison pour Postgres ?**

Deux éléments rendraient une migration vers `bitnami/postgresql` coûteuse :

1. **Le ConfigMap `postgres-initdb`** monté dans `/docker-entrypoint-initdb.d/` qui crée les tables (`users`, `tasks`, `notifications`) et insère Alice/Bob. Le chart Bitnami expose `primary.initdb.scripts` pour ça, mais il faut transposer le contenu et adapter le mécanisme de montage — pas un drop-in.

2. **Le couplage avec `postgres-secret`** consommé par les services métier (`user-service`, `task-service`, `api-gateway`) pour `DATABASE_URL` et `JWT_SECRET`. Bitnami crée son propre secret (`taskflow-postgresql`) avec un schéma de clés différent (`postgres-password`, `password`...). Migrer impose de réécrire toutes les références dans les autres templates ou de mapper via un secret intermédiaire.

---

## Étape 2 — Values par environnement

### Sortir les secrets de `values.production.yaml`

`postgres.password` et `jwt.secret` retirés de `values.production.yaml`. Création d'un fichier dédié `secrets.production.yaml` (gitignored) + un `.example` commité comme template :
```yaml
# secrets.production.yaml.example
postgres:
  password: REMPLACER_PAR_MOT_DE_PASSE_FORT
jwt:
  secret: REMPLACER_PAR_TOKEN_LONG_ALEATOIRE
```

`.gitignore` mis à jour :
```
helm/**/secrets.*.yaml
!helm/**/secrets.*.yaml.example
```

Vérification :
```bash
$ git check-ignore helm/taskflow/secrets.production.yaml
helm/taskflow/secrets.production.yaml   # ignoré ✓
```

Ajout du namespace production
```bash
kubectl create namespace production
```

Déploiement avec deux fichiers de values empilés (le second override le premier) :
```bash
helm upgrade --install taskflow ./helm/taskflow -n production \
  -f ./helm/taskflow/values.production.yaml \
  -f ./helm/taskflow/secrets.production.yaml
```

### Réflexion théorique

**Question 1 — Comment déployer avec des valeurs sensibles sans les commiter ?**

3 approches qui marchent :
- Un fichier de values local gitignored (`secrets.production.yaml`) passé en `-f` au moment du deploy. Solution choisie ici.
- `--set postgres.password=$PASSWORD` directement en CLI, avec la valeur lue depuis une variable d'env du shell ou un secret manager.
- Un Kubernetes Secret créé hors Helm (kubectl, ExternalSecrets, Vault Agent), référencé par les templates via `valueFrom: secretKeyRef`.

**Question 2 — Pourquoi c'est plus sûr qu'un repo privé ?**

Un repo privé n'est pas un coffre-fort. Il a beaucoup plus de surface d'exposition qu'on ne le croit :
- L'historique Git garde le secret pour toujours, même après rotation. Un `git revert` ne l'efface pas — il faut `git filter-repo` sur tout l'historique.
- Tout collaborateur (présent ou ancien) qui a cloné une fois a le secret en local pour de bon.
- Les forks, miroirs, sauvegardes, CI cache, IDE indexers le copient ailleurs.
- Une fuite accidentelle (repo passé en public, token GitHub volé, leak via un agent IA, dependabot...) expose tout d'un coup.

Sortir le secret du repo limite le périmètre à un seul endroit (vault, gestionnaire de secrets, fichier local sur les machines des opérateurs). On peut le faire tourner sans toucher à l'historique Git.

**Question 3 — Que résout `helm-secrets` que cette solution ne résout pas ?**

Ma solution règle "ne pas commiter les secrets". Mais alors, **où vit le fichier `secrets.production.yaml` ?** Sur la machine de l'opérateur, dans un Drive partagé, dans un Vault... bref, partout sauf dans Git — donc plus de versioning, plus de revue par PR, plus de traçabilité des modifications.

`helm-secrets` permet de garder le fichier **dans Git**, mais chiffré (GPG / AWS KMS / age). Le déchiffrement se fait à la volée au `helm upgrade` avec une clé que seuls les opérateurs autorisés possèdent. On récupère versioning + audit + revue par PR sans exposer les valeurs en clair.

Devient nécessaire dès qu'une équipe veut versionner ses secrets (GitOps avec ArgoCD/Flux, multi-environnements, rotation tracée), ou quand le nombre d'opérateurs rend la synchro manuelle d'un fichier hors Git impraticable.

**Question 4 — Comment passer `$POSTGRES_PASSWORD` dans GitHub Actions sans leak ?**

Le mot de passe vit dans un **GitHub Secret** (settings du repo). Il est injecté dans une variable d'env du job, puis passé à Helm via `--set`. GitHub masque automatiquement les secrets référencés via `${{ secrets.* }}` dans les logs (remplacés par `***`).

```yaml
- name: Deploy
  env:
    POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
  run: |
    helm upgrade --install taskflow ./helm/taskflow -n production \
      -f ./helm/taskflow/values.production.yaml \
      --set postgres.password="$POSTGRES_PASSWORD" \
      --set jwt.secret="$JWT_SECRET"
```

Pièges à éviter : ne pas faire `echo $POSTGRES_PASSWORD`, ne pas activer `set -x` dans le script, ne pas écrire le mot de passe dans un fichier qui serait uploadé en artifact. Sur des secrets multi-lignes ou avec des caractères exotiques, GitHub peut rater le masquage — préférer un `secrets.production.yaml` reconstruit à la volée (`echo "$SECRETS_YAML" > secrets.yaml`) avec `SECRETS_YAML` stocké en GitHub Secret.

---

## Étape 3 — Installation du chart

![alt text](screenshots/helm-task-service.png)

### Réflexion théorique

**Question 1 — Variable référencée sans valeur correspondante ?**

Helm n'échoue pas. La variable est rendue comme **chaîne vide**, et le YAML produit reste syntaxiquement valide.

Test : suppression de `taskService.replicaCount` dans `values.yaml`, puis `helm template` :

```yaml
spec:
  replicas:                # vide, pas d'erreur côté Helm
  selector:
    matchLabels:
      app: task-service
```

Le silence côté Helm est dangereux — l'erreur tombe seulement au `kubectl apply` quand l'API Server rejette le manifest, ou pire, le Deployment passe avec un comportement par défaut (replicas=1). Pour bloquer en amont, on peut utiliser `{{ required "taskService.replicaCount manquant" .Values.taskService.replicaCount }}` dans le template.

**Question 2 — Différences avec `k8s/base/task-service/deployment.yaml` ?**

Trois différences structurelles :

1. **Pas de ConfigMap ni de Secret intermédiaire.** En k8s base, les variables passent par `envFrom: configMapRef` (pour `task-service-cm`) et `valueFrom: secretKeyRef` (pour `postgres-secret`). En Helm, toutes les valeurs sont **inlinées** directement dans `env:` à partir de `values.yaml`. Helm devient la source unique — pas besoin d'un objet Kube intermédiaire pour stocker les valeurs.

2. **Namespace dynamique.** Le manifest k8s a `namespace: staging` codé en dur ; le template Helm a `namespace: {{ .Release.Namespace }}`, donc la même release peut tourner en `staging`, `production` ou `preprod` sans toucher au YAML.

3. **Un seul fichier au lieu de trois.** En k8s base : `deployment.yaml`, `service.yaml`, `configmap.yaml` séparés. En Helm : tout regroupé dans `task-service.yaml` avec des `---`. C'est un choix d'organisation — Helm s'en fiche, ce qui compte c'est qu'un service applicatif = une unité logique.

Pourquoi ces différences existent : k8s raw cherche à **découpler les données de la spec** (changer la config sans toucher au Deployment, partager un Secret entre services). Helm n'a pas ce besoin parce qu'il **régénère tout à chaque `helm upgrade`** depuis la même source — l'indirection ConfigMap/Secret devient redondante pour des valeurs non sensibles. Les vrais secrets restent à part (cf. étape 2).

![alt text](screenshots/help-list-staging.png)

---

## Étape 4 — Tester une mise à jour

### Plugin de prévisualisation

[`helm-diff`](https://github.com/databus23/helm-diff) ajoute une commande `helm diff upgrade` qui rend le YAML local et le compare au manifest courant côté cluster — un `kubectl diff` mais piloté par Helm.

Installation :

```bash
helm plugin install https://github.com/databus23/helm-diff --verify=false
```

### Question 1 — Modification, commande, sortie

Modif dans `helm/taskflow/values.yaml` :

```diff
 notificationService:
-  replicaCount: 1
+  replicaCount: 2
```

Commande de prévisualisation :

```bash
helm diff upgrade taskflow ./helm/taskflow -n staging \
  -f ./helm/taskflow/values.yaml
```

Sortie :

```diff
staging, notification-service, Deployment (apps) has changed:
  spec:
-   replicas: 1
+   replicas: 2
    selector:
      matchLabels:
        app: notification-service
    ...
```

![alt text](screenshots/helm-diff.png)

Une seule ressource impactée, un seul champ qui change. Aucune autre dérive — exactement ce qu'on attendait.

### Question 2 — `replicaCount` vs `image.tag` : où l'outil est-il critique ?

Le diff est **bien plus critique sur un changement d'`image.tag`**.

Un changement de `replicaCount` est peu risqué : Kube ajoute/retire des pods sur un Deployment existant, le code applicatif ne change pas, l'opération est trivialement réversible (revenir à la valeur d'avant).

Un changement d'`image.tag` déclenche un **rolling update sur tous les pods du Deployment**. Avec `maxSurge: 25%` / `maxUnavailable: 25%`, Kube remplace progressivement les anciens pods par des nouveaux qui tirent la nouvelle image. Tout ce qui a été modifié dans cette image est appliqué d'un coup en prod : breaking change de schéma de config, env var renommée, port modifié, dépendance manquante, régression silencieuse... Sans diff préalable, on découvre le problème quand les nouveaux pods échouent leur readiness — déjà 25% du trafic peut être impacté avant que le rolling update ne se bloque.

Le diff permet de vérifier deux choses avant l'apply :
1. **Le tag effectivement changé** est bien celui attendu (`v1.0.4-arm64`, pas un `:latest` ou un tag voisin).
2. **Rien d'autre n'a bougé** en parallèle (env vars, ressources, probes) — typique des bugs où on bump l'image et on remarque trop tard que `values.yaml` avait aussi muté.

Pour un `replicaCount`, l'oubli est rattrapable. Pour une mauvaise image, le rolling update est déjà parti.

### Réflexion théorique — Historique des déploiements

**Question 1 — Ce qu'on voit avec `watch kubectl get pods -n staging -o wide`**

Avant l'upgrade : un seul pod `notification-service-*` en `1/1 Running`.

Après le `helm upgrade` qui passe le replicaCount à 2 : un **deuxième** pod `notification-service-*` apparaît, avec un nouveau hash, en `Pending` → `ContainerCreating` → `1/1 Running`. L'ancien pod n'est pas touché — pas de `Terminating`, pas de redémarrage.

C'est le comportement normal d'un scale-up : Kube ajoute des replicas, il ne remplace pas les existants. Aucun rolling update du pod template puisque l'image et les env vars n'ont pas bougé. Les autres services (`api-gateway`, `task-service`, etc.) restent inchangés — Helm n'a généré un diff que sur la ressource `notification-service`.

**Question 2 — Info dans `helm history` absente de `kubectl rollout history`**

```bash
$ helm history taskflow -n staging
REVISION  UPDATED                  STATUS      CHART           APP VERSION  DESCRIPTION
1         Tue May  5 14:05:57 2026 superseded  taskflow-0.1.0  1.0.0        Install complete
2         Tue May  5 14:16:50 2026 deployed    taskflow-0.1.0  1.0.0        Rollback to 1

$ kubectl rollout history deployment/notification-service -n staging
REVISION  CHANGE-CAUSE
1         <none>
```

Plusieurs infos sont dans Helm et pas dans Kube :

- **La version du chart** (`taskflow-0.1.0`). Pas le tag d'image (qui est l'app version), mais la version du package Helm — donc des templates eux-mêmes. En prod, savoir qu'on a déployé `taskflow-0.3.7` vs `taskflow-0.4.0` permet de retrouver les changements de structure (probes ajoutées, env var renommée, ressource changée) sans remonter dans Git à la main.
- **Le statut** (`deployed` / `superseded` / `failed`). `kubectl rollout history` ne liste **pas** les rollouts qui ont échoué — il ne garde que ce qui est passé. Helm garde même les revisions en `failed`, ce qui est critique pour le post-mortem ("la 4 a échoué, on a rollback à la 3").
- **La description** auto-générée (`Install complete`, `Rollback to 1`...) qui contextualise sans annotation manuelle.

En prod, ces infos sont critiques parce qu'un `kubectl rollout history` peut donner une fausse impression de stabilité (que des succès affichés) alors que `helm history` montre les vraies tentatives, dont les ratées.

**Question 3 — `helm rollback taskflow 1` vs `kubectl rollout undo deployment/task-service`**

Différence fondamentale : **la granularité du rollback**.

`kubectl rollout undo deployment/task-service` ramène uniquement le **pod template** du Deployment `task-service` à sa version précédente. Il ne touche ni le Service, ni le ConfigMap, ni le Secret, ni l'Ingress, ni les autres Deployments.

`helm rollback taskflow 1` ramène **toutes les ressources de la release** à leur état de la révision 1, en une transaction. Si la release v2 avait modifié le Deployment **et** son ConfigMap **et** ajouté un Secret, le rollback Helm restaure les trois ; le `kubectl rollout undo`, lui, restaure le Deployment mais laisse le ConfigMap v2 et le Secret v2 en place — état incohérent où le pod tourne avec l'ancienne image mais lit la nouvelle config.

Helm tracke l'ensemble du bundle déployé comme une unité. Kube tracke l'historique d'un seul Deployment, isolément. Dès que la release modifie plusieurs objets ensemble (ce qui est le cas standard avec une chart Helm), seul `helm rollback` garantit la cohérence de l'état restauré.

---

# Partie 4B — Helm

![alt text](screenshots/helm-deps.png)

## Étape 1 — Via chart officiel

### Réflexion théorique — Dépendances et composition

**Question 1 — Si l'installation de Grafana échoue, Helm annule-t-il aussi Prometheus ?**

`kube-prometheus-stack` est **une seule release** : Prometheus, Grafana, Alertmanager et kube-state-metrics sont des sous-charts, mais Helm rend tout en un seul jeu de manifests appliqué comme un bundle.

Par défaut, **non**. Helm n'est pas transactionnel : si une ressource échoue, la release passe en `failed` et tout ce qui a déjà été créé reste en place — Prometheus survit à l'échec de Grafana. Aucun rollback automatique.

On obtient le "tout ou rien" avec `--rollback-on-failure`. À l'échec : un `install` est désinstallé entièrement, un `upgrade` est ramené à la révision précédente. Donc oui, avec ce flag, l'échec de Grafana annule aussi Prometheus.

Trois limites à connaître :

- **Encore faut-il détecter l'échec.** Par défaut `--wait` vaut `hookOnly` : Helm marque la release réussie dès que l'API Server accepte les manifests, un pod Grafana qui crashe ensuite passe inaperçu. `--rollback-on-failure` force `--wait` à `watcher` → Helm attend que les ressources soient prêtes (jusqu'à `--timeout`), et un Grafana non-`Ready` déclenche le rollback.
- **Best-effort, pas une transaction ACID** — et les **CRDs** font exception : celles posées par le chart ne sont pas supprimées au rollback/uninstall, elles resteront.
- Prévoir un `--timeout` large : 5m (défaut) est court pour cette stack qui tire beaucoup d'images, sinon on rollback une install qui démarrait juste lentement.

**Question 2 — Adapter les commandes pour garantir ce comportement**

Ajouter `--rollback-on-failure` et un `--timeout` généreux (plus `--cleanup-on-fail` en upgrade, qui supprime les ressources nouvellement créées par un upgrade raté) :

```bash
# install
helm install monitoring prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --rollback-on-failure --timeout 10m \
  --set grafana.adminPassword=admin

# upgrade --install
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --rollback-on-failure --cleanup-on-fail --timeout 10m \
  --set grafana.adminPassword=admin
```

`--rollback-on-failure` activant déjà `--wait=watcher`, la réussite n'est déclarée qu'une fois tous les pods prêts — sinon rollback complet de la release.

### Installer — nombre de fichiers

**Question — Combien de fichiers pour installer la stack complète ? Comparaison avec la partie 1**

**Zéro.** L'installation tient en une commande, sans écrire le moindre fichier (`--set grafana.adminPassword=admin` suffit pour la conf de base) :

Le chart fournit et câble tout seul Prometheus, Grafana, Alertmanager, kube-state-metrics, node-exporter, le Prometheus Operator + ses CRDs, plus des dizaines de dashboards et de règles d'alerte par défaut.

En **partie 1**, monter la stack d'observabilité a demandé **8 fichiers de config écrits à la main** :

- `infra/prometheus/prometheus.yml` (cibles de scrape listées une par une)
- `infra/tempo/tempo.yml`, `infra/otel/config.yml`
- `infra/loki/loki-config.yml`, `infra/promtail/promtail-config.yml`
- `infra/grafana/provisioning/datasources/datasources.yml` + `.../dashboard/dashboard.yml`
- `docker-compose.infra.yml` (orchestration + ordre de démarrage)

Différence de fond : en partie 1 **on est l'intégrateur** — chaque URL de datasource, chaque cible de scrape, chaque ordre de démarrage est câblé à la main. En 4B on **consomme un package maintenu** : 0 fichier livre une stack plus complète (Alertmanager, kube-state-metrics, Operator/CRDs, alerting) que les 8 fichiers de la partie 1. C'est tout l'intérêt d'un chart communautaire pour un composant d'infra standard.

### Réflexion théorique — Pourquoi port-forward pour Grafana ?

**Question 1 — Combien de fichiers ? (rappel)**

0 fichier via le chart contre 8 en partie 1 — détaillé juste au-dessus (« Installer — nombre de fichiers »).

**Question 2 — Quel mécanisme rend TaskFlow accessible sur `:80` sans port-forward ?**

Deux pièces se combinent :

- `k8s/kind-config.yaml` : `extraPortMappings` mappe les ports `80`/`443` de l'hôte vers le conteneur control-plane, et le label `ingress-ready=true` épingle le pod ingress-nginx sur ce nœud (le seul à exposer 80/443 sur la machine).
- `k8s/base/ingress.yaml` : un Ingress `ingressClassName: nginx` déclare `/api → api-gateway:3000` et `/ → frontend:80`. Le controller ingress-nginx watch les objets Ingress et les traduit en blocs `server`/`location` NGINX.

Chaîne complète : `http://localhost:80` → port mapping kind → control-plane `:80` → ingress-nginx → règle Ingress → Service ClusterIP → kube-proxy → pod. Le controller est un point d'entrée **permanent et mappé sur l'hôte**, d'où l'absence de port-forward.

**Question 3 — Pourquoi ça ne marche pas pour Grafana ?**

Parce qu'**aucun Ingress n'existe pour Grafana**. kube-prometheus-stack expose `monitoring-grafana` en `ClusterIP` sans Ingress par défaut. ingress-nginx ne route que ce qu'un Ingress déclare → aucune règle ne pointe vers Grafana, rien sur `:80` ne l'atteint. Un `ClusterIP` n'étant joignable que depuis l'intérieur du cluster, seul `kubectl port-forward` (tunnel via l'API Server) y donne accès.

Le namespace n'est pas le blocage en soi — ingress-nginx watch tous les namespaces — mais l'Ingress devrait vivre dans `monitoring` pour référencer le Service `monitoring-grafana`.

**Question 4 — Rendre Grafana accessible sur `http://localhost/grafana` (sans toucher au chart)**

Tout passe par des **overrides de values** (méthode supportée, le code du chart reste intact). Dans `values.monitoring.yaml` :

```yaml
grafana:
  ingress:
    enabled: true
    ingressClassName: nginx
    path: /grafana
    pathType: Prefix
    hosts: ["localhost"]
  grafana.ini:
    server:
      root_url: "http://localhost/grafana"
      serve_from_sub_path: true
```

Deux éléments indispensables :

1. **L'Ingress** (exposé par le sous-chart Grafana) crée la règle `/grafana → monitoring-grafana:80` que ingress-nginx route.
2. **`serve_from_sub_path: true` + `root_url`** : sinon Grafana sert depuis `/` et ses redirections/assets cassent sous un sous-chemin.

Puis `helm upgrade`. Quand kube-prometheus-stack devient une dépendance de notre chart local (Étape 2+), ces valeurs s'imbriquent sous la clé `kube-prometheus-stack:`. Alternative : écrire son propre Ingress dans `monitoring` avec l'annotation `nginx.ingress.kubernetes.io/rewrite-target`, mais `serve_from_sub_path` reste nécessaire pour que Grafana génère les bonnes URLs.

## Étape 2 — Intégrer ses dashboards customs

### Vérifier le mécanisme avec un ConfigMap inline

**Question 1 — Commande utilisée et présence du dashboard dans Grafana**

```bash
kubectl apply -f helm/monitoring/templates/dashboard-configmap.yaml
```

Le fichier déclare déjà `namespace: monitoring`, inutile de préciser `-n`.

Le sidecar Grafana (activé dans `values.monitoring.yaml` : `grafana.sidecar.dashboards.enabled: true`, label `grafana_dashboard`) watch les ConfigMaps portant ce label dans le namespace `monitoring` et importe leur JSON automatiquement. Dans Grafana (`http://localhost/grafana` via l'Ingress, ou port-forward sur `:3100`) → **Dashboards**, le dashboard **« TaskFlow — Services »** apparaît sans le déclarer côté Grafana.

![alt text](screenshots/grafana-dashboard-configmap.png)

À noter : ce ConfigMap est appliqué via `kubectl` et non par Helm — la ressource vit donc **hors du contrôle de Helm**. C'est volontaire ici : le JSON contient `"{{ job }}"` (variable de légende Grafana), qui serait interprété comme du template Go et casserait un `helm install`. L'étape suivante (`.Files.Glob`) corrige ce point en chargeant les JSON depuis un dossier.
