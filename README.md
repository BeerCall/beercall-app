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
    JWT_SECRET=your_very_long_and_random_secret_key
    ```

3.  **Launch the application with Docker Compose:**

    This command will build the container images (if necessary) and start all services in the background.

    ```bash
    docker-compose up --build -d
    ```

4.  **Access the application:**

    The application should now be accessible locally at **[http://localhost](http://localhost)**.

---

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

-   **Update submodules:**
    To pull the latest code from the frontend and backend repositories:
    ```bash
    git submodule update --remote --merge
    ```
