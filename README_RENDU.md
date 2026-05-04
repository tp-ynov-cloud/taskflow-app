Arnaud Gaydamour - Elias El Oudghiri

# Partie 1 - Observer l'application dans Grafana

## A. Instrumenter l'application

### SDK OpenTelemetry — `tracing.js`

Chaque service expose un fichier `src/tracing.js` qui initialise le SDK avec `NodeSDK`, déclare la ressource via `new Resource({ SERVICE_NAME: serviceName })` pour identifier le service dans Tempo, et exporte les traces vers l'OTel Collector en OTLP HTTP.

Les auto-instrumentations HTTP, Express et PG sont activées via `getNodeAutoInstrumentations`. Le fichier est chargé en premier dans chaque `index.js` pour garantir que l'instrumentation est active avant tout démarrage.

Pour le shutdown propre, on écoute `SIGTERM` et `SIGINT` et on appelle `sdk.shutdown()` pour vider les buffers avant de quitter.

![shutdown-open-telemetry](screenshots/shutdown-open-telemetry.png)

---

### OTel Collector — `infra/otel/config.yml`

Les receivers sont configurés en `otlp` avec gRPC (4317) et HTTP (4318). L'exporter vers Tempo utilise gRPC (`tempo:4317`), plus performant qu'HTTP pour du backend-to-backend.

Les métriques internes du collector sont exposées sur `0.0.0.0:8888` pour que Prometheus puisse les scraper. Deux pipelines sont définis : `traces` (otlp → batch → tempo + debug) et `metrics` (otlp → batch → debug).

---

### Tempo — `infra/tempo/tempo.yml`

Tempo expose son API et son UI sur le port 3200, utilisé par Grafana comme datasource. Il reçoit les traces en gRPC sur le port 4317 depuis l'OTel Collector.

Le stockage est local (`/tmp/tempo/traces`) avec un Write-Ahead Log (`/tmp/tempo/wal`), un buffer disque qui protège les traces en cas de crash avant leur écriture définitive.

---

### Prometheus — `infra/prometheus/prometheus.yml`

Le scrape interval global est de 15s. Les cibles configurées sont : `api-gateway:3000`, `user-service:3001`, `task-service:3002`, `notification-service:3003`, et `otel-collector:8888` pour les métriques internes du collector.

---

### Grafana — provisioning automatique

La datasource Prometheus (`http://prometheus:9090`) est marquée `isDefault: true`. Tempo est configuré sur `http://tempo:3200`. Le provider de dashboards charge automatiquement les JSON depuis `/var/lib/grafana/dashboards` au démarrage.

---

### docker-compose.infra.yml

Les services démarrent dans cet ordre : `tempo` → `otel-collector` → `prometheus` → `grafana`. Tempo doit être prêt avant le collector qui lui envoie des traces dès le lancement.

---

## B. Visualisation de l'application

### Métriques

Les métriques métier sont déclarées dans `metrics.js` de chaque service et instrumentées dans le code métier. Le `task-service` expose `tasks_created_total{priority}`, `tasks_status_changes_total{from_status,to_status}` et `tasks_gauge{status}` mise à jour par une requête `COUNT(*) GROUP BY status` après chaque mutation.

Le `user-service` expose `user_registrations_total` et `user_login_attempts_total{success}`. L'`api-gateway` expose `upstream_errors_total{service}` incrémenté à chaque proxy error. Le `notification-service` expose `notifications_sent_total{event_type}`.

---

### Dashboards Grafana

Les deux dashboards sont exportés dans `infra/grafana/dashboards/` et chargés automatiquement au démarrage de Grafana.

---

### Traces

#### Compréhension

La requête `POST /api/tasks` depuis le frontend génère une trace distribuée qui traverse api-gateway → task-service → PostgreSQL.

![scenario](screenshots/scenario.png)

Les spans sont reliés par un `traceId` commun propagé via le header HTTP `traceparent`. L'auto-instrumentation gère la propagation sans code supplémentaire.

