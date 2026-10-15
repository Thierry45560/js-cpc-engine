# JS-CPC Engine 🚀
### High-Performance Amstrad CPC / CPC+ / GX4000 Emulator Core

**JS-CPC** est un moteur d'émulation ultra-performant écrit en JavaScript moderne. Contrairement aux idées reçues sur le JavaScript, ce moteur rivalise avec des implémentations natives grâce à une architecture optimisée et l'utilisation de **WebGPU**.

Il est conçu pour être **totalement modulaire** : chaque composant (CPU Z80, puce sonore AY, contrôleur vidéo) peut être extrait et réutilisé dans d'autres projets de rétro-computing.

---

## 🔥 Points Forts

### 🚀 Performance & Accessibilité

- **Vitesse brute :** La démo mythique *Batman Forever* tourne à plus de **400 FPS**, prouvant l'efficacité de l'interprétation et du rendu.
- **Flexibilité totale :** Contrairement au C++, aucun pipeline de compilation complexe (Make, CMake, etc.) n'est requis. Le code est immédiatement lisible, testable et modifiable dans n'importe quel navigateur.
- **Optimisation JIT :** Le code est écrit pour favoriser les optimisations des moteurs JS modernes (V8, SpiderMonkey), offrant une fluidité exceptionnelle sans la lourdeur de la gestion manuelle de la mémoire.

### 🎯 Précision Chirurgicale

- **ZEXALL Ready :** Le cœur du processeur **Z80** a passé avec succès l'intégralité des tests de conformité **ZEXALL**, garantissant une émulation parfaite de chaque instruction, flag et comportement documenté (ou non).
- **Timings pilotés au cycle interne :** Le décompte des T-states suit un modèle de « cycles internes » propre au moteur (suffisant pour piloter le CRTC et l'affichage), et non une reproduction cycle par cycle de la durée matérielle du Z80. La conformité *sémantique* est, elle, certifiée par ZEXALL.

### 🏗️ Architecture Modulaire

Le projet est construit comme un ensemble de briques indépendantes :

- **Z80.js :** Un processeur Z80 complet et autonome.
- **AY38910.js :** Une puce sonore fidèle, utilisable pour n'importe quel projet d'émulation (MSX, Spectrum, Arcade).
- **FDC_Controller.js :** Un contrôleur de disquette (NEC µPD765) robuste.
- **WebGPU Renderer :** Un backend graphique moderne pour une latence minimale.

---

## 🛠️ Spécifications Techniques

| Composant | Détails de l'émulation |
| :--- | :--- |
| **CPU** | Zilog Z80 (ZEXALL 67/67 — conformité sémantique) |
| **Vidéo** | Gate Array, ASIC (CPC+), CRTC (tous types émulés), rendu WebGPU / Canvas 2D |
| **Audio** | AY-3-8910 (WebAudio API) |
| **Périphériques** | PPI 8255, FDC (Floppy), Clavier, Joystick |
| **Formats** | `.DSK`, `.SNA`, `.CPR` (Cartouches GX4000), `.TAP` |

---

## 📂 Structure du Projet

Le moteur vit dans `SRC/`, à la racine du dépôt :

```text
SRC/
├── core/
│   ├── cpu/          # Le cœur Z80 (Zexall validated)
│   ├── audio/        # Émulation sonore AY-3-8910
│   ├── video/        # ASIC, GateArray, CRTC, Display
│   ├── memory/       # Gestion de la RAM/ROM et Banking
│   ├── peripherals/  # FDC (Disquettes), Tape, Clavier, Snapshots
│   └── system/       # Bus système et orchestrateur (Emulator_Core)
├── adapters/         # Ponts vers les APIs Web (WebGPU, WebAudio, DOM)
└── tools/            # Utilitaires (parsing de fichiers, formats)
```

`SRC/` est la seule copie éditée à la main. Les pages du site chargent leurs
scripts par des chemins relatifs (`js/core/cpu/Z80.js`) : elles consomment donc
un miroir `site/js/`, régénéré depuis `SRC/`. `npm run sync:site` l'écrit,
`npm run check:site` vérifie que les deux copies sont identiques — c'est le
contrôle à passer avant tout transfert chez l'hébergeur.

Le dossier `site/` — pages HTML, styles, bibliothèques tierces, ROM et données
de jeux — **n'est pas versionné ici** : il est transféré sur [www.js-cpc.fr](https://www.js-cpc.fr),
le moteur ci-dessus restant la source publiée.

---

## 🚀 Utilisation Rapide

Le moteur fonctionne sur un modèle de **singletons globaux** chargés séquentiellement par des balises `<script>` déclarées dans l'ordre strict des dépendances. Il n'expose **pas** d'API de classe importable — chaque module s'enregistre dans le scope global. Le fichier `examples/cpc-minimal.html` donne la liste de référence.

### 1. Structure HTML minimale

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Aucune dépendance JavaScript : le DOM utilise les API natives
       (querySelector, addEventListener, classList, Web Animations API). -->
</head>
<body>

  <!-- Canvas principal — requis par Video_Hardware.init() -->
  <canvas id="screen"></canvas>

  <!-- Élément de statut — requis par Emulator_Core -->
  <span id="status">Chargement...</span>

  <!-- LEDs lecteurs — requis par Emulator_Setup.js -->
  <span id="drivea-led"></span>
  <span id="driveb-led"></span>

  <!-- Compteur cassette — requis par Emulator_Setup.js -->
  <span id="tape-counter"></span>

  <!-- Sélecteur de machine — requis par Emulator_Core.hardReset() -->
  <select id="snapshot">
    <option value="boot_cpc6128" selected>CPC 6128</option>
    <option value="boot_cpc464">CPC 464</option>
    <option value="boot_6128plus">GX4000 / CPC 6128+</option>
  </select>

  <!-- Chargement séquentiel de tous les modules : reprendre la liste ordonnée
       de <script src> de examples/cpc-minimal.html -->

</body>
</html>
```

> **Pourquoi des `<script>` et pas des `import` ?**
> Les 30 modules du moteur partagent des singletons globaux (`CPU_Z80`, `Config_Manager`, `Audio_Output`…).
> Ils doivent être exécutés dans un ordre strict de dépendances, que l'ordre des balises `<script>` garantit.

`Emulator_Setup.js` (chargé en dernier) appelle automatiquement `AppMain.reset()` et
`AppMain.loadInitialRoms()` dès que le DOM est prêt. Il n'y a **rien d'autre à écrire** pour obtenir
le prompt BASIC du CPC, dès que les fichiers `ROM/` sont présents.

---

### 2. Charger un fichier DSK, SNA ou CPR

Une fois `hardReset()` effectué, injectez un média via les parseurs intégrés :

```javascript
var xhr = new XMLHttpRequest();
xhr.open('GET', '/DSK/monJeu.dsk', true);
xhr.responseType = 'arraybuffer';

xhr.onload = function () {
    if (xhr.status !== 200 && xhr.status !== 0) return;
    var data = new Uint8Array(xhr.response);

    // Option A — Disquette .DSK → Lecteur A
    Floppy_Drive_A.diskImage = DSK_Parser.parseFile(data);
    setTimeout(function () {
        // L'injection elle-même avance ensuite sur les frames/VBL émulées.
        CPC_INPUT.keyboard.autotype('RUN"monJeu.bas\r');
    }, 2000); // délai de démarrage, pas le timing de frappe

    // Option B — Snapshot .SNA
    // SNA_Parser.parseFile(data);
    // Emulator_Core.resumeEmulator();

    // Option C — Cartouche CPC+ .CPR
    // window.files = window.files || {};
    // window.files['AUTOLOAD/jeu.cpr'] = data;
    // window.currentCprPath             = 'AUTOLOAD/jeu.cpr';
    // Emulator_Core.hardReset();
};

xhr.send();
```

---

### 3. Contrôler l'émulateur

```javascript
// Pause / Reprise
Emulator_Core.pauseEmulator();
Emulator_Core.resumeEmulator();

// Reset matériel complet (relit #snapshot pour choisir le modèle)
Emulator_Core.hardReset();

// Mode turbo (×20 de vitesse, audio désactivé automatiquement)
toggleTurbo();

// Volume (0–100)
Config_Manager.setVolume(80);
```

---

### 4. Son — démarré au premier geste, sans rien manipuler

Les navigateurs interdisent de créer un `AudioContext` sans interaction
préalable : un contexte ouvert au chargement reste `suspended` et ne produit
rien. Les pages de l'émulateur n'ont rien à faire — `UI_Manager.bindSoundButton()`
(appelé par `Emulator_Setup.js`) arme `bindAudioResume()` dès que le son est
actif, et le contexte naît donc au PREMIER geste (clic, touche), sans passer par
le bouton son. Ce n'était pas le cas auparavant : la page restait muette, icône
« son actif » comprise, jusqu'à ce que l'utilisateur coupe puis réactive le son.
Verrouillé par `tests/browser/audio-son-chromium.spec.mjs`.

Sur une page qui n'utilise pas `bindSoundButton()`, armez l'écouteur vous-même :

```javascript
UI_Manager.bindAudioResume('pointerdown keydown');   // un seul geste, puis l'écouteur se retire
```

Ou appelez `Audio_Output.Resume()` depuis votre propre gestionnaire de geste :

```javascript
document.getElementById('monBoutonPlay').addEventListener('click', async function () {
    await Audio_Output.Resume();     // crée et déverrouille l'AudioContext
    Emulator_Core.resumeEmulator();  // lance la boucle d'émulation
});
```

Les appels concurrents sont sans danger : `Audio_Output.init()` est idempotent
(verrou `_initPromise`), un second appel renvoie la promesse en cours au lieu de
créer un second `AudioContext`.

---

### 5. Arborescence ROM/ requise

```
ROM/
├── english/
│   ├── 6128.ROM        ← firmware OS CPC 6128
│   └── BASIC1-1.ROM    ← BASIC Locomotive 1.1
├── french/
│   └── ...
├── spanish/
│   └── ...
└── AMSDOS_0.5.ROM      ← DOS disquette (commun à tous les modèles)
```

La langue est lue dans le cookie `firmware` (`english` par défaut). Les ROMs sont chargées automatiquement par `ROM_Manager.loadROMs()` au démarrage. **Changer de firmware depuis la fenêtre de configuration purge le cache des ROM et recharge la page automatiquement** : le firmware injecte du code et modifie l'état global de dizaines d'objets, que rejouer à chaud laissait incohérent — il ne restait donc qu'à reconstruire le contexte JavaScript. Le cookie est écrit AVANT le rechargement, sans quoi la page repartirait sur le firmware précédent. Verrouillé par `tests/system/config-rom.test.mjs`.

---

## 🛠️ Usage Node.js — Sans navigateur

Pour des usages hors navigateur (catalogage, outils CLI, tests), les parseurs peuvent être extraits indépendamment du moteur : aucune ROM, aucun audio, aucun canvas n'est requis pour lire une disquette `.DSK` ou un snapshot `.SNA`.

Ces modules sont des **scripts classiques** (`SRC/core/peripherals/DSK_Parser.js` déclare `DSK_Parser` dans le scope global, sans `export`) : ils ne s'importent pas, ils s'évaluent. `tests/helpers/z80-harness.mjs` montre la technique — lecture du fichier puis `vm.runInThisContext` avec un `filename`, ce qui évite toute transformation du code et laisse la couverture attribuée au bon fichier.

---

## ✅ Tests

Ce dépôt publie les suites du **cœur Z80** et de **ZEXALL** : `tests/z80/`,
leurs harnais (`z80-harness.mjs`, `z80-reference.mjs`, `zexall-runner.mjs`) et la
fixture `tests/fixtures/zexall.com`. Ce sont les suites qui accompagnent le
moteur.

```bash
npm install
npm run test:zexall   # conformité Z80 complète (~4 min, opt-in)
```

### ZEXALL — conformité du cœur Z80

[ZEXALL](https://github.com/agn453/ZEXALL) est **la** référence de conformité du cœur Z80 : 67 tests couvrant l'intégralité des opcodes, des drapeaux et des comportements documentés (ou non) par le constructeur. Le binaire `tests/fixtures/zexall.com` est embarqué, et son SHA-256 est vérifié au chargement.

ZEXALL est **opt-in** et volontairement absent de `npm test` : il exécute ~5,7 milliards d'instructions et prend environ 4 minutes.

```bash
npm run test:zexall
```

Le run en cours de référence : **67/67, 0 erreur, 5 764 195 500 instructions, 14 116 426 828 T-states.**

Ces compteurs sont **identiques** avant et après le correctif des opcodes `ED` non documentés : la modification n'altère rien de ce que ZEXALL mesure.

Note : ZEXALL contrôle la *sémantique* (registres, drapeaux, mémoire), pas la *durée*. Le comptage des T-states suit un modèle de cycles internes propre au moteur — voir « Précision Chirurgicale » plus haut.

---

## 🌐 Démo en ligne

Retrouvez l'implémentation complète avec interface utilisateur sur :

👉 [www.js-cpc.fr](https://www.js-cpc.fr)

---

## 📜 Licence

Ce projet est sous licence **MIT**. Vous pouvez librement réutiliser les modules CPU ou Son pour vos propres projets.

---

> **Pourquoi utiliser JS-CPC ?**
> Si vous développez un outil de debug, un nouveau jeu CPC, ou si vous voulez intégrer un émulateur performant
> dans une application web sans les contraintes de WebAssembly ou du C++ natif, **JS-CPC** est la solution
> la plus souple et la plus puissante disponible actuellement.
