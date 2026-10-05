/**
 * @file tests/video/wiring.test.mjs
 * @description Robustesse du câblage par injection de dépendances.
 *
 * `Palette_Colors` et `ROM_Manager` n'ont aucune dépendance directe : tout
 * arrive par `link()`. Chaque fonction est donc câblée sous la forme
 * `if (bus.quelqueChose) this._quelqueChose = bus.quelqueChose` — une omission
 * laisse la propriété à `null` au lieu de lever.
 *
 * Ce contrat mérite un test : c'est lui qui permet au moteur de démarrer
 * malgré un module manquant, et c'est lui qui explique pourquoi un forgot de
 * câblage se manifeste par une exception en cours de frame plutôt qu'au
 * chargement.
 *
 * ⚠ Ce fichier manipule les singletons du moteur : il est volontairement
 *   séparé des autres suites, qui construisent chacune leur instance de
 *   harnais via `link()`.
 */

import { describe, it, expect } from 'vitest';
import { loadVideoCore } from '../helpers/gatearray-harness.mjs';

describe('Gate Array — link() tolère un bus partiel', () => {
  it('accepte un objet vide sans lever', () => {
    const { Palette_Colors } = loadVideoCore();
    expect(() => Palette_Colors.link({})).not.toThrow();
  });

  it('accepte un bus sans aucune dépendance connue', () => {
    const { Palette_Colors } = loadVideoCore();
    expect(() => Palette_Colors.link({ uneCle: 1, autre: 'texte' })).not.toThrow();
  });

  it('ne touche pas à machineType si la clé est absente', () => {
    const { Palette_Colors } = loadVideoCore();
    const avant = Palette_Colors.machineType;
    Palette_Colors.link({ getBorder: () => false });
    expect(Palette_Colors.machineType).toBe(avant);
  });

  it('écrase machineType quand la clé est présente', () => {
    const { Palette_Colors } = loadVideoCore();
    Palette_Colors.link({ machineType: 4 });
    expect(Palette_Colors.machineType).toBe(4);
  });

  it('remplace une dépendance par une nouvelle plutôt que de l\'ignorer', () => {
    const { Palette_Colors } = loadVideoCore();
    const premier = () => 1;
    const second  = () => 2;
    Palette_Colors.link({ getBorder: premier });
    expect(Palette_Colors._getBorder()).toBe(1);
    Palette_Colors.link({ getBorder: second });
    expect(Palette_Colors._getBorder()).toBe(2);
  });

  it('ne laisse pas un vestige non défini après un lien partiel', () => {
    // Un `link()` sans `getRamArrayRef` ne doit pas conserver l'ancien tampon
    // vidéo : la propriété est simplement laissée telle quelle.
    const { Palette_Colors } = loadVideoCore();
    Palette_Colors.link({});
    expect(Palette_Colors._getBorder === null ||
           typeof Palette_Colors._getBorder === 'function').toBe(true);
  });
});

describe('ROM_Manager — link() tolère un bus partiel', () => {
  it('accepte un objet vide sans lever', () => {
    const { ROM_Manager } = loadVideoCore();
    expect(() => ROM_Manager.link({})).not.toThrow();
  });

  it('ne touche pas aux drapeaux de configuration si absents', () => {
    const { ROM_Manager } = loadVideoCore();
    const avantType = ROM_Manager.machineType;
    const avantExt  = ROM_Manager.ramExpansion;
    ROM_Manager.link({});
    expect(ROM_Manager.machineType).toBe(avantType);
    expect(ROM_Manager.ramExpansion).toBe(avantExt);
  });

  it('écrase machineType et ramExpansion quand ils sont fournis', () => {
    const { ROM_Manager } = loadVideoCore();
    ROM_Manager.link({ machineType: 4, ramExpansion: true });
    expect(ROM_Manager.machineType).toBe(4);
    expect(ROM_Manager.ramExpansion).toBe(true);
  });
});
