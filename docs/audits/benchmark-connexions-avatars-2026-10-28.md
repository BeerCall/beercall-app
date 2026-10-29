# Benchmark — apparition des avatars cadrés dans Connexions

- **Question** : supprimer le calcul bloquant puis viser environ 20 ms à l'ouverture des premières miniatures préparées, sans perdre le cadrage ni multiplier les scènes actives.
- **Date** : 2026-10-28.
- **Référence** : frontend `739feaa` ; mesure CPU de son helper inchangé `computeThumbnailIdleEnvelope`, comparé au catalogue précalculé.
- **Correctifs frontend** : `3ff0624` (préparation et mesure), `91a560d` (cadrage et pause), `e453ffa` (préparation après carte et conservation de Connexions).
- **Environnement** : Windows 10.0.19045, Intel i7-6500U 2,50 GHz, Node 24.18.1, Three 183 ; Chromium local, viewport mobile 390×844. Aucun test de charge sur le LAN réel ou un tiers.
- **Preuves brutes** : [JSON des mesures](benchmark-connexions-avatars-2026-10-28.json).

## 1. Verdict

Le calcul lourd est retiré du chemin d'affichage des modèles préparés. La révélation des deux Canvas déjà préparés prend **19,1 ms en médiane**, maximum **21,9 ms** sur dix ouvertures au format mobile. C'est proche de l'objectif utilisateur ; ce n'est pas une certification Safari/iPhone à 20 ms ni une garantie à froid.

Une ouverture avant préparation reste plus lente : observation unique à environ 2 s pour la première frame soumise. Cette limite n'est pas masquée par les chiffres CPU.

## 2. Protocole

| Élément | Méthode |
|---|---|
| CPU | Mêmes quatre véritables modèles Worker, même clip Idle, pose initiale déjà évaluée comme au runtime ; aucun téléchargement ni rendu GPU dans la mesure |
| Répétitions CPU | Un échauffement exclu par variante, puis dix mesures ; ordre A/B alterné ; aucune valeur supprimée |
| Comparaison | A : échantillonnage synchrone complet ; B : union des enveloppes précalculées par pièce, transformées dans l'assemblage réel |
| Navigateur | Préparation après `mapInteractive`, deux Canvas ayant réellement soumis une frame puis arrêtés (`frameloop=never`), dix ouvertures conservant les mêmes nœuds |
| Fin de mesure de révélation | Commit de visibilité de la route après le clic ; ne mesure pas les photons sur la dalle |
| Fonctionnel | Coins NDC ≤0,8 ; centre réel ±2 px ; matrices finies et caméra stable ; pièces obligatoires, vrai draw-call et budget ≤2 Canvas ; accessoires et redimensionnements conservés |

Les boîtes précalculées par pièce ont des gardes indépendantes : elles ne sont pas nécessairement identiques bit à bit à la boîte globale historique. Les garanties géométriques sont rejouées, pas abaissées. La génération conserve l'échantillonnage complet à 120 Hz et la validation indépendante à 240 Hz. Elle démarre en Idle et non en T-pose.

## 3. Résultats

| Mesure (ms) | Médiane | p95 / p99 | Min–max | Écart-type | n |
|---|---:|---:|---:|---:|---:|
| CPU historique | 2566,287 | 3177,418 | 2439,819–3177,418 | 201,335 | 10 |
| CPU précalculé, cache de clip chaud | 0,143 | 1,415 | 0,089–1,415 | 0,382 | 10 |
| Révélation des Canvas préparés, 390×844 | 19,1 | 21,9 | 13,9–21,9 | 3,133 | 10 |

Le gain CPU est de plusieurs ordres de grandeur, très supérieur au bruit. Ce ratio ne représente **pas** le gain de navigation complet. Le premier contrôle de contenu du clip, la création WebGL et le réseau sont volontairement distincts de cette mesure chaude.

Contrôles exécutés : **499 tests unitaires / 62 fichiers**, lint et build ; **11 E2E cadrage/préparation**, **27 E2E shell mobile/contrastes**. Aucun seuil géométrique supprimé. Le test historique de fondu initial a été aligné sur le comportement déjà livré : aucun fade-in au montage, évaluation immédiate du mixer, cross-fade toujours vérifié au changement d'animation.

## 4. Constats

### BENCH-01 — calcul dominant retiré de l'ouverture

- **Sévérité initiale** : Majeur · **Effort** : M · **Confiance** : haute pour le CPU local.
- **Preuve** : JSON, `cpuBenchmark` ; frontend `scripts/benchmark-thumbnail-envelopes.mjs`.
- **Impact corrigé** : des centaines de poses skinnées par montage bloquaient le thread principal pendant plusieurs secondes.
- **Correction vérifiée** : catalogue indexé par SHA de la source vérifiée et contenu complet du clip, transformation/union bornée ; fallback exact si la source ou le clip n'est pas reconnu.

### BENCH-02 — première ouverture anticipée et iPhone non qualifiés

- **Sévérité résiduelle** : Majeur pour l'exigence de 20 ms à froid · **Effort** : M · **Confiance** : haute sur la limite observée, non mesurée sur iPhone.
- **Preuve** : JSON, `browser.earlyOpeningWithoutPreparation` et `limitations` ; E2E `mesure navigation vers les premières miniatures réellement soumises`.
- **Impact** : un accès immédiat avant préparation peut encore attendre les modules, les données et WebGL. Les miniatures nouvellement découvertes au scroll ne sont pas toutes précréées : le budget de deux scènes reste strict.
- **Direction** : recette iPhone réelle à froid/chaud, scroll et retour de profil ; ne pas annoncer une garantie générale de 20 ms à partir du seul calcul CPU.
- **Dépendances** : T13 ; aucun autre gate humain n'est levé.

## 5. Coûts et limites

- Préparation de deux petites scènes après l'interactivité de la carte ; buffers et contextes conservés, frameloops suspendues hors route ; purge avec la session utilisateur. Surcoût mémoire/GPU et chauffe non quantifiés.
- 155 noms de modèles couverts, 124 contenus SHA distincts. Quatre accessoires texturés Soccer/Victreebel restent sur la voie FBX/runtime sûre.
- Environ 36 Ko gzip de données supplémentaires dans le module AvatarCanvas ; pas de nouvelle dépendance ni endpoint d'écriture.
- Le catalogue est à régénérer lors d'une évolution des assets/Idle ; une divergence de source ou clip refuse sa réutilisation.
- Pas de benchmark 40 cycles, pas de YOLO réel, aucun lancement de stack latence L ; gates H04/H05/H08/T13/T10 inchangés.

## 6. Reproduire

Depuis `beercall-frontend`, avec Node 24 et le backend local disponible :

```powershell
node scripts/prepare-thumbnail-envelopes.mjs ../beercall-backend/static/models
node scripts/benchmark-thumbnail-envelopes.mjs ../beercall-backend/static/models result.json
npx vitest run
npm run lint
npm run build
```

Sur la stack C isolée, frontend construit à jour, depuis `beercall-app/e2e` :

```powershell
$env:BEERCALL_WORKSPACE_BACKEND='C:\Users\Migz3rrr\Delivery\BeerCall\beercall-backend'
$env:BEERCALL_PREPARED_THUMBNAILS='1'
npx playwright test tests/ux-avatar-framing.spec.ts --project=ux --max-failures=1
npx playwright test tests/ux-mobile-shell.spec.ts tests/ux-contrast.spec.ts --project=ux --max-failures=1
```

Sans `BEERCALL_PREPARED_THUMBNAILS`, le harnais conserve la voie FBX historique. La recette physique iPhone reste à effectuer sur le build LAN.
