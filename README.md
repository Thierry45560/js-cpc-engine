Voici une proposition de **README.md** complet, professionnel et percutant pour ton dépôt GitHub. Il est conçu pour mettre en valeur la technicité de ton travail (précision ZEXALL + performance WebGPU).

---

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

```javascript
import { Emulator_Core } from './src/core/system/Emulator_Core.js';
import { WebGPU_Renderer } from './src/adapters/graphics/WebGPURenderer.js';

const config = {
    model: "CPC6128", // ou "GX4000"
    renderer: new WebGPU_Renderer(canvas)
};

const cpc = new Emulator_Core(config);
cpc.powerOn();

// Charger un fichier .DSK ou .CPR
cpc.loadMedia(fileData);
```

---

## 🌐 Démo en ligne
Retrouvez l'implémentation complète avec interface utilisateur sur :
👉 [**www.js-cpc.fr**](https://www.js-cpc.fr)

---

## 📜 Licence
Ce projet est sous licence MIT. Vous pouvez librement réutiliser les modules CPU ou Son pour vos propres projets.

---

### Pourquoi utiliser JS-CPC ?
Si vous développez un outil de debug, un nouveau jeu CPC, ou si vous voulez simplement intégrer un émulateur performant dans une application web sans les contraintes de WebAssembly ou du C++ natif, **JS-CPC** est la solution la plus souple et la plus puissante disponible actuellement.

---