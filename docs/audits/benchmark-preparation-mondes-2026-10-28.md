# Benchmark — préparation anticipée des trois mondes

- **Date** : 2026-10-28.
- **Question** : anticiper les trois décors fixes sans créer trois Canvas ni lancer la logique de jeu ; réduire leur premier affichage après préparation tout en conservant les garanties existantes.
- **Référence** : frontend `e453ffa`, testé avant construction du nouveau build.
- **Correctifs frontend** : `5f9320d` (préparation et tests) et `13ead18` (intégration à la session et caches de la modale).
- **Environnement** : Windows 10, Intel i7-6500U, Chromium local 390×844, stack C isolée. L'utilisateur a validé la vitesse/cadrage des avatars sur iPhone et signalé environ 2 s au premier affichage des mondes, puis des retours instantanés.
- **Preuves** : [mesures brutes](benchmark-preparation-mondes-2026-10-28.json), `e2e/tests/ux-world-preparation.spec.ts` ; sorties complètes du runner conservées dans le répertoire temporaire OpenCode (`world-preparation-before-20261028.json` et `world-preparation-after-20261028.json`).

## 1. Verdict

Préparation anticipée des modules et des FBX/textures : **gain démontré sur le banc**, environ 40–64 % sur la médiane du premier affichage après préparation. Les trois décors sont réutilisés depuis le cache exact de `useFBX` et les mêmes queries de modules que la modale.

**Gain partiel, pas de promesse d'instantanéité générale.** Le Bar reste à environ 1,7 s sur ce banc après préparation ; les coûts résiduels de première scène n'ont pas été isolés individuellement. La qualification iPhone, GPU, chauffe et mémoire reste ouverte.

## 2. Protocole

- Trois nouveaux contextes navigateur par variante, sans autre benchmark lancé en parallèle. Ordre A/A/A puis B/B/B : dérive thermique/chronologique non neutralisée.
- Même viewport, mêmes véritables décors (`Bar.fbx` 4 567 372 octets, `Swimming_pool.fbx` 2 734 896, `Floaty_Island.fbx` 1 155 552), mêmes APIs simulées, mondes sans participants, même ordre Bar → Piscine → Dodo.
- A charge à l'ouverture ; B attend la résolution effective des trois lectures de modèles après interactivité de la carte, puis ouvre la modale. Le temps de préparation en arrière-plan n'est **pas** inclus dans le clic→frame et n'est pas du travail supprimé.
- Fin de mesure : `worldFrameSubmitted`, après progression du compteur de frames et draw calls positifs. Le Bar a 18 appels, la Piscine 1, le Dortoir 12 dans ces fixtures.
- Aucune requête de jeu pendant la préparation ; aucun Canvas de monde avant ouverture ; un seul ensuite ; exactement un GET par décor pour préparation + visites des trois onglets ; aucune mutation de jeu.

## 3. Résultats (ms)

| Monde | A médiane | B médiane | Gain | A plage | B plage |
|---|---:|---:|---:|---:|---:|
| Bar | 2837,8 | 1706,2 | 39,9 % | 2835,9–2902,0 | 1587,7–1787,6 |
| Piscine | 900,1 | 483,5 | 46,3 % | 864,6–937,7 | 478,0–518,3 |
| Dortoir | 507,7 | 182,2 | 64,1 % | 463,0–549,0 | 164,6–255,2 |

Les plages sont disjointes ; le gain observé dépasse la variation de ces trois répétitions. L'effectif reste trop faible pour qualifier un p95/p99 : au rang le plus proche, ils se confondraient avec le maximum et ne constituent pas une garantie.

## 4. Constats

### BENCH-01 — ressources statiques chargées à la demande

