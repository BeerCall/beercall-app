# PWA locale HTTPS — sources canoniques optimisées

L'override `docker-compose.local-https.yml` est réservé au test LAN (Compose >= 2.24).
Il sert le `dist` frontend validé et construit le backend depuis les checkouts voisins
`../beercall-frontend` et `../beercall-backend`, pas les copies d'intégration. Les workers et migrations
partagent l'image backend locale. La base et les uploads existants ne sont pas effacés.

Depuis la racine BeerCall :

```powershell
npm --prefix beercall-frontend run models:prepare
npm --prefix beercall-frontend run build
docker compose -f beercall-app/docker-compose.yml -f beercall-app/docker-compose.local-https.yml build backend
docker compose -f beercall-app/docker-compose.yml -f beercall-app/docker-compose.local-https.yml up -d --no-build
```

Prérequis : réseau Docker externe `proxy-network` du compose principal, certificat serveur
avec le SAN de l'IP LAN actuelle et clé privée dans `secrets/local-https/server.crt` et
`server.key`, CA publique `ca.crt`, page d'aide locale `setup.html`. **Aucune clé ou secret
n'est versionné.** Cet override n'est pas une configuration de déploiement public.

Le montage `../beercall-backend/static/models:/srv/models:ro` permet à Nginx de livrer les
modèles originaux et préparés avec gzip statique, sans second passage par l'API. Le manifeste
se revalide ; seuls les fichiers préparés identifiés par SHA sont immutable. Les URL `.gz`
ne sont pas exposées directement. Les sorties générées sont exclues du build backend et
fournies par les montages locaux : un futur déploiement devra organiser leur livraison
explicitement, pas supposer qu'elles sont dans l'image.

## Installation téléphone

Le téléphone et le PC doivent partager le Wi-Fi. Ouvrir `http://<IP-LAN>/setup` dans Safari,
installer **BeerCall Local CA**, puis activer sa confiance totale dans Réglages > Général >
À propos > Réglages de confiance des certificats. Ouvrir `https://<IP-LAN>/` sans alerte TLS,
puis Partager > Sur l'écran d'accueil. Sur Android, installer le CA utilisateur puis ouvrir
l'URL HTTPS dans Chrome et installer l'application. Retirer le CA du téléphone après les tests.

Une exception manuelle à une alerte TLS n'est pas une installation de confiance suffisante
pour valider le service worker. Si l'IP change, refaire le certificat serveur avec le nouveau
SAN (on peut conserver la même CA). Le port 80 ne sert qu'au téléchargement du CA et à la
redirection. Le pare-feu Windows doit autoriser TCP 80/443 uniquement depuis le LAN.

## Relevé

Après connexion, ouvrir `https://<IP-LAN>/squad/<id>?perf=1`, toucher **Mesures**, rejouer le
parcours et exporter le JSON. Distinguer un premier chargement, une relance de la PWA et un
retour depuis le profil. La reconstruction des mondes fermés n'est pas assimilée au keep-alive
du dashboard. Un relevé iPhone n'est jamais une qualification Android.
Sans barre URL, activer l'outil dans **Profil > Trophées > Diagnostic de fluidité (local)**.
