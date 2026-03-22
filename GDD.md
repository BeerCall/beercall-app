# 🍻 GAME DESIGN DOCUMENT (GDD) : BEER CALL

## 1. CONCEPT & PITCH
**Pitch :** Beer Call est une application sociale et gamifiée "Anti-FOMO" (Fear Of Missing Out) pour groupes d'amis. Elle transforme chaque apéro en un mini-événement interactif.
**Promesse :** Savoir exactement qui boit quoi, où, et punir (avec humour) ceux qui esquivent ou "ghostent" l'appel de la bière, tout en récompensant les piliers de comptoir avec des cosmétiques pour leurs avatars.

---

## 2. CORE GAMEPLAY LOOP (La boucle principale)
1. **Appel (Trigger) :** Un utilisateur crée un apéro (photo + loc).
2. **Réponse (Action) :** Les membres de la Squad reçoivent la notif. Ils répondent "Présent" (photo à l'appui) ou "Absent" (message).
3. **Résolution (Feedback) :** L'algorithme valide la participation. Les avatars sont dispatchés dans les "3 Mondes" (Bar, Piscine, Dodo).
4. **Récompense (Progression) :** Les joueurs gagnent des *Capsules* (monnaie virtuelle) et débloquent des badges pour customiser leur avatar.

---

## 3. UI / UX & USER JOURNEY (Parcours Utilisateur)

### A. Onboarding
* **Splash Screen :** Logo Beer Call.
* **Page Login / Sign Up :** Création du compte et première étape de création de l'Avatar (style de base, coupe de cheveux, tenue par défaut).

### B. Le Dashboard (L'écran central)
La navigation est asymétrique et pensée pour une utilisation à une main :
* **Navbar (Bas de l'écran) :**
    * *Bouton Gauche :* **Connexions**. Ouvre une page listant tous les amis présents dans nos différentes Squads (statut en ligne, dernier apéro).
    * *Bouton Central :* **Mon Profil**.
    * *Bouton Droit :* **Sign Out** (Déconnexion rapide).
* **La Roulette "Squads" (Le Hub) :**
    * Située juste au-dessus du bouton central (Profil), c'est un demi-cercle rotatif (façon barillet ou cadran téléphonique).
    * On "swipe" le demi-cercle pour faire défiler les logos de ses Squads.
    * Aux extrémités du demi-cercle : un bouton `[+] Créer Squad` et une icône `[->] Rejoindre Squad` (via code ou lien).

### C. La Page Squad (Quand on clique sur une Squad via la roulette)
* **Vue Principale (Map) :** Une carte stylisée (façon Zenly/Snap Map) montrant les "Apéros" en cours ou passés.
* **Création Rapide :** En cliquant sur sa propre position sur la carte, le joueur ouvre la caméra, prend une photo, et crée un Apéro (un "Beer Call" est lancé).
* **Timeline des Apéros :** En bas de l'écran, un carrousel horizontal liste les apéros du plus récent (à gauche) au plus ancien (à droite).

### D. L'Interaction "Apéro" & Validation
Quand un joueur clique sur un Apéro (sur la map ou la timeline), un popup apparaît avec deux choix :
1. **"Je décline" :** Ouvre un champ texte pour laisser un mot d'excuse (ex: "Demain je bosse").
2. **"J'arrive / J'y suis" (Rejoindre) :** Ouvre l'appareil photo.
    * *Mécanique de validation (Backend) :* Le jeu vérifie la géolocalisation (est-il proche du créateur ?) ET une IA analyse la photo pour détecter un verre/une bouteille.
    * *Succès :* Le joueur est ajouté à l'apéro.

---

## 4. LES 3 MONDES (Le système de "Lobby" social)
C'est la "Killer Feature" visuelle de l'app. Une fois le timer de l'apéro écoulé (ou quand on consulte un apéro), on accède à un diorama représentant le statut de la Squad.

* **Monde 1 : Le Bar (Les Présents)**
    * *Visuel :* Une grande table de bar chaleureuse, éclairée, avec des chopes.
    * *Action :* Les avatars validés y sont assis. On peut cliquer dessus pour voir la photo qu'ils ont prise.
* **Monde 2 : La Piscine (Les Excusés)**
    * *Visuel :* Une piscine gonflable ou municipale, un peu ridicule.
    * *Action :* Les avatars de ceux qui ont cliqué sur "Je décline" flottent dans des bouées. Une bulle de BD affiche leur mot d'excuse.
* **Monde 3 : Le Dodo (Les Fantômes)**
    * *Visuel :* Un dortoir sombre, des lits superposés.
    * *Action :* Les avatars de ceux qui ont ignoré la notification dorment, avec des "Zzz" au-dessus de leur tête.

---

## 5. SYSTÈME DE PROGRESSION : RÉCOMPENSES ET ÉCONOMIE

L'économie du jeu repose sur une monnaie virtuelle : les **Capsules (Caps)**. Elles servent uniquement dans le *Shop Profil* pour acheter des vêtements et accessoires pour customiser son Avatar. 

### A. L'Économie Complète (Comment gagner des Capsules)

Le système récompense l'initiative, la réactivité et l'honnêteté.

**1. Actions de Base (Le Quotidien) :**
* Créer un Apéro validé par au moins 1 personne : **+50 Caps**
* Rejoindre un Apéro avec photo validée : **+30 Caps**
* Décliner "proprement" avec un message (assiduité sociale polie) : **+5 Caps**
* Fantôme (Le Dodo) : **0 Caps**

**2. Bonus de Comportement (Les Multiplicateurs) :**
* *Bonus "Flash"* : Répondre "J'y suis" et valider sa photo en moins de 2 minutes après la notification : **+15 Caps**.
* *Bonus "Explorateur"* : Créer un apéro dans un lieu (coordonnées GPS) inédit pour la Squad : **+20 Caps**.
* *Bonus "Streak" (Série)* : Être présent à 3 apéros de suite dans la même Squad : **+30 Caps**.
* *Bonus de Recrutement* : Ajouter un nouveau membre dans une Squad : **+100 Caps**.

**3. Malus (Anti-Triche) :**
* *Tentative de fraude* : L'IA détecte qu'il n'y a pas de boisson sur la photo (ou photo d'un écran) : **-15 Caps**.

---

### B. Le Grand Catalogue des Badges (Achievements)

Les badges n'offrent ni Capsules ni skins. Ce sont purement des trophées honorifiques (ou humoristiques) affichés sur le profil. Chaque badge possède un ID unique, un nom, une description et une icône associée.

**1. Les Badges de Participation (Les Piliers)**
* **ID:** `BAPTEME` | **Nom:** Le Baptême | **Description:** 1er apéro rejoint | **Icône:** 👼
* **ID:** `HABITUE` | **Nom:** L'Habitué | **Description:** 10 apéros rejoints | **Icône:** 🍻
* **ID:** `PILIER` | **Nom:** Le Pilier de Comptoir | **Description:** 50 apéros rejoints | **Icône:** 🗿
* **ID:** `LEGENDE` | **Nom:** La Légende | **Description:** 100 apéros rejoints | **Icône:** 👑

**2. Les Badges de Création (Les Leaders)**
* **ID:** `ETINCELLE` | **Nom:** L'Étincelle | **Description:** 1er apéro créé | **Icône:** ⚡
* **ID:** `RABATTEUR` | **Nom:** Le Rabatteur | **Description:** 10 apéros créés | **Icône:** 📢
* **ID:** `GENERAL` | **Nom:** Le Général de la Soif | **Description:** 5 apéros créés où TOUTE la squad est présente | **Icône:** 🎖️
* **ID:** `INFLUENCEUR` | **Nom:** L'Influenceur | **Description:** Créer un apéro qui rassemble plus de 10 personnes simultanément | **Icône:** 📱

**3. Les Badges de Timing & Vitesse (Les Sprinters)**
* **ID:** `LUCKY_LUKE` | **Nom:** Lucky Luke | **Description:** Valider sa présence à un apéro en moins de 30 secondes | **Icône:** ⏱️
* **ID:** `INCRUSTE` | **Nom:** L'Incruste | **Description:** A rejoint un apéro dans les 3 minutes suivant la notification | **Icône:** 🥷
* **ID:** `DECALE` | **Nom:** Le Décalé | **Description:** Lancer un appel à la bière à des heures improbables (ex: le matin) | **Icône:** 🦉

**4. Les Badges Géographiques (Les Routards)**
* **ID:** `LOCAL` | **Nom:** Le Local | **Description:** Valider 10 apéros aux mêmes coordonnées GPS | **Icône:** 🏠
* **ID:** `COLOMB` | **Nom:** Christophe Colomb | **Description:** Lancer un appel ou valider une présence à plus de 100km du reste de la Squad | **Icône:** 🧭
* **ID:** `MERCENAIRE` | **Nom:** Mercenaire | **Description:** Présent dans 3 Squads différentes | **Icône:** ⚔️

**5. Les Badges Troll & Wall of Shame (Les Relous)**
* **ID:** `NAGEUR` | **Nom:** Le Nageur Olympique | **Description:** A fini 5 fois de suite dans le Monde "Piscine" | **Icône:** 🛟
* **ID:** `MARMOTTE` | **Nom:** La Marmotte | **Description:** A fini 10 fois dans le "Dodo" | **Icône:** 💤
* **ID:** `CASANIER` | **Nom:** Le Casanier | **Description:** A décliné 5 apéros d'affilée en laissant un message | **Icône:** 🛋️
* **ID:** `FAUSSAIRE` | **Nom:** Le Faussaire | **Description:** S'est fait rejeter sa photo par l'IA 3 fois (triche avérée) | **Icône:** 🤥

---

## 6. DIRECTION ARTISTIQUE (D.A) & UI

**Ambiance Globale :** Fun, colorée, un peu "cartoonesque" et décalée. L'UX doit être ultra-fluide.

* **La Map :** Style isométrique coloré (type *Zenly* ou *Animal Crossing*). Le mode sombre (nuit) s'active automatiquement à partir de 19h.
* **Les Avatars (Les Mondes) :**
    * *Style :* **3D Low-Poly** ou **Voxel** (façon *Crossy Road* ou *Habbo Hotel* modernisé).
    * *Dioramas :* Les 3 Mondes (Bar, Piscine, Dodo) sont de petits dioramas 3D isométriques flottant sur un fond uni. On peut légèrement tourner la caméra avec le doigt.
* **Palette de couleurs :**
    * Ambre/Doré (la bière, la chaleur du Bar).
    * Bleu cyan (la Piscine, la froideur de l'excuse).
    * Violet foncé/Gris (Le Dodo, l'absence totale).