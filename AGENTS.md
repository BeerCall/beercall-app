# OpenCode System Prompt - BeerCall Global (beercall-app)

Ce fichier définit les directives globales pour l'orchestration du projet BeerCall.

## Tests — E2E uniquement (décision utilisateur du 16/11/2026)

- **Ne créer, réintroduire ni lancer de TU**, y compris les TU de runners/outils et les commandes Vitest/Pytest/Node unitaires des enfants. Les TU existants et leurs invocations CI/scripts sont à retirer dans la migration prioritaire, pas à rejouer.
- Non-régression par E2E réels, avec compléments E2E pour les risques significatifs manquants ; aucun nouveau TU comme solution de remplacement.
- **≥75 % lignes frontend ET ≥75 % backend via les E2E seuls**, séparément, périmètre instrumenté existant et seuils inchangés. Aucun cumul de campagnes, skip/retry de masquage ou nouvelle exclusion de code vivant.
- Suite E2E complète **≤15 minutes**, pas par scénario. Préparation/build/seed chronométrés et bornés séparément ; annoncer le budget total et les plafonds CPU/RAM avant lancement.
- Ne pas démarrer toute la topologie de release, la génération de 50 avatars ou un renderer pour un diagnostic qui n'en a pas besoin. Watchdog externe et arrêt vérifié des descendants/services de test sur échec ou annulation.
- Aucun redémarrage/rebuild de dev ou relancement d'une campagne annulée sans GO. Types, lint et build restent autorisés sans appel indirect de TU.
- La migration est prioritaire avant toute nouvelle qualification ou reprise du ménage, un lot borné à la fois. Ne pas simplement désactiver la CI : remplacer ses appels unitaires par les contrôles/E2E opérationnels.
- Cette décision prévaut sur les anciens plans/rapports ; plan externe `C:/Users/Migz3rrr/.opencode/plan/beercall/plan-grand-menage-apres-deploiement.md`, §12k.

## 🏗 Architecture Globale
- **Type** : Application Microservices orchestrée via Docker Compose et gérée via Git Submodules.
- **Dépôt courant (`beercall-app`)** : Ne contient pas de code métier direct. Il sert uniquement d'orchestrateur (Infrastructure as Code).
- **Submodules** :
  - `beercall-backend` : API REST (Python/FastAPI).
  - `beercall-frontend` : SPA Client (React/Vite).
- **Infrastructure** : Nginx (Reverse Proxy routant `beercall.fr`) et base de données PostgreSQL (`db_beercall`).

## 🛠 Stack Technique d'Orchestration
- **Conteneurisation** : Docker, Docker Compose.
- **Proxy** : Nginx.
- **Versionnement** : Git (avec gestion stricte des `--recurse-submodules`).

## 🚀 Règles et Commandes
- **Ne jamais coder de feature directement ici**. Se diriger vers les submodules correspondants.
- Les variables d'environnement globales (`DB_USER`, `DB_PASSWORD`, `BEERCALL_SECRET_KEY`) sont définies dans le `.env` à la racine de `beercall-app` et injectées via Docker Compose.
- **Démarrage** : `docker-compose up --build -d`
- **Mise à jour des modules** : `git submodule update`