Sur les spans HTTP, les attributs clés sont `http.method`, `http.route` (le pattern Express, pas l'URL réelle), `http.status_code`, et `span.kind` qui vaut `SERVER` pour le service qui reçoit et `CLIENT` pour celui qui émet.

Sur les spans PostgreSQL, `db.statement` contient la requête SQL complète — utile pour détecter les requêtes lentes ou les N+1. `db.system` vaut `postgresql`, `net.peer.name` vaut `postgres`.

![alt text](screenshots/scenario_span_database.png)

L'attribut `service.name` est commun à tous les spans d'un service, défini via `OTEL_SERVICE_NAME` dans `tracing.js`.

#### Ajout de spans custom

Redis/pub-sub n'est pas couvert par l'auto-instrumentation. Un span manuel est ajouté dans `task-service/src/routes.js` autour de la publication :

```js
const { trace } = require("@opentelemetry/api");
const tracer = trace.getTracer("task-service");

const span = tracer.startSpan("publish.task.created");
await publish("task.created", { taskId: task.id, title: task.title, assigneeId: task.assignee_id });
span.end();
```

Ce span apparaît dans le waterfall entre le span `POST /tasks` et la fin de la requête. On peut le retrouver dans Tempo avec :

```traceql
{ name = "publish.task.created" }
```

![alt text](screenshots/public-task-created.png)

---

## C. Logs

### Configuration

Promtail est configuré avec `docker_sd_configs` pour lire l'API Docker et récupérer les métadonnées des conteneurs. Le pipeline extrait `level` et `msg` depuis le JSON Pino, puis convertit les niveaux numériques en strings (30→info, 40→warn, 50→error) via une `template` stage. Loki utilise le store `tsdb` (le plus récent recommandé) avec un stockage `filesystem`.

---

### Visualisation

#### Filtrer les logs du task-service

La syntaxe LogQL utilisée est `{job="task-service"}`. Le sélecteur entre accolades fonctionne comme en PromQL : on sélectionne un flux de logs par label.

La différence avec Prometheus est que LogQL opère sur des lignes de texte, pas des valeurs numériques. On peut filtrer sur le contenu (`|= "error"`), parser le format (`| json`) et extraire des champs — le résultat par défaut est un flux de logs bruts, pas un graphe.

![alt text](screenshots/loki-syntax.png)

Pour retrouver les erreurs du task-service :

```logql
{service_name="/taskflow-app-task-service-1", level="error"} |= ``
```

![alt text](screenshots/loki-error.png)

#### Logs d'erreur et filtrage sur statusCode 500

Logs de niveau error sur tous les services :

```logql
{job=~".+"} | json | level="error"
```

Filtrage sur les requêtes ayant retourné un 500 :

```logql
{job=~".+"} | json | statusCode=`500`
```

Dans Prometheus, `http_requests_total{status="500"}` donne un compteur agrégé — performant, indexé, conçu pour alerter. Dans Loki, on obtient la même information en parsant les logs, mais c'est plus coûteux car Loki doit lire et parser chaque ligne.

Prometheus est la bonne approche pour détecter et compter les erreurs 500. Loki est utile pour voir le détail de chaque requête en erreur — ce qu'une métrique seule ne peut pas fournir. Les deux sont complémentaires.

![alt text](screenshots/prometheus-logs.png)
![alt text](screenshots/loki-logs.png)

#### Corrélation logs ↔ traces

Le traceId relevé dans Tempo après un `POST /api/tasks` : `cb67f832b3533ede816e99f2f420738c`

On peut le retrouver dans Loki car l'auto-instrumentation OTel injecte le `trace_id` dans le contexte et Pino le logue dans le JSON :

```logql
{job=~".+"} |= "cb67f832b3533ede816e99f2f420738c"
```

Pour que ce soit automatique, il faudrait configurer les **Derived Fields** dans la datasource Loki de Grafana : une regex détecte le champ `trace_id` dans les logs et crée un lien cliquable vers Tempo.

![alt text](screenshots/loki-trace-id.png)

#### Démarche d'investigation face à un pic d'erreurs

On commence par Prometheus : `rate(http_requests_total{status=~"5.."}[5m])` ventilé par `job` identifie le service concerné et la fenêtre de temps.

On bascule sur Loki pour lire les logs d'erreur du service : `{job="task-service"} | json | level="error"`. Les logs Pino donnent le message exact et la route concernée.

On prend un `trace_id` visible dans les logs et on l'ouvre dans Tempo. Le waterfall montre quelle étape a échoué dans la chaîne et combien de temps chaque span a pris.

---

# TP — Stress test avec k6

## Étape 1 — Lancer un premier test léger

**Question 1** — La latence p95 mesurée par k6 est **32.29ms**, en dessous du seuil de 200ms.

![alt text](screenshots/1-first-stress-test.png)

**Question 2** — `http_req_failed` est à 100%, il y a des erreurs 401, le token n'est pas transmis à la requête.

![alt text](screenshots/1-first-stress-test-error.png)


## Étape 2 — Monter la charge progressivement

**Question 3** — À 50 VUs (scénario par défaut), le check `tasks response < 500ms` ne faillit pas : p95 à 81.1ms, 0% d'échecs.

![alt text](screenshots/2-k6-result-run.png)

À 100 VUs, les checks passent encore. À 150 VUs, le check commence à échouer : 1352 échecs sur 1605 tentatives (14% d'échecs), avec une p95 globale à 2.79s. Le système est dégradé mais pas totalement saturé — 15% des GET tasks passent encore sous 500ms. À 200 VUs, le check s'effondre complètement : 0% de succès, p95 à 2.45s. Le seuil de rupture se situe donc autour de **150 VUs**.

**Test avec 150 vus**
![alt text](screenshots/2-k6-result-run-150-vus.png)

**Test avec 200 vus**
![alt text](screenshots/2-k6-result-run-200-vus.png)

**Question 4** — À chaque itération, l'API Gateway reçoit un total de 4 requêtes, qui sont ensuite distribuées de la manière suivante :
- 1 requête vers le user-service (POST login).
- 2 requêtes vers le task-service (GET tasks et POST create task).
- 1 requête vers le notification-service (GET notifications).

*Répartition du trafic :*  
Puisque l'API Gateway centralise ces 4 appels, elle supporte logiquement une charge plus lourde que les services individuels. Concrètement, elle reçoit :
- 4 fois plus de trafic que le user-service ou le notification-service (qui n'en reçoivent qu'un seul chacun).
- 2 fois plus de trafic que le task-service (qui en reçoit deux).

![alt text](screenshots/2-first-stress-test.png)

**Question 5** — Le `task-service` reçoit 2 requêtes par itération contre 1 pour les autres services, mais chacune de ces requêtes est coûteuse : le GET tasks fait un `SELECT` complet, le POST tasks fait un `INSERT` puis un `COUNT GROUP BY` pour la gauge, et déclenche une publication Redis.


## Étape 3 — Tester les limites de `docker scale`

**Question 6** — `docker compose up --scale task-service=3` échoue avec une erreur de port déjà alloué. La cause est le mapping statique `"3002:3002"` dans `docker-compose.yml` : les 3 replicas essaient tous de binder le même port hôte 3002, ce qui est impossible. La fix est de supprimer les ports du task-service — Docker gère les ports internes seul, et l'api-gateway accède au service via le réseau Docker interne.

![alt text](screenshots/scale-port-error.png)

**Question 7** — Après le fix, les 3 replicas démarrent et reçoivent bien du trafic dans Grafana. Les checks passent mieux qu'avant : `tasks response < 500ms` monte à 36% de succès contre 15% avant le scaling, et la p95 tombe de 2.79s à 1.41s. Le scaling a donc amélioré les métriques.

Cependant, de nouvelles erreurs apparaissent : 5 `create task 201` échoués et 35 `notifs response < 500ms` dépassés qui n'existaient pas avant. Avec 3 replicas, chacun maintient son propre pool de connexions PostgreSQL. À 150 VUs, les 3 replicas ouvrent des connexions en parallèle et peuvent atteindre la limite `max_connections` de Postgres (100 par défaut) — Postgres refuse alors de nouvelles connexions et le service retourne un 500. C'est une limite du scaling horizontal naïf : on scale l'applicatif mais la base reste un goulot partagé. En production on résoudrait ça avec un connection pooler comme PgBouncer.

En revanche, sur `http://localhost:9090/targets`, Prometheus ne voit qu'une seule target `task-service` malgré les 3 replicas. Prometheus est configuré avec l'adresse statique `task-service:3002` dans `prometheus.yml` — Docker résout ce nom DNS vers l'un des replicas de façon aléatoire, Prometheus scrape donc toujours un seul container sans avoir connaissance des deux autres.

![alt text](screenshots/3-k6-scale-error.png)

**Question 8** — `docker scale` ne suffit pas en production pour plusieurs raisons. Il n'y a pas de service discovery : Prometheus et d'autres outils ne détectent pas automatiquement les nouvelles instances. Il n'y a pas de health check au niveau du load balancer : si un replica tombe, le trafic continue de lui être envoyé. Enfin, il n'y a aucune gestion du rolling update ou du rollback. Kubernetes résout ces problèmes avec des Deployments (scaling déclaratif avec health checks), un service discovery natif, et une intégration avec des outils comme Prometheus Operator qui détecte automatiquement les pods via des `ServiceMonitor`.

## Étape 4 — Limites de l'instrumentation

**Question 9** — Le panel affiche "No data" parce que les erreurs signalées par k6 ne sont pas des erreurs HTTP 5xx. Le check `tasks response < 500ms` échoue quand le serveur répond en plus de 500ms mais retourne quand même un 200 OK — Prometheus ne voit donc aucun status 5xx. Le panel ne peut pas détecter une dégradation de performance, seulement des erreurs applicatives. Une réponse lente reste invisible pour ce panel.

**Question 10** — Le panel mesure la latence **à l'intérieur** du service, à partir du moment où Node.js accepte la connexion TCP. Sous forte charge, les requêtes font la queue au niveau de l'OS avant même d'atteindre Express, ce temps d'attente n'est jamais mesuré. k6 lui mesure la latence end-to-end depuis le client, connection comprise.

C'est pour ça que k6 voit p95=2.45s alors que Grafana reste flat : Grafana ne voit que les requêtes qui ont déjà passé la file d'attente. Pour rectifier ça, il faudrait pousser les métriques k6 directement dans Prometheus via `k6 run --out experimental-prometheus-rw`, ou utiliser un Blackbox Exporter qui sonde les services depuis l'extérieur.

---

# Partie 3 — Kubernetes

## Étape 3 — Déploiement du `user-service`

### Diagnostic du `ImagePullBackOff`

**Question 1** — Après `kubectl apply -f k8s/base/user-service/`, le Terminal A affiche les pods en `ImagePullBackOff` au lieu de `1/1 Running`. Pour diagnostiquer, on regarde la section Events du pod :

```bash
kubectl describe pod -l app=user-service -n staging
```

Dans Events, Kubernetes remonte un message du type :

```
Failed to pull image "mageas/taskflow-user-service:v0.0.1":
  rpc error: code = NotFound desc = failed to pull and unpack image:
  failed to resolve reference: not found
Warning  Failed     ErrImagePull
Warning  Failed     ImagePullBackOff
```

Kubernetes nous dit donc explicitement qu'il n'arrive pas à trouver l'image sur le registry distant — le tag `v0.0.1` du repo `mageas/taskflow-user-service` n'existe pas (ou n'est pas accessible). Je n'avait pas push l'image en arm.

---

**Question 2** — La différence majeure avec le déploiement Docker Compose des TPs précédents : en Compose, la directive `build: ./user-service` construit l'image **localement** sur le daemon Docker de la machine, qui sert ensuite directement le conteneur. Aucun pull n'est nécessaire.

Sur kind, les nœuds du cluster tournent dans des conteneurs Docker isolés avec leur propre runtime containerd. Ils ne voient pas le daemon Docker local — l'image **doit donc venir d'un registry distant** (Docker Hub) ou être chargée explicitement dans le cluster. Ce qui manque concrètement, c'est que le tag `v0.0.1` n'a jamais été publié : le workflow `release.yml` ne se déclenche que sur `git push tag v*.*.*`, et aucun tag n'a été poussé depuis mon fork.

### Correction

Pour publier l'image sur mon propre Docker Hub, puis adapter `k8s/base/user-service/deployment.yaml` :

```bash
git tag v0.0.3
git push origin v0.0.3
```

```yaml
image: mageas/taskflow-user-service:v0.0.3-arm64
```

Avec en complément `imagePullPolicy: IfNotPresent` (déjà présent dans le manifest) pour que le kubelet ne tente pas de re-pull depuis Docker Hub.

Il faut aussi ajouter les secrets avec :
```bash
kubectl create secret generic postgres-secret -n staging \
  --from-literal=POSTGRES_USER=admin \
  --from-literal=POSTGRES_PASSWORD=admin \
  --from-literal=POSTGRES_DB=taskflow \
  --from-literal=DATABASE_URL='postgresql://admin:admin@postgres:5432/taskflow' \
  --from-literal=JWT_SECRET='change-me-in-prod'
```

Après application, les pods passent en `1/1 Running` :

```bash
kubectl get pods -n staging -o wide
NAME                            READY   STATUS    RESTARTS   AGE   NODE
user-service-6fd54dcb6b-4dh8p    1/1     Running   0          12s   taskflow-worker
user-service-6fd54dcb6b-5bzmv    1/1     Running   0          12s   taskflow-worker2
```

![alt text](screenshots/k8s-user-service-running.png)

---

## Étape 4 — Déployer PostgreSQL (StatefulSet)

Les trois fichiers `k8s/base/postgres/` (`secret.yaml`, `service.yaml`, `statefulset.yaml`) ont été complétés : Secret avec `POSTGRES_USER/PASSWORD/DB` + `DATABASE_URL` + `JWT_SECRET`, Service **headless** (`clusterIP: None`) sur le port 5432, StatefulSet 1 replica avec `volumeClaimTemplates` (1Gi RWO), probes `pg_isready` et image `postgres:16-alpine`.

Après `kubectl apply -f k8s/base/postgres/` :

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

3 pods en `Running` au total. Le pod du StatefulSet a un nom **ordinal stable** (`postgres-0`) et non un hash aléatoire comme les Deployments. Le PVC `postgres-data-postgres-0` a été créé automatiquement à partir du `volumeClaimTemplates` et est `Bound` à un PV provisionné par la `StorageClass standard` de kind. Le scheduler a placé `postgres-0` sur `taskflow-worker2` ; les replicas du `user-service` sont répartis sur les deux workers.

### Questions Deployment vs StatefulSet

**Question 1** — La propriété qui garantit qu'un Pod conserve son volume au redémarrage / rescheduling est le couple **identité stable + `volumeClaimTemplates`**. Le StatefulSet attribue à chaque Pod un nom ordinal stable (`postgres-0`, `postgres-1`, …) et lui associe un PVC dédié dont le nom est dérivé de cet ordinal (`postgres-data-postgres-0`). Quand le Pod est supprimé puis recréé — sur le même nœud ou un autre — le contrôleur le **réassocie au même PVC**, donc au même PV (le PVC n'est pas détruit avec le Pod). Un Deployment, au contraire, génère des hashs aléatoires : à chaque recréation, le Pod perdrait toute corrélation avec un PVC précédent.

**Question 2** — Un Deployment serait inadapté pour PostgreSQL pour plusieurs raisons :

- **Pas d'identité stable** : avec `replicas: 1`, lors d'un rescheduling, le nouveau Pod (nouveau hash) pourrait tenter de monter un PVC `RWO` encore attaché à l'ancien Pod en cours d'arrêt → blocage `Multi-Attach error`.
- **Stratégie de mise à jour incompatible** : un Deployment fait du rolling update (`maxSurge`), donc démarre un nouveau Pod **avant** d'arrêter l'ancien. Avec un volume `RWO` et une base de données, c'est interdit (deux processus PostgreSQL ne peuvent pas écrire sur le même répertoire de données simultanément).
- **Pas d'ordre garanti** : si un jour on scale à plusieurs replicas (réplication primary/replica), un Deployment ne garantit aucun ordre de démarrage / terminaison. Un StatefulSet démarre `pod-0` → `pod-1` → `pod-2` séquentiellement, ce qui correspond exactement au besoin d'une base distribuée pour bootstrap.
- **Pas de DNS stable** : le Service headless du StatefulSet expose chaque pod via `postgres-0.postgres.staging.svc` — utile pour la réplication. Un Deployment n'offre pas ça.

**Question 3** — Parmi les services restants, **Redis** est le meilleur candidat à un StatefulSet en production. Dans cette stack, Redis sert de **bus de messages pub/sub** entre `task-service` (producer) et `notification-service` (subscriber). En staging on tolère une perte des données au redémarrage (d'où le Deployment dans l'étape 6), mais en production :

- Si on active la **persistance Redis** (RDB/AOF) pour ne pas perdre les messages en cas de crash, il faut un volume persistant stable → `volumeClaimTemplates`.
- Si on passe à du **Redis en cluster** (Sentinel ou Redis Cluster pour la haute dispo), chaque nœud Redis a besoin d'une **identité réseau stable** pour être référencé par ses pairs → DNS stable du Service headless.
- L'ordre de démarrage importe pour qu'un master élu reste le master après reschedule.

Les autres services sont stateless et conviennent parfaitement à un Deployment :
- `notification-service` : worker pub/sub sans état persistant local (l'abonnement Redis se reconstruit au démarrage).
- `api-gateway` : proxy HTTP, aucun état entre requêtes.
- `frontend` : nginx servant des fichiers statiques compilés, totalement immuable.

---

## Étape 5 — Déployer le `task-service` et le `notification-service`

Les 6 fichiers ont été créés en s'appuyant sur le pattern du `user-service` :

- `k8s/base/task-service/` : ConfigMap (PORT 3002, REDIS_URL, OTEL), Deployment (image `taskflow-task-service`, probes `/health`, secret `postgres-secret` pour `DATABASE_URL` et `JWT_SECRET`), Service ClusterIP sur 3002.
- `k8s/base/notification-service/` : ConfigMap (PORT 3003, REDIS_URL, OTEL), Deployment (image `taskflow-notification-service`, probes `/health`, **pas de DATABASE_URL** car le service stocke ses notifications en mémoire), Service ClusterIP sur 3003.

Après `kubectl apply -f k8s/base/task-service/ -f k8s/base/notification-service/`, tous les pods passent en `1/1 Running`.

### Choix du nombre de replicas

**Question 1 — Comment le `notification-service` consomme-t-il les événements Redis ?**

Dans `notification-service/src/subscriber.js`, le service utilise l'API **Pub/Sub native de Redis** : `subscriber.subscribe('task.created', callback)` et `subscriber.subscribe('task.status_changed', callback)`. Chaque instance ouvre sa propre connexion Redis et s'abonne aux deux canaux. Les notifications produites sont stockées dans un **tableau en mémoire** (`const notifications = []`), pas dans une base partagée.

**Question 2 — Implication sur le nombre de replicas ?**

Le Pub/Sub Redis est un broadcast : **tout subscriber abonné à un canal reçoit une copie de chaque message publié**. Contrairement à un Redis Stream avec consumer group (où Redis distribue les messages entre consommateurs), il n'y a aucune répartition de charge.

Concrètement, si on déploie 2 replicas du `notification-service`, chaque `task.created` publié par le `task-service` est livré aux **2 replicas en parallèle** : la notification est stockée 2 fois (dans deux tableaux en mémoire distincts), et la métrique `notifications_sent_total` est incrémentée 2 fois. À la lecture, le client appelle un seul replica au hasard via le Service ClusterIP et obtient une vue partielle des notifications selon celui qu'il a touché.

**Question 3 — Justification**

Le `notification-service` est donc fixé à **`replicas: 1`**. Tant que les notifications restent stockées en mémoire et que le pub/sub Redis est utilisé sans consumer group, scaler horizontalement crée des doublons et casse la lecture. Pour pouvoir scaler, il faudrait soit migrer vers Redis Streams + consumer group (un seul replica traite chaque message), soit persister les notifications dans une base partagée (Postgres) pour que chaque replica voie le même état.

Les autres services sont eux scalables sans souci :
- `task-service` reste à `replicas: 2` : c'est un service HTTP stateless, l'état est dans Postgres et la publication Redis est un fire-and-forget côté producer (aucune duplication possible côté publisher).
- `user-service` reste à `replicas: 2` pour les mêmes raisons.

---

## Étape 6 — Déployer Redis (Deployment)

Les deux fichiers `k8s/base/redis/` ont été complétés : Deployment 1 replica avec l'image `redis:7-alpine` sur le port 6379, et Service ClusterIP sur 6379.

### Choix d'un Deployment plutôt qu'un StatefulSet

Cohérent avec la justification de l'étape 4 (question 3) : en staging on tolère la perte des données Redis au redémarrage. Le pub/sub Redis est un broadcast en mémoire, sans persistance par défaut — un message non livré au moment de la publication est perdu de toute façon. Pas de volume → pas besoin de l'identité stable d'un StatefulSet.

### Adaptation de la `readinessProbe`

Redis n'expose pas d'endpoint HTTP `/health` comme les services Node : c'est un serveur TCP qui parle le protocole RESP. La probe utilise donc un `exec` qui lance `redis-cli ping` dans le conteneur — Redis répond `PONG` quand il est prêt à accepter des connexions, ce qui valide à la fois que le process est démarré et qu'il a fini son chargement initial.

```yaml
readinessProbe:
  exec:
    command: ["redis-cli", "ping"]
  initialDelaySeconds: 5
  periodSeconds: 10
```

Une alternative aurait été un `tcpSocket` sur le port 6379 — plus léger mais moins précis : il valide que le port est ouvert sans vérifier que Redis répond effectivement aux commandes.

Après `kubectl apply -f k8s/base/redis/`, le pod Redis passe en `1/1 Running` et le `notification-service` peut s'abonner aux canaux `task.created` et `task.status_changed` via le DNS interne `redis:6379`.

---

## Étape 7 — Déployer l'`api-gateway` et le frontend

### `api-gateway`

Trois fichiers créés dans `k8s/base/api-gateway/` :
- **ConfigMap** : `PORT=3000`, les trois URLs internes (`USER_SERVICE_URL=http://user-service:3001`, `TASK_SERVICE_URL=http://task-service:3002`, `NOTIFICATION_SERVICE_URL=http://notification-service:3003`) et la conf OTEL.
- **Deployment** : 2 replicas, image `taskflow-api-gateway`, `JWT_SECRET` injecté depuis `postgres-secret`, probes HTTP sur `/health` (port 3000).
- **Service** : ClusterIP sur 3000.

### `frontend`

Deux fichiers créés dans `k8s/base/frontend/` :
- **Deployment** : 2 replicas, image `taskflow-frontend` (nginx + bundle React précompilé), probes HTTP sur `/` (port 80). Aucun ConfigMap nécessaire — la conf nginx est embarquée dans l'image et le proxy `/api` → `api-gateway:3000` est résolu via le DNS Kubernetes.
- **Service** : ClusterIP sur 80.

### Justification des choix (replicas et ressources)

**`api-gateway`** :
1. **À quoi sert-il ?** Logique métier : reverse-proxy HTTP qui authentifie les requêtes (vérification JWT) et les route vers le bon service interne.
2. **État partagé ?** Aucun. Chaque requête est traitée indépendamment, le JWT contient toute l'information utilisateur. Scaler horizontalement est sans risque.
3. **Impact d'une indisponibilité ?** Critique : c'est le **point d'entrée unique**. Si l'`api-gateway` tombe, toute l'API est inaccessible — d'où `replicas: 2` minimum pour qu'un pod puisse encaisser le trafic pendant qu'un autre redémarre.
4. **Code à chaque requête ?** Oui : Node parse le JSON, valide le JWT (HMAC-SHA256), reproxie en HTTP. CPU bound modéré → `requests: 100m / 128Mi`, `limits: 200m / 256Mi`, identique aux autres services Node.

**`frontend`** :
1. **À quoi sert-il ?** Fichiers statiques. nginx sert un bundle React précompilé + reverse-proxie `/api` vers l'`api-gateway`.
2. **État partagé ?** Aucun. Tous les replicas servent les mêmes fichiers immuables issus de l'image.
3. **Impact d'une indisponibilité ?** Modéré : l'API continue à tourner mais l'UI est inaccessible. `replicas: 2` aussi pour la résilience.
4. **Code à chaque requête ?** Quasiment rien : nginx lit un fichier sur le disque ou forward un proxy_pass — pas de runtime applicatif. Ressources très basses → `requests: 25m / 32Mi`, `limits: 100m / 64Mi`.

L'écart de ressources entre `api-gateway` (Node, CPU/mémoire modéré) et `frontend` (nginx, quasi rien) reflète directement la nature des deux services : exécution de logique vs. service de fichiers statiques.

Après `kubectl apply -f k8s/base/api-gateway/ -f k8s/base/frontend/`, les 4 pods (`api-gateway` ×2, `frontend` ×2) passent en `1/1 Running`.

---

## Étape 8 — Vérifier que tout tourne

```bash
kubectl get all -n staging
```

Tous les pods sont attendus en `1/1 Running` :

- `postgres-0` (StatefulSet, 1 replica)
- `redis-*` (Deployment, 1 replica)
- `user-service-*` ×2
- `task-service-*` ×2
- `notification-service-*` ×1 (cf. justification étape 5)
- `api-gateway-*` ×2
- `frontend-*` ×2

Soit **11 pods** au total, répartis sur les workers `taskflow-worker` et `taskflow-worker2` par le scheduler.

![alt text](screenshots/k8s-all-running.png)

### Note sur les erreurs OTEL dans les logs

```bash
kubectl logs -n staging deployment/task-service
```

Les logs des services Node remontent des erreurs récurrentes du type :

```
Error: connect ECONNREFUSED otel-collector:4318
```

C'est attendu : la stack d'observabilité (OTel Collector, Tempo, Prometheus, Grafana, Loki) est définie dans `docker-compose.infra.yaml` et n'a pas été portée en manifests Kubernetes dans ce TP. L'instrumentation OTel des services tente de pousser les traces et métriques toutes les 10 secondes, échoue, et logue l'erreur — sans impact sur le traitement des requêtes HTTP. La porter sur k8s nécessiterait des manifests pour Tempo, Prometheus, Grafana et le Collector, plus une intégration via `ServiceMonitor` (Prometheus Operator) pour la découverte dynamique des targets.

---

## Partie 2 — Exposer avec un Ingress

### Inscription depuis l'interface

**Question 1 — Est-ce que l'inscription fonctionne ?**

Non. Le formulaire échoue avec une erreur 500 côté front : le `POST /api/users/register` retourne une erreur serveur.

**Question 2 — Remontée des logs et accès à PostgreSQL**

Investigation en remontant la chaîne. D'abord l'`api-gateway` :

```bash
kubectl logs -n staging deployment/api-gateway --tail=50
```

Aucune trace du `register` côté gateway, seulement les `/health` des probes. Le proxy ne logue pas les requêtes réussies au niveau info — il forward et c'est tout. On descend au `user-service` (avec `-l` pour agréger les 2 replicas) :

```bash
kubectl logs -n staging -l app=user-service --tail=200 | grep -iE "error|register"
```

On y trouve bien le `POST /users/register` mais avec une erreur peu informative :

```json
{
  "level": 50,
  "req": { "method": "POST", "url": "/users/register", ... },
  "res": { "statusCode": 500 },
  "err": { "type": "Error", "message": "failed with status code 500" },
  "msg": "request failed : failed with status code 500"
}
```

C'est pino-http qui logue génériquement le 500 — l'erreur SQL réelle n'apparaît pas. En relisant `user-service/src/routes.js`, on comprend pourquoi :

```js
} catch (err) {
  if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
  res.status(500).json({ error: 'Internal server error' });  // err jamais loggué
}
```

Le `catch` swallow l'erreur sans la logger. Pour voir la cause réelle, il faut inspecter directement la base. Le Service `postgres:5432` est ClusterIP, donc inaccessible depuis l'hôte — on ouvre un port-forward :

```bash
kubectl port-forward -n staging svc/postgres 5432:5432
```

Puis `psql` depuis la machine :

```bash
PGPASSWORD=admin psql -h localhost -U admin -d taskflow -c "\dt"
```

Résultat : `Did not find any relations.` Aucune table dans la base. L'`INSERT INTO users` du register tape sur une table qui n'existe pas — d'où le 500.

**Question 3 — Comparaison avec `docker-compose.yaml`**

Dans `docker-compose.yml`, le service postgres monte explicitement le script d'init :

```yaml
volumes:
  - postgres_data:/var/lib/postgresql/data
  - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
```

Le bind mount `./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql` exploite une convention de l'image officielle `postgres` : tout fichier `*.sql` ou `*.sh` placé dans `/docker-entrypoint-initdb.d/` est exécuté **au premier démarrage** quand le data directory est vide. C'est ce qui crée les tables `users`, `tasks`, `notifications` et insère Alice et Bob.

Mon StatefulSet d'origine ne montait que le PVC pour les données, **pas le script d'init**. Conséquence : la base démarre vide, schéma absent, register en erreur 500.

### Correction

Création d'un ConfigMap `postgres-init` qui contient le contenu de `scripts/init.sql`, puis montage dans le pod au chemin attendu par l'image officielle :

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

Mise à jour du `statefulset.yaml` :

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

⚠️ **Important** : `/docker-entrypoint-initdb.d/` n'est exécuté que si le data directory est vide. Comme le PVC contient déjà des données du premier démarrage, il faut le supprimer pour que l'init re-tourne :

```bash
kubectl delete -f k8s/base/postgres/
kubectl delete pvc -n staging postgres-data-postgres-0
kubectl apply -f k8s/base/postgres/
```

Après recréation, `\dt` montre les 3 tables, et l'inscription depuis l'interface réussit.

### Service vs Ingress

**Question 1 — Pourquoi `localhost:5432` ne fonctionne pas sans port-forward ?**

Le Service `postgres` est de type `ClusterIP` (le défaut). Un ClusterIP attribue une IP virtuelle **uniquement routable à l'intérieur du cluster** — kube-proxy crée des règles iptables/IPVS sur chaque nœud pour rediriger cette IP vers les endpoints des pods. Cette IP n'est pas exposée sur l'hôte de la machine.

Par ailleurs, le mapping `extraPortMappings` de kind ne forward sur l'hôte que les ports 80/443 du `taskflow-control-plane` (pour l'Ingress). Aucun mapping n'a été défini pour le 5432, et même si on en ajoutait un, ça ne résoudrait pas vers le Service Postgres — kind n'expose que les ports en `NodePort` ou via l'Ingress controller.

`kubectl port-forward svc/postgres 5432:5432` contourne tout ça : kubectl ouvre un tunnel TCP local-vers-cluster via l'API Server, qui se charge de relayer le trafic au pod cible. C'est pratique pour du debug ponctuel, pas une solution à laisser tourner en prod.

**Question 2 — Qui fait le routage HTTP décrit par l'Ingress ?**

L'objet `Ingress` lui-même n'est qu'**une déclaration de routage** — un manifest YAML stocké dans etcd. Sans contrôleur pour le lire, il ne fait strictement rien.

Le routage est effectivement assuré par l'**ingress-nginx-controller**, déployé via :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

Ce manifest crée un Deployment dans le namespace `ingress-nginx` qui contient un binaire NGINX + un agent Go (le controller) qui watch l'API Kubernetes. Quand un objet `Ingress` est créé/modifié, le controller le traduit en blocs `server { ... location /api { proxy_pass ... } }` dans la conf NGINX et la recharge à chaud.

Pour qu'il soit joignable depuis l'hôte, on l'a forcé à se scheduler sur `taskflow-control-plane` (`nodeSelector: ingress-ready: "true"`) — seul nœud où kind a configuré `extraPortMappings` pour exposer 80/443 sur la machine. C'est NGINX qui reçoit chaque requête sur `localhost:80`, lit le path et la forwarde au Service approprié.

**Question 3 — Qui load-balance entre les replicas de `task-service` ?**

Ce n'est **ni l'Ingress ni le controller NGINX** : c'est le **Service ClusterIP** `task-service` lui-même, via **kube-proxy**.

Le flow concret pour une requête `GET /api/tasks` :

1. Le client tape `http://localhost/api/tasks` → kind forward le port 80 vers le pod `ingress-nginx-controller`.
2. NGINX matche la règle `/api` dans le manifest `Ingress` → il proxy vers `api-gateway:3000` (nom DNS du Service).
3. CoreDNS résout `api-gateway` en l'IP virtuelle ClusterIP du Service.
4. **kube-proxy** intercepte la connexion sur cette IP via ses règles iptables et la redirige vers **un pod au hasard** parmi les endpoints du Service (round-robin / random selon le mode).
5. L'`api-gateway` valide le JWT puis appelle `http://task-service:3002/tasks` — même mécanisme : CoreDNS → ClusterIP → kube-proxy → un des 2 replicas `task-service`.

Le load balancing se fait donc à **chaque saut de Service**, au niveau L4 (TCP), par kube-proxy. NGINX ne sait même pas que le `task-service` a 2 replicas — il ne voit que l'IP virtuelle du Service `api-gateway`.

**Implication sur le rôle de l'Ingress** : l'Ingress n'est **pas un load balancer applicatif**, c'est un **routeur HTTP L7 d'entrée** (host/path → Service). Le vrai load balancing inter-replicas est délégué aux Services. C'est aussi pour ça que dans cette stack, retirer l'Ingress ne casserait pas la communication interne entre services — seul l'accès depuis l'extérieur disparaîtrait.
