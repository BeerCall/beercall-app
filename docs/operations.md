# Exploitation BeerCall

## Responsabilités

Validées explicitement pendant le Plan C :

| Opération | Responsable |
|---|---|
| Validation, publication et rollback de release | **migzer** (compte GitHub) |
| Sauvegardes, rétention, stockage hors hôte et tests de restauration | **migzer** |
| Configuration manuelle des checks GitHub obligatoires | **migzer** |

Les objectifs de perte de données et de délai de reprise (RPO/RTO) restent à fixer
par ce responsable : aucun SLA de sauvegarde n'est inventé ici.

## Release épinglée

Le parent est la version de release. Ne jamais substituer les dernières branches
des enfants aux SHA qu'il référence.

```bash
git submodule update --init --recursive
git submodule status
git ls-tree HEAD beercall-backend beercall-frontend
```

Les SHA enfants doivent être publiés et leurs CI vertes avant le commit des
gitlinks. Un préfixe `+`, `-` ou `U` dans le statut des sous-modules bloque la release.
Les CI enfants testent uniquement; elles n'envoient plus de dispatch de déploiement.
La PR parent vérifie **Validate pinned release** (smoke B) et **E2E browser (Chromium)**.
`deploy` exige les deux jobs et ne s'exécute que sur `main`, hors pull request.

**HUMAIN-C03** : après une exécution verte du workflow final, migzer doit configurer
manuellement ces deux checks comme obligatoires pour `main` dans les règles GitHub
de `BeerCall/beercall-app`. Le build ne modifie jamais ces règles. Une PR verte
n'autorise pas à elle seule un merge ou un déploiement.

## Démarrage, migrations et vérification

Les commandes production suivantes sont des procédures **Bash sur le VPS**, à
exécuter par le responsable et non dans la CI de PR. `.env` et `secrets/` restent
hors Git. Le réseau externe `proxy-network` doit déjà exister.

```bash
docker network inspect proxy-network
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose exec -T nginx_beercall nginx -t
docker compose exec -T nginx_beercall wget -qO- http://127.0.0.1/api/health/ready
docker compose ps
```

`migrate` exécute `python -m alembic upgrade head` avant l'API et les workers.
Ne pas remplacer les migrations par `metadata.create_all`, ni modifier des données
production pour faire passer un test. Pour une migration manuelle autorisée :
`docker compose run --rm migrate`.

Le frontend reçoit ses `VITE_*` **au build**, pas par une modification tardive des
variables runtime. Sans configuration Firebase, REST/WebSocket et l'inscription
restent disponibles; le chat et les notifications sont indisponibles proprement.

`/api/health/live` sonde le processus; `/api/health/ready` sonde PostgreSQL avec
`SELECT 1`. Un statut ready ne prouve pas la santé des workers, l'absence de backlog,
la livraison Firebase, ni le fonctionnement JavaScript du navigateur. Contrôler
également les logs workers et les statuts/dates de `beer_call_jobs`.

## Validation E2E locale isolée

PowerShell, depuis `beercall-app` :

```powershell
$env:BEERCALL_E2E_SECRET_KEY = [guid]::NewGuid().ToString()
docker compose -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 180
$env:BEERCALL_E2E_RESTART_WORKERS = 'true'
python scripts/smoke_e2e.py
Push-Location e2e
try {
    npm ci
    npx playwright install chromium
    npx playwright test
    npx playwright test
} finally {
    Pop-Location
    docker compose -f docker-compose.e2e.yml down -v
}
```

Ne pas ignorer un code de sortie non nul. Toujours exécuter `down -v` après un
échec, y compris avant d'entrer dans le bloc ci-dessus. Il supprime uniquement la
composition `beercall-e2e` et son volume `uploads_e2e`, jamais les données production.
Le proxy expose 8080; ni PostgreSQL ni l'API n'exposent 5433/8000 sur l'hôte.

L'E2E ne démarre pas automatiquement de serveur et ne simule pas l'API, le job
ou le WebSocket. Le détecteur de photo accepté en test est explicitement gardé
par `APP_ENV=test`. Le choix de mini-jeu est contrôlé par `BEERCALL_E2E_GAME`.
Chaque exécution crée des identifiants uniques; les attentes portent sur des
réponses et des états UI, jamais sur des sleeps arbitraires.

