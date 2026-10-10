# BeerCall - Main Platform

> This repository is the main entry point for the BeerCall application. It orchestrates the frontend and backend services using Git submodules and Docker Compose.

![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Nginx](https://img.shields.io/badge/nginx-009639?style=for-the-badge&logo=nginx&logoColor=white)
![Git](https://img.shields.io/badge/Git-F05032?style=for-the-badge&logo=git&logoColor=white)

---

## 🌐 Production Environment

The application is deployed and accessible at the following address:
**[https://beercall.fr](https://beercall.fr)**

---

## 🏛️ Global Architecture

The BeerCall platform is based on a microservices architecture orchestrated by Docker:

-   **`beercall-app` (this repository)**: Acts as the orchestrator. It contains no direct application code but defines the infrastructure via `docker-compose.yml` and integrates the other two services as Git submodules.
-   **`beercall-frontend`**: A Single Page Application (SPA) built with React, which constitutes the user interface.
-   **`beercall-backend`**: A RESTful API developed in Python (FastAPI), which handles business logic, database interactions, and third-party services.
-   **`db_beercall`**: A PostgreSQL database for data persistence.
-   **`nginx_beercall`**: An Nginx reverse proxy that exposes the frontend and backend services on a single port and handles request routing.

---

## 🛠️ Prerequisites

Before you begin, ensure you have the following tools installed:

-   [Git](https://git-scm.com/)
-   [Docker](https://www.docker.com/products/docker-desktop/)
-   [Docker Compose](https://docs.docker.com/compose/install/)

---

## 🚀 Installation and Launch

1.  **Clone the repository and initialize the submodules:**

    ```bash
    git clone --recurse-submodules https://github.com/your-user/beercall-app.git
    cd beercall-app
    ```

    _If you have already cloned the project without the submodules, run: `git submodule update --init --recursive`_

2.  **Environment Configuration:**

    Create a `.env` file in the project root based on the example below, and fill in the values. This file centralizes all variables for Docker Compose.

    ```bash
    # .env

    # PostgreSQL Database
    DB_USER=beercall_user
    DB_PASSWORD=your_secure_password
    DB_NAME=beercall_db

    # Secret for backend JWT tokens
    BEERCALL_SECRET_KEY=your_very_long_and_random_secret_key
    # Leave empty to disable Firebase. Set to /run/secrets/firebase.json to enable it.
    FIREBASE_CREDENTIALS_PATH=
    ```

    To enable Firebase push notifications, place your `firebase.json` credentials file inside the `secrets/` directory, and set `FIREBASE_CREDENTIALS_PATH=/run/secrets/firebase.json` in your `.env` file.

3.  **Launch the application with Docker Compose:**

    This command will build the container images (if necessary) and start all services in the background.

    ```bash
    docker-compose up --build -d
    ```

4.  **Access the application:**

    The application should now be accessible locally at **[http://localhost](http://localhost)**.

---

## Plans B/C: isolated E2E validation

Release PRs run this validation in GitHub Actions before they can be deployed.
Only `main` pushes (or a manual run on `main`) deploy, after validation succeeds.
The deployment stops on tracked VPS changes, updates exact gitlinks without forced
submodule deinitialization, preserves untracked uploads/configuration, and checks
proxied readiness after startup. The previous parent SHA is logged for rollback.

Use Python with `httpx` and `websockets` installed. The composition builds the pinned
submodules, runs migrations before the API/workers, and exposes Nginx on port 8080.
It uses a dedicated database and uploads volume, never the production database.
Only the proxy exposes a host port (8080): the database and API have no host ports
(no 5433 or 8000), avoiding collisions with local development databases/APIs.
The API, frontend and proxy have healthchecks; `up --wait` waits for readiness.
Only one stack can use port 8080 at a time.

PowerShell, from this repository:

```powershell
$env:BEERCALL_E2E_SECRET_KEY = [guid]::NewGuid().ToString()
docker compose -f docker-compose.e2e.yml up -d --build --wait
$env:BEERCALL_E2E_RESTART_WORKERS = 'true'
python scripts/smoke_e2e.py
docker compose -f docker-compose.e2e.yml down -v
```

The smoke checks proxied readiness/frontend, ticket-based WebSockets, concurrent
idempotent enqueue, job survival while both workers are stopped, successful processing
after restart, a single final apero, and outbox delivery. The test photo detector is
enabled on the API and both Beer Call workers with `APP_ENV=test` and
`PHOTO_DETECTOR_MODE=always_accept`; it is rejected at startup outside the test
environment. `BEERCALL_E2E_GAME` defaults to `BRAIN_DUEL` in this composition and
can select another playable mini-game; forced selection never applies outside test.
Firebase delivery is tested separately; no real device notification is sent by this smoke.
Always run `down -v`, including after failure, to remove the ephemeral containers
and the `uploads_e2e` volume. Do not use the production composition for these tests.

## 📂 Project Structure

```
beercall-app/
├── .gitmodules             # Git submodule declarations
├── beercall-backend/       # Submodule containing the API code (Python/FastAPI)
├── beercall-frontend/      # Submodule containing the UI code (React/Vite)
├── docker-compose.yml      # Docker services orchestration file
├── nginx/                  # Nginx reverse proxy configuration
└── README.md               # This file
```

---

## ⚙️ Useful Commands

-   **Start all services:**
    ```bash
    docker-compose up -d
    ```

-   **Stop all services:**
    ```bash
    docker-compose down
    ```

-   **View service logs:**
    ```bash
    docker-compose logs -f [service_name] # e.g., backend, frontend
    ```

-   **Update submodules to pinned versions:**
    To sync the frontend and backend submodules to the exact versions pinned in the orchestration repository:
    ```bash
    git submodule update --init --recursive
    ```
