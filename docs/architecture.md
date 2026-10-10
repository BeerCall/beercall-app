# Architecture BeerCall

## Périmètre et composants

BeerCall est un monolithe applicatif avec des processus de travail séparés, et non
un ensemble de services métier autonomes. `beercall-app` orchestre deux dépôts
épinglés par gitlinks : API FastAPI/SQLAlchemy et SPA React/Vite.

```text
Navigateur ── Nginx ── frontend statique
              │
              └── API unique ── PostgreSQL
                    │                │
                    │          beer_call_jobs / realtime_events
                    │                │
                    │          worker(s) Beer Call
                    │                │
                    └── uploads locaux partagés

API : relais outbox → WebSocket local → invalidation React Query
Worker quotidien unique → clôtures / récompenses et badges
Firebase facultatif → notifications / chat externe
```

La production utilise les services `backend`, `frontend`, `db_beercall`,
`migrate`, `beer_worker`, `daily_worker`, `nginx_beercall` de
`docker-compose.yml`. Nginx rejoint aussi le réseau externe `proxy-network` du VPS.
Les conteneurs partagent `./beercall-backend/uploads`; PostgreSQL persiste dans
`./postgres_data`. La composition E2E possède sa propre base et son volume uploads.

## Flux métier

1. Les routes authentifient, valident les données et traduisent les exceptions de
   domaine en HTTP. Les cas d'usage extraits résident dans `services/squads.py`,
   `services/apero_lifecycle.py`, `services/beer_call_participation.py`.
2. La création immédiate d'un Beer Call enregistre un input et un job durable,
   dédupliqué par utilisateur et `Idempotency-Key`, puis répond **202** avec `job_id`.
3. Un worker réclame le job sous verrou, avec identifiant de propriétaire et bail.
   L'inférence est suivie d'une finalisation transactionnelle : apéro, participant,
   capsules et événement outbox. Les états terminaux sont `succeeded`, `rejected`
   et `failed`; le frontend consulte le statut réel, sans assimiler un timeout au succès.
4. Le relais intégré à l'API diffuse l'outbox aux sockets de sa propre instance.
   Le navigateur invalide les caches de squad. Un ticket WebSocket court, stocké
   sous forme de digest et consommé une fois, évite de placer le JWT dans l'URL.
5. Programmation, démarrage, adhésion et refus conservent leurs contrats HTTP.
   Le démarrage conserve la primitive `FOR UPDATE`; l'adhésion/refus commettent
   leurs récompenses avant notifications et diffusion. Les photos d'une transaction
   échouée sont supprimées par les services concernés.
6. Les mini-jeux stockent leur état dans PostgreSQL. Le client pilote les routes
   `/api/aperos/{id}/game/start`, `/state`, `/action`, et affiche le contrat SDUI.

## Contrats et paramètres

Les types partagés frontend se trouvent dans `src/types/api.ts`; les anciens
chemins ré-exportent les types sans nouvelle déclaration.

| Paramètre | Usage et comportement |
|---|---|
| `DATABASE_URL` | URL SQLAlchemy fournie par Compose aux processus backend. |
| `BEERCALL_SECRET_KEY` | Obligatoire à l'import de `core/config.py`; jamais dans Git. |
| `APP_ENV` | `development` par défaut, ou `test` / `production`. |
| `PHOTO_DETECTOR_MODE` | `yolo` par défaut; `always_accept` interdit hors `APP_ENV=test`. |
| `BEERCALL_E2E_GAME` | Jeu forcé seulement en test; valeur inconnue refusée à l'import. |
| `FIREBASE_CREDENTIALS_PATH` | Notifications serveur facultatives; credentials montés en lecture seule. |
| `GEMINI_API_KEY` | Fournisseur des mini-jeux photo/dessin; comportement hors-ligne caractérisé par les tests. |
| `VITE_FIREBASE_*` | Configuration publique client, injectée au build; absence/partialité désactive les intégrations correspondantes. |
| `BEERCALL_E2E_SECRET_KEY` | Secret jetable de la composition E2E, distinct de la production. |

La composition production actuelle n'injecte pas `APP_ENV` : le défaut effectif
reste `development`, avec le vrai détecteur `yolo`. Charger `.env` ne transmet pas
automatiquement une variable non déclarée à un conteneur. Un changement de ce
câblage relève d'une modification explicite de la composition, pas de cette documentation.
En E2E, l'API et les deux workers Beer Call utilisent `test`/`always_accept`, et
`BRAIN_DUEL` est le défaut de la composition. Le worker quotidien n'utilise pas le détecteur.

## Limites assumées et seuils d'évolution

- **API unique et relais unique** : avant toute deuxième instance API, introduire
  une diffusion inter-instance (Redis ou service WebSocket centralisé). Deux relais
  locaux consommant la même outbox ne diffusent pas à tous les clients.
- **Worker quotidien unique** : un seul ordonnanceur, à 00:05 UTC. Ne pas lancer
  plusieurs crons sans coordination explicite.
- Les workers de jobs peuvent être multiples grâce aux baux/verrous; l'E2E en
  vérifie deux. La production en définit actuellement un.
- **Stockage objet** : requis avant un deuxième hôte écrivain. Déclencher aussi une
  étude de migration si les uploads dépassent 70 % du disque disponible ou si le
  temps de sauvegarde/restauration ne respecte plus les objectifs fixés par migzer.
- Redis et stockage objet sont des décisions futures, pas des dépendances installées.
  Les seuils ci-dessus sont des critères de décision, pas des alertes déjà implémentées.

Voir [l'ADR de mono-instance](adr/0001-monolithe-workers-singleton.md) et
[les procédures d'exploitation](operations.md).