Sur ce poste Docker Desktop, une première création de volume a parfois rencontré
une course de copie (`aperos: file exists`). Une relance bornée a réussi; ne pas
interpréter cela comme une validation du navigateur. Les diagnostics Playwright
et le build sont indépendants du smoke HTTP.

## Sauvegarde cohérente

Procédure Bash pour une fenêtre de maintenance **autorisée par migzer**. Vérifier
l'espace disque, choisir un emplacement sécurisé hors Git, puis arrêter les
écrivains afin que le dump et les photos correspondent au même état.

```bash
set -eu
BACKUP_DIR="$HOME/beercall-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
git rev-parse HEAD > "$BACKUP_DIR/parent.sha"
git submodule status > "$BACKUP_DIR/gitlinks.txt"
docker compose stop --timeout 120 backend beer_worker daily_worker
docker compose exec -T db_beercall sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$BACKUP_DIR/database.dump"
tar -C beercall-backend -czf "$BACKUP_DIR/uploads.tar.gz" uploads
(cd "$BACKUP_DIR" && sha256sum database.dump uploads.tar.gz > SHA256SUMS)
docker compose start backend beer_worker daily_worker
```

En cas d'échec, vérifier pourquoi avant de reprendre les écritures. Sauvegarder
séparément `.env` et les credentials dans un coffre chiffré, pas dans ce dossier ni
Git. Copier les sauvegardes chiffrées hors du VPS, appliquer la rétention décidée
par migzer, vérifier les sommes et tester régulièrement une restauration isolée.
Ne pas copier à chaud `postgres_data/` comme substitut à `pg_dump`.

## Restauration

**Opération destructive : autorisation explicite de migzer obligatoire.** Tester
d'abord sur un environnement isolé, vérifier le SHA parent de la sauvegarde et
l'existence des deux SHA enfants. Ne jamais lancer ceci dans une PR ou contre une
base dont le nom/l'hôte n'a pas été vérifié. `BACKUP_DIR` doit viser la sauvegarde
retenue; la base et les uploads courants sont remplacés.

```bash
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
docker compose stop --timeout 120 backend beer_worker daily_worker
docker compose exec -T db_beercall sh -c 'pg_restore --exit-on-error --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BACKUP_DIR/database.dump"
# Après archivage/retrait autorisé des uploads courants, restaurer le répertoire complet.
tar -C beercall-backend -xzf "$BACKUP_DIR/uploads.tar.gz"
docker compose start backend beer_worker daily_worker
docker compose exec -T nginx_beercall wget -qO- http://127.0.0.1/api/health/ready
```

L'archivage/retrait des uploads courants est une étape humaine explicite : une
simple extraction ne supprime pas les fichiers supplémentaires. Vérifier les
preuves photo, les jobs pendants et la reprise des baux (jusqu'à 15 minutes pour un
job déjà running). Contrôler que l'API, les workers et le schéma restauré sont
compatibles avant de rouvrir les écritures.

## Rollback de release

Relever le parent précédent dans les logs de déploiement et les sauvegardes.
Préférer une PR de `git revert <commit-parent>` et la même double validation CI.
Un rollback d'image ne constitue pas un rollback de schéma : si les migrations
ne sont pas rétrocompatibles, arrêter et faire valider une procédure dédiée.
Ne pas lancer automatiquement `alembic downgrade base` en production.

Pour un retour d'urgence explicitement autorisé sur le VPS, avec un état suivi
propre et des données sauvegardées :

```bash
git status --short
git fetch origin
git checkout --detach <previous_verified_parent_sha>
git submodule update --init --recursive
docker compose up -d --build --wait --wait-timeout 180
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 60 nginx_beercall
docker compose exec -T nginx_beercall nginx -t
docker compose exec -T nginx_beercall wget -qO- http://127.0.0.1/api/health/ready
```

Ne pas effacer des modifications VPS ou des uploads pour débloquer un déploiement.
Le renouvellement du conteneur proxy évite de conserver l'ancien inode d'un fichier
Nginx monté. Le responsable vérifie le routage et les trois SHA après toute reprise.