- **Sévérité initiale** : Majeur · **Effort** : M · **Confiance** : haute sur le gain local.
- **Preuve** : source de référence `SelectWorldModal.tsx`, chargement module actif ; chemins des trois `ModelPart` ; JSON avant/après.
- **Impact** : environ 8,46 Mo de sources FBX et leurs décodages étaient déclenchés au moment de la première visite.
- **Correction vérifiée** : préparation finie à trois ressources, séquencée avec des pauses, seulement sur la carte authentifiée/visible après `mapInteractive`. Aucun composant de monde n'est monté. Le cache de modules et celui de `useFBX` sont les mêmes au premier affichage.
- **Défaillance** : si une préparation échoue, son entrée `useFBX` est effacée pour permettre une tentative réelle ultérieure. Les deux autres préparations peuvent continuer. La modalité normale conserve ses erreurs/retry et ses critères de vraie frame prête.

### BENCH-02 — premier affichage du Bar encore perceptible

- **Sévérité résiduelle** : Majeur · **Effort** : M · **Confiance** : haute sur le délai, basse sur sa décomposition.
- **Preuve** : médiane B du Bar 1706,2 ms dans le JSON. Modules/modèles déjà résolus, aucun rechargement de décor lors de la visite.
- **Impact** : la préparation des ressources seule ne rend pas toute première ouverture instantanée.
- **Direction** : profiler séparément compilation/upload GPU, texte 3D, ombres et montage ; envisager une préparation GPU bornée dans un contexte réutilisable uniquement après mesure mémoire/thermique sur iPhone. Ne pas monter trois scènes actives pour masquer le problème.
- **Dépendances** : recette iPhone T13 ; H04/H05/H08/T10 non levés.

## 5. Points préservés et limites

- Pas de changement des trois rendus, des matériaux, participants, contrôles, lancement de partie, readiness ou seuils de tests existants.
- La modale seule reste selected-only : un test isolé de la modale ne précharge pas automatiquement les autres onglets. La préparation est un service séparé, après la carte ; aucune dépendance Three/Drei supplémentaire dans son import de démarrage.
- Pas de nouveau Canvas, animation GPU de fond, requête de partie, abonnements de jeu ou endpoint d'écriture pendant la préparation. Le CPU et la RAM du décodage anticipé existent toujours ; coûts non quantifiés sur iPhone.
- Vérifications : lint, types et build passent ; 25 tests ciblés mondes passent ; trois E2E A puis trois B passent ; six E2E navigation/carte/bannières et le contrôle de conservation des avatars passent. La suite complète donne 502/503 : une assertion de nombre d'appels dans `useChatViewport.test.ts` échoue pendant l'exécution concurrente, puis ses huit tests et les quatre tests de préparation passent au rejeu isolé (12/12). Même observation pour un timeout à 30 s du contrôle des avatars sous charge, passé en 18,7 s au rejeu au repos. Aucun seuil, timeout ni fichier de test chat modifié. La cause de ces intermittences n'est pas qualifiée ; la suite complète n'est pas annoncée verte.
- Les avatars des participants sont dynamiques : préparer trois décors ne prépare pas toutes les configurations possibles des utilisateurs. L'API des participants continue de se charger à l'ouverture.
- Les fixtures UX sans décors simulent explicitement une indisponibilité 503 des trois ressources optionnelles. Le test positif utilise les vrais FBX et exige leur réutilisation ; les URLs non reconnues restent refusées.
- Pas de stack L ni de boucle 40 cycles ; aucun push/merge/déploiement distant.

## 6. Reproduire

Frontend : `npx vitest run`, `npm run lint`, `npm run build`. Construire/copier le build correspondant dans la stack C isolée avant chaque variante.

Depuis `beercall-app/e2e` :

```powershell
$env:BEERCALL_WORKSPACE_BACKEND='C:\Users\Migz3rrr\Delivery\BeerCall\beercall-backend'
# A : ancien build, variable absente. B : build préparé et variable ci-dessous.
$env:BEERCALL_EXPECT_WORLD_WARMUP='1'
npx playwright test tests/ux-world-preparation.spec.ts --project=ux --repeat-each=3 --reporter=json --max-failures=1
```

La vérification sur l'iPhone LAN reste requise : rafraîchir le build, laisser la carte devenir interactive, ouvrir chacun des trois mondes une première fois puis revenir, et vérifier la réactivité de la carte pendant la préparation.
