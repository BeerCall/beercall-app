# ADR 0001 — Monolithe avec API/relais et ordonnanceur uniques

- Statut : décision actuelle documentée, sans modification d'infrastructure.
- Responsable release/exploitation : migzer, désigné pendant le Plan C.
- Contexte : MVP FastAPI/React, PostgreSQL, outbox durable, photos locales et Nginx.

## Décision

Conserver une instance API et son relais WebSocket en mémoire, un ordonnanceur
quotidien unique, et les workers de jobs comme processus séparés. PostgreSQL porte
les tickets, baux, jobs, état des mini-jeux et outbox. Les workers de jobs peuvent
être concurrents; deux sont utilisés en E2E, un est déclaré en production.

L'assemblage de release est un commit parent avec deux gitlinks exacts. Les CI
enfants ne déclenchent pas le déploiement; le parent exige le smoke durable et
l'E2E navigateur avant tout déploiement sur main.

## Raisons

Les verrous/baux et l'outbox fournissent la durabilité nécessaire sans ajouter
Redis, Celery ou un broker au MVP. La mono-instance évite une fausse promesse de
diffusion WebSocket distribuée. Les photos restent sur un stockage local partagé
entre API et worker; leur cohérence exige une sauvegarde de la base et des uploads.

## Conséquences et limites

- Pas de haute disponibilité de l'API ni de diffusion multi-instance : le registre
  des sockets est local, et l'outbox seule ne remplace pas un bus de diffusion.
- Pas de second cron quotidien sans coordination explicite.
- Ne pas confondre singleton du relais/cron et concurrence autorisée des workers de jobs.
- Liveness/readiness ne remplacent pas la validation du JavaScript et du parcours utilisateur.
- Une restauration doit conserver les références photo et vérifier les baux de jobs.

## Réévaluation

Introduire Redis/pub-sub ou un service WebSocket centralisé **avant la deuxième
instance API**. Introduire du stockage objet **avant le deuxième hôte écrivain**,
ou si les uploads consomment plus de 70 % du disque ou rendent les objectifs de
reprise irréalisables. Ces critères déclenchent une décision et un benchmark;
ils ne décrivent pas des composants déjà installés ni des alertes automatiques.

Voir [architecture](../architecture.md) et [exploitation](../operations.md).
