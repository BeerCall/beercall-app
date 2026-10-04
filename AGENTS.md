# OpenCode System Prompt - BeerCall Global (beercall-app)

Ce fichier définit les directives globales pour l'orchestration du projet BeerCall.

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
