# JS-CPC Engine 🚀
### High-Performance Amstrad CPC / CPC+ / GX4000 Emulator Core

**JS-CPC** est un moteur d'émulation ultra-performant écrit en JavaScript moderne. Contrairement aux idées reçues sur le JavaScript, ce moteur rivalise avec des implémentations natives grâce à une architecture optimisée et l'utilisation de **WebGPU**.

Il est conçu pour être **totalement modulaire** : chaque composant (CPU Z80, puce sonore AY, contrôleur vidéo) peut être extrait et réutilisé dans d'autres projets de rétro-computing.

---

## 🔥 Points Forts

### 🚀 Performance & Accessibilité (JS vs C++)
*   **Vitesse brute :** La démo mythique *Batman Forever* tourne à plus de **400 FPS**, prouvant l'efficacité de l'interprétation et du rendu.
*   **Flexibilité totale :** Contrairement au C++, aucun pipeline de compilation complexe (Make, CMake, etc.) n'est requis. Le code est immédiatement lisible, testable et modifiable dans n'importe quel navigateur.
*   **Optimisation JIT :** Le code est écrit pour favoriser les optimisations des moteurs JS modernes (V8, SpiderMonkey), offrant une fluidité exceptionnelle sans la lourdeur de la gestion manuelle de la mémoire.

### 🎯 Précision Chirurgicale
*   **ZEXALL Ready :** Le cœur du processeur **Z80** a passé avec succès l'intégralité des tests de conformité **ZEXALL**, garantissant une émulation parfaite de chaque instruction, flag et comportement documenté (ou non).
*   **Cycle-Accurate :** Une attention particulière a été portée aux timings pour assurer la compatibilité avec les démos les plus exigeantes du CPC+.

### 🏗️ Architecture Modulaire
Le projet est construit comme un ensemble de briques indépendantes :
*   **Z80.js :** Un processeur Z80 complet et autonome.
*   **AY38910.js :** Une puce sonore fidèle, utilisable pour n'importe quel projet d'émulation (MSX, Spectrum, Arcade).
*   **FDC_Controller.js :** Un contrôleur de disquette (NEC µPD765) robuste.
*   **WebGPU Renderer :** Un backend graphique moderne pour une latence minimale.

---

## 🛠️ Spécifications Techniques

| Composant | Détails de l'émulation |
| :--- | :--- |
| **CPU** | Zilog Z80 (ZEXALL Passed) |
| **Vidéo** | Gate Array, ASIC (CPC+), CRTC (tous types émulés), rendu WebGPU / Canvas 2D |
| **Audio** | AY-3-8910 (WebAudio API) |
| **Périphériques** | PPI 8255, FDC (Floppy), Clavier, Joystick |
| **Formats** | .DSK, .SNA, .CPR (Cartouches GX4000), .TAP |

---

## 📂 Structure du Projet

Le cœur de l'émulateur se trouve dans le dossier `/src` :

```text
/src
├── core/
│   ├── cpu/          # Le cœur Z80 (Zexall validated)
│   ├── audio/        # Émulation sonore AY-3-8910
│   ├── video/        # ASIC, GateArray, CRTC, Display
│   ├── memory/       # Gestion de la RAM/ROM et Banking
│   ├── peripherals/  # FDC (Disquettes), Tape, Clavier, Snapshots
│   └── system/       # Bus système et orchestrateur (Emulator_Core)
├── adapters/         # Ponts vers les APIs Web (WebGPU, WebAudio, DOM)
└── tools/            # Utilitaires (Parsing de fichiers, formats)
```

---

## 🚀 Utilisation Rapide

Le moteur est conçu pour être facilement intégré. Voici un exemple minimaliste :

# Intégration — Exemple minimaliste fonctionnel

Le moteur n'expose **pas** d'API de classe importable.  
Il fonctionne sur un modèle de **singletons globaux** chargés séquentiellement via `loader.js`, puis initialisés dans `Emulator_Setup.js`.

---

## 1. Structure HTML minimale requise

```html
<!DOCTYPE html>
<html>
<head>
  <!-- jQuery (dépendance obligatoire) -->
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
</head>
<body>

  <!-- Canvas principal — requis par Video_Hardware.init() -->
  <canvas id="screen"></canvas>

  <!-- Élément de statut — requis par Emulator_Core (statusElement) -->
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

  <!-- Chargement séquentiel de tous les modules -->
  <script src="js/core/system/loader.js"></script>

</body>
</html>
```

> **Pourquoi `loader.js` et pas des `import` ?**  
> Les 30 modules du moteur partagent des singletons globaux (`CPU_Z80`, `Config_Manager`,
> `Audio_Output`…). Ils doivent être exécutés dans un ordre strict de dépendances.
> `loader.js` garantit cet ordre en injectant des balises `<script async=false>`
> séquentiellement.

---

## 2. Démarrage — CPC 6128 en ROM seule

`Emulator_Setup.js` (chargé en dernier par `loader.js`) appelle automatiquement
`AppMain.reset()` et `AppMain.loadInitialRoms()` dans le `$(document).ready`.  
Il n'y a **rien d'autre à écrire** pour obtenir le prompt BASIC du CPC.

```
> Prêt à l'emploi dès que les fichiers ROM/ sont présents.
```

---

## 3. Charger un fichier DSK ou SNA depuis JavaScript

Une fois `hardReset()` effectué, vous pouvez injecter un média via les parseurs intégrés :

```javascript
// Récupérer un fichier binaire (DSK, SNA, CPR…)
var xhr = new XMLHttpRequest();
xhr.open('GET', '/DSK/monJeu.dsk', true);
xhr.responseType = 'arraybuffer';

xhr.onload = function () {
    if (xhr.status !== 200 && xhr.status !== 0) return;
    var data = new Uint8Array(xhr.response);

    // ── Option A : Disquette .DSK → Lecteur A ──────────────────
    Floppy_Drive_A.diskImage = DSK_Parser.parseFile(data);

    // AutoRun : taper la commande au clavier virtuel
    // (attend ~2 s que le BASIC affiche le prompt)
    setTimeout(function () {
        AutoType.inject('RUN"monJeu.bas\r');
    }, 2000);

    // ── Option B : Snapshot .SNA ────────────────────────────────
    // SNA_Parser.parseFile(data);
    // Emulator_Core.resumeEmulator();

    // ── Option C : Cartouche CPC+ .CPR ─────────────────────────
    // window.files        = window.files || {};
    // window.files['AUTOLOAD/jeu.cpr'] = data;
    // window.currentCprPath             = 'AUTOLOAD/jeu.cpr';
    // Emulator_Core.hardReset();   // relance avec la cartouche
};

xhr.send();
```

---

## 4. Contrôler l'émulateur

```javascript
// Pause / Reprise
Emulator_Core.pauseEmulator();
Emulator_Core.resumeEmulator();

// Reset matériel complet
// (relit #snapshot pour choisir le modèle de machine)
Emulator_Core.hardReset();

// Mode turbo (×20 de vitesse, audio désactivé automatiquement)
Config_Manager.turboMode = true;
// puis relancer la boucle :
Emulator_Core.pauseEmulator();
Emulator_Core.resumeEmulator();
// ou utiliser toggleTurbo() si le moteur tourne déjà :
toggleTurbo();

// Volume (0–100)
Config_Manager.setVolume(80);
```

---

## 5. Son — activation obligatoire via geste utilisateur

Les navigateurs bloquent l'audio sans interaction préalable.  
Appelez `Audio_Output.Resume()` depuis un gestionnaire de clic :

```javascript
document.getElementById('monBoutonPlay').addEventListener('click', async function () {
    await Audio_Output.Resume();     // crée et déverrouille l'AudioContext
    Emulator_Core.resumeEmulator();  // lance la boucle d'émulation
});
```

---

## 6. Arborescence ROM/ requise

```
ROM/
├── english/
│   ├── 6128.ROM       ← firmware OS CPC 6128
│   └── BASIC1-1.ROM   ← BASIC Locomotive 1.1
├── french/
│   └── ...
├── spanish/
│   └── ...
└── AMSDOS_0.5.ROM     ← DOS disquette (commun à tous les modèles)
```

Les ROMs sont chargées automatiquement par `ROM_Manager.loadROMs()` au démarrage.  
La langue est lue dans le cookie `firmware` (`english` par défaut).
```

---

## 🌐 Démo en ligne
Retrouvez l'implémentation complète avec interface utilisateur sur :
👉 [www.js-cpc.fr](https://www.js-cpc.fr)

---

## 📜 Licence
Ce projet est sous licence MIT. Vous pouvez librement réutiliser les modules CPU ou Son pour vos propres projets.

---

### Pourquoi utiliser JS-CPC ?
Si vous développez un outil de debug, un nouveau jeu CPC, ou si vous voulez simplement intégrer un émulateur performant dans une application web sans les contraintes de WebAssembly ou du C++ natif, **JS-CPC** est la solution la plus souple et la plus puissante disponible actuellement.

---
