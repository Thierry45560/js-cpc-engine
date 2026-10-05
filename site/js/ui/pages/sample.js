/**
 * @file        sample.js
 * @description Catalogue interactif JS CPC — Base de données des jeux,
 *              filtrage, tri, recherche, tooltips et lecture vidéo au survol.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — L'Amstrad dans votre Navigateur
 */

'use strict';

/* ── Année dynamique du footer ──────────────────────────────── */
document.getElementById('footer-year').textContent = new Date().getFullYear();

/* ─────────────────────────────────────────────────────────────
   REGISTRE DES VIGNETTES VIDÉO DISPONIBLES
   Seuls les fichiers listés ici déclenchent un <video>.
   ───────────────────────────────────────────────────────────── */
var VIDEOS_EXISTANTES = [
    'BARBARIAN2.CPR', 'BATMANM.CPR',  'BEARS.CPR',    
    'CAULDRON2.CPR',  'CHEVYCHASE.CPR','COPTER271.CPR','CRAZYCARS2.CPR',
    'DICKTRACY.CPR',  'ENFORCER.CPR', 'FAF2.CPR',     'GAMEOVER.CPR',
    'JARLAC.CPR',     'KLAX.CPR',     'KUNGFU.CPR',   'MONUMENT.CPR',
    'MYSTICAL.CPR',   'NAVYSEAL.CPR', 'NOEXIT.CPR',   'OPTHUND.CPR',
    'PANG.CPR',       'PANZA.CPR',    'PINBALL.CPR',  'PINGPONG.CPR',
    'PLOTTING.CPR',   'PUZZNIC.CPR',  'ROBOCOP2.CPR', 'STRIKER.CPR',
    'SWITCHBLD.CPR',  'TENNISC2.CPR', 'TINTIN.CPR',   'WOSPORTS.CPR',
    'WSTREETS.CPR',
    '1943.SNA',     'ARKANOID.SNA',  'BARBARIAN.DSK', 'BATMAN.DSK',
    'BATMAN.SNA',   'BOMBJACK.SNA',  'BOULDER.SNA',   'BRUCELEE.SNA',
    'BUBBLE.DSK',   'BUGGYBOY.SNA',  'CHASEHQ.SNA',   'CHUCKIE.DSK',
    'COMMANDO.SNA', 'CYBERNOI.SNA',  'DKONG.SNA',     'DRAGNINJ.SNA',
    'EXOLON.DSK',   'FRUITY.SNA',    'GNG.CPR',       'GNG.SNA',
    'GRYZOR.SNA',   'HOH.SNA',       'IKARI.SNA',     'LALD.SNA',
    'LEMMINGS.DSK', 'MATCHDAY2.DSK', 'NSOUTH_A.DSK',  'NSOUTH_B.DSK',
    'PHANTOMAS.CPR','POP.DSK',       'RAINBOW.DSK',   'RENEGADE.DSK',
    'RICK.SNA',     'RICKC.CPR',     'SAB2.DSK',      'SIMCITY.DSK',
    'SOLOMON.CPR',  'SORCERY.DSK',   'SORCERY1.DSK',  'SPINDIZZY.DSK',
    'TENNIS.CPR',   'TETRIS.DSK',    'TITANICB.CPR',  'TURRICAN.DSK',
    'YIEAR.CPR'
];

/* ─────────────────────────────────────────────────────────────
   BASE DE DONNÉES — Jeux et Démos
   type : "disc" | "snap" | "cart"
   cat  : "Action" | "Arcade" | "Platform" | "RPG" |
          "Puzzle" | "Sport" | "Demo" | "Strategie"
   ───────────────────────────────────────────────────────────── */
var GAMES = [
    // ── DISQUETTES DSK ───────────────────────────────────────
    { title:'Barbarian',         file:'BARBARIAN.DSK',  type:'disc', cat:'Action',    year:1987, icon:'fa-skull-crossbones',
      desc:'Combattez sans pitié dans ce jeu de duel en arène devenu légendaire pour sa violence. Tranchez des têtes, esquivez les attaques et terrassez le terrible sorcier Drax.' },
    { title:'Target: Renegade',  file:'RENEGADE.DSK',   type:'disc', cat:'Action',    year:1988, icon:'fa-hand-fist',
      desc:'Un beat\'em up légendaire où vous vengez votre frère assassiné. Parcourez les rues malfamées et affrontez des gangs armés dans des combats de rue mémorables.' },
    { title:'Turrican',          file:'TURRICAN.DSK',   type:'disc', cat:'Action',    year:1990, icon:'fa-gun',
      desc:'L\'un des plus grands jeux d\'action de l\'ère 8-bits. Explorez d\'immenses niveaux non linéaires armé jusqu\'aux dents et transformez-vous en gyroscope destructeur.' },
    { title:'Spindizzy',         file:'SPINDIZZY.DSK',  type:'disc', cat:'Puzzle',    year:1986, icon:'fa-map-pin',
      desc:'Prenez le contrôle d\'une toupie dans ce chef-d\'œuvre de la 3D isométrique. Explorez 386 écrans interconnectés en maîtrisant parfaitement l\'inertie de votre véhicule.' },
    { title:'Chuckie Egg',       file:'CHUCKIE.DSK',    type:'disc', cat:'Platform',  year:1984, icon:'fa-egg',
      desc:'Un classique intemporel de la plateforme frénétique. Incarnez Henhouse Harry, ramassez tous les œufs et évitez les oiseaux géants dans des niveaux de plus en plus rapides.' },
    { title:'Sorcery+',          file:'SORCERY.DSK',    type:'disc', cat:'RPG',       year:1985, icon:'fa-wand-sparkles',
      desc:'Incarnez un magicien volant dans ce sublime jeu d\'aventure. Délivrez vos confrères sorciers capturés par le Nécromancien en utilisant les bons objets au bon moment.' },
    { title:'Fantasy World Dizzy',file:'DIZZY.DSK',     type:'disc', cat:'Platform',  year:1989, icon:'fa-egg',
      desc:'Le meilleur épisode de la saga du célèbre œuf. Parcourez un monde fantastique, ramassez des pièces, résolvez des énigmes inventives et sauvez Daisy.' },
    { title:'Match Day II',      file:'MATCHDAY2.DSK',  type:'disc', cat:'Sport',     year:1987, icon:'fa-futbol',
      desc:'La simulation de football qui a marqué toute une génération. Un système de tir analogique novateur, des retournés acrobatiques et des matchs à la tension palpable.' },
    { title:'Lemmings',          file:'LEMMINGS.DSK',   type:'disc', cat:'Puzzle',    year:1992, icon:'fa-users',
      desc:'Sauvez ces petites créatures aux tendances suicidaires en leur attribuant des tâches (creuser, bloquer, construire). Un puzzle-game légendaire extrêmement addictif.' },
    { title:'Prince of Persia',  file:'POP.DSK',        type:'disc', cat:'Platform',  year:1990, icon:'fa-person-falling',
      desc:'Aventurez-vous dans les sombres cachots du Vizir pour sauver la princesse en moins d\'une heure. Des animations fluides révolutionnaires et des combats mortels.' },
    { title:'Tetris',            file:'TETRIS.DSK',     type:'disc', cat:'Puzzle',    year:1988, icon:'fa-border-none',
      desc:'L\'incontournable puzzle venu de Russie. Emboîtez les tétriminos qui tombent pour former des lignes complètes et éviter de remplir l\'écran.' },
    { title:'Bubble Bobble',     file:'BUBBLE.DSK',     type:'disc', cat:'Arcade',    year:1987, icon:'fa-soap',
      desc:'Contrôlez Bub et Bob, deux petits dragons cracheurs de bulles. Enfermez vos ennemis puis éclatez-les dans ce jeu d\'arcade frénétique, jouable à deux.' },
    { title:'Nebulus',           file:'NEBULUS.DSK',    type:'disc', cat:'Platform',  year:1987, icon:'fa-tower-observation',
      desc:'Aidez Pogo à détruire des tours construites sur la mer en atteignant leur sommet. Ce jeu se démarque par son impressionnant effet de rotation cylindrique simulant la 3D.' },
    { title:'Saboteur II',       file:'SAB2.DSK',       type:'disc', cat:'Action',    year:1987, icon:'fa-user-ninja',
      desc:'Incarnez une redoutable kunoichi dans cette suite très vaste. Infiltrez le centre de commandement ennemi, accomplissez votre mission et fuyez à moto.' },
    { title:'Sim City',          file:'SIMCITY.DSK',    type:'disc', cat:'Strategie', year:1990, icon:'fa-city',
      desc:'Le tout premier simulateur de construction de ville. Gérez les zones résidentielles, commerciales, les impôts et faites face aux catastrophes naturelles.' },
    { title:'Rainbow Islands',   file:'RAINBOW.DSK',    type:'disc', cat:'Platform',  year:1989, icon:'fa-rainbow',
      desc:'La suite fabuleuse de Bubble Bobble. Créez des arcs-en-ciel magiques pour grimper tout en haut des îles et emprisonner vos ennemis.' },
    { title:'Exolon',            file:'EXOLON.DSK',     type:'disc', cat:'Action',    year:1987, icon:'fa-user-astronaut',
      desc:'Progressez sur une planète extraterrestre avec votre fusil blaster et vos grenades. Un run & gun aux graphismes très colorés et aux explosions mémorables.' },
    { title:'Crafton & Xunk',    file:'CRAFTON.DSK',    type:'disc', cat:'Puzzle',    year:1986, icon:'fa-robot',
      desc:'Contrôlez un androïde et son fidèle pod dans cette merveille de science-fiction en 3D isométrique. Poussez des objets et résolvez des énigmes pour survivre.' },

    // ── SNAPSHOTS SNA ────────────────────────────────────────
    { title:'1943',              file:'1943.SNA',       type:'snap', cat:'Arcade',    year:1988, icon:'fa-plane',
      desc:'Prenez les commandes d\'un chasseur P-38 Lightning au-dessus de l\'océan Pacifique. Affrontez des flottes entières dans ce shoot \'em up frénétique.' },
    { title:'Arkanoid',          file:'ARKANOID.SNA',   type:'snap', cat:'Arcade',    year:1987, icon:'fa-table-tennis-paddle-ball',
      desc:'L\'un des meilleurs casse-briques de l\'histoire du jeu vidéo. Brisez les briques, ramassez les bonus et affrontez le redoutable boss DOH.' },
    { title:'Astro Marine Corps',file:'ASTROMAR.SNA',   type:'snap', cat:'Action',    year:1989, icon:'fa-user-astronaut',
      desc:'Incarnez un soldat d\'élite dans ce run & gun spatial espagnol. Affrontez d\'horribles créatures mutantes avec des animations fluides et détaillées.' },
    { title:'Batman',            file:'BATMAN.SNA',     type:'snap', cat:'Action',    year:1986, icon:'fa-mask',
      desc:'Explorez la Batcave en 3D isométrique pour retrouver les pièces de votre aéroglisseur. Un chef-d\'œuvre signé par le légendaire duo Ritman et Drummond.' },
    { title:'Bomb Jack',         file:'BOMBJACK.SNA',   type:'snap', cat:'Platform',  year:1986, icon:'fa-bomb',
      desc:'Contrôlez un super-héros capable de sauter à des hauteurs vertigineuses. Récupérez toutes les bombes allumées dans l\'ordre pour maximiser votre score.' },
    { title:'Boulder Dash',      file:'BOULDER.SNA',    type:'snap', cat:'Puzzle',    year:1984, icon:'fa-gem',
      desc:'Creusez la terre pour amasser un maximum de diamants tout en évitant les éboulements mortels. Un classique indémodable du puzzle-action.' },
    { title:'Bruce Lee',         file:'BRUCELEE.SNA',   type:'snap', cat:'Platform',  year:1984, icon:'fa-user-ninja',
      desc:'Un mélange parfait d\'action et de plateforme. Ramassez des lanternes et affrontez le Ninja et le Sumo vert pour atteindre les richesses du sorcier.' },
    { title:'Buggy Boy',         file:'BUGGYBOY.SNA',   type:'snap', cat:'Sport',     year:1988, icon:'fa-car-side',
      desc:'Pilotez un buggy à travers des parcours colorés remplis d\'obstacles. Roulez sur deux roues et passez entre les drapeaux pour faire exploser le chronomètre.' },
    { title:'Chase H.Q.',        file:'CHASEHQ.SNA',    type:'snap', cat:'Action',    year:1989, icon:'fa-car-burst',
      desc:'La course-poursuite policière par excellence. Foncez sur l\'autoroute et emboutissez la voiture des ravisseurs pour procéder à leur arrestation.' },
    { title:'Commando',          file:'COMMANDO.SNA',   type:'snap', cat:'Action',    year:1985, icon:'fa-gun',
      desc:'Lâché derrière les lignes ennemies, progressez seul contre tous avec votre mitrailleuse et vos grenades. Un run & gun vertical fondateur.' },
    { title:'Cybernoid',         file:'CYBERNOI.SNA',   type:'snap', cat:'Action',    year:1988, icon:'fa-space-shuttle',
      desc:'Pilotez un vaisseau de combat expérimental dans des écrans truffés de tourelles et de lasers. Équipez-vous d\'armes surpuissantes pour survivre.' },
    { title:'Donkey Kong',       file:'DKONG.SNA',      type:'snap', cat:'Arcade',    year:1986, icon:'fa-hammer',
      desc:'L\'adaptation du célèbre jeu d\'arcade de Nintendo. Incarnez Mario, grimpez aux échelles et sautez par-dessus les tonneaux pour sauver Pauline.' },
    { title:'Dragon Ninja',      file:'DRAGNINJ.SNA',   type:'snap', cat:'Action',    year:1989, icon:'fa-user-ninja',
      desc:'Traversez la ville pour sauver le Président kidnappé par un gang de ninjas. Un beat \'em up à l\'action très soutenue et aux superbes sprites.' },
    { title:'Fruity Frank',      file:'FRUITY.SNA',     type:'snap', cat:'Arcade',    year:1984, icon:'fa-apple-whole',
      desc:'Protégez votre verger en creusant des galeries et en lançant des pommes sur les monstres. Un jeu très populaire en France et extrêmement addictif.' },
    { title:'Ghosts \'n Goblins',file:'GNG.SNA',        type:'snap', cat:'Action',    year:1986, icon:'fa-skull',
      desc:'Menez le courageux chevalier Arthur à travers le cimetière et la forêt sombre. Un jeu d\'action-plateforme réputé pour sa difficulté diabolique.' },
    { title:'Gryzor',            file:'GRYZOR.SNA',     type:'snap', cat:'Action',    year:1987, icon:'fa-gun',
      desc:'La fabuleuse conversion du célèbre jeu d\'arcade. Courez, sautez et tirez sans jamais vous arrêter pour anéantir la menace extraterrestre.' },
    { title:'Head Over Heels',   file:'HOH.SNA',        type:'snap', cat:'Puzzle',    year:1987, icon:'fa-cube',
      desc:'Deux sympathiques héros aux compétences distinctes doivent s\'échapper d\'un immense château. L\'apogée de la plateforme et de la réflexion en 3D isométrique.' },
    { title:'Ikari Warriors',    file:'IKARI.SNA',      type:'snap', cat:'Action',    year:1986, icon:'fa-crosshairs',
      desc:'Contrôlez deux mercenaires lourdement armés progressant dans une jungle hostile. Prenez le contrôle de tanks pour tout ravager sur votre passage.' },
    { title:'Live and Let Die',  file:'LALD.SNA',       type:'snap', cat:'Action',    year:1988, icon:'fa-ship',
      desc:'Aux commandes d\'un hors-bord ultra-rapide, remontez les cours d\'eau en esquivant les mines et les tirs. Un jeu d\'action et de réflexes exigeant.' },

    // ── CARTOUCHES CPR ───────────────────────────────────────
    { title:'77 Attempts Plus',  file:'77ATTEMPTS.CPR', type:'cart', cat:'Platform',  year:2021, icon:'fa-person-running',
      desc:'Un jeu de plateforme hardcore très moderne. Vous disposez de 77 tentatives pour réussir à traverser des tableaux aux sauts millimétrés et aux pièges sadiques.' },
    { title:'Abbey Of Crime',    file:'ABBEY.CPR',      type:'cart', cat:'RPG',       year:1987, icon:'fa-church',
      desc:'Un jeu d\'aventure mythique inspiré du \'Nom de la Rose\'. Menez l\'enquête sur des meurtres en respectant scrupuleusement les horaires du monastère.' },
    { title:'Alcon 2020',        file:'ALCON2020.CPR',  type:'cart', cat:'Action',    year:2020, icon:'fa-jet-fighter',
      desc:'Superbe conversion du shoot \'em up arcade Slap Fight. Récoltez des étoiles pour choisir vos power-ups et transformer votre vaisseau en machine de guerre.' },
    { title:'Baba\'s Palace',    file:'BABASPAL.CPR',   type:'cart', cat:'Platform',  year:2023, icon:'fa-gamepad',
      desc:'Un puzzle-game en vue de dessus, très récemment primé. Déplacez des blocs et utilisez judicieusement les éléments du décor pour ouvrir la sortie.' },
    { title:'Barbarian II',      file:'BARBARIAN2.CPR', type:'cart', cat:'Action',    year:1988, icon:'fa-skull-crossbones',
      desc:'La suite des aventures du célèbre guerrier. Explorez des donjons labyrinthiques et affrontez une multitude de créatures préhistoriques et mutantes.' },
    { title:'Batman The Movie',  file:'BATMANM.CPR',    type:'cart', cat:'Action',    year:1989, icon:'fa-mask',
      desc:'Revivez les scènes mémorables du film de Tim Burton. Lancez des Batarangs, pilotez la Batmobile et volez en Batwing dans ce jeu d\'action varié.' },
    { title:'Bears!',            file:'BEARS.CPR',      type:'cart', cat:'Arcade',    year:2017, icon:'fa-paw',
      desc:'Un jeu d\'arcade frénétique développé récemment pour le CPC. Ramassez un maximum de fruits dans la forêt tout en évitant les ours féroces.' },
    { title:'Blinky\'s Scary School',file:'BLINKYS.CPR',type:'cart', cat:'Platform',  year:1990, icon:'fa-ghost',
      desc:'Incarnez le fantôme Blinky. Déjouez les pièges, effrayez vos ennemis et ramassez divers objets magiques à travers un immense château hanté.' },
    { title:'Blue Angel 69',     file:'BLUEANGEL.CPR',  type:'cart', cat:'Puzzle',    year:1989, icon:'fa-chess-board',
      desc:'Un puzzle-game stratégique au ton décalé. Déplacez-vous sur un damier en alignant des chiffres pour battre votre adversaire robotique et dévoiler des images.' },
    { title:'Burnin\' Rubber',   file:'BURNRUB.CPR',    type:'cart', cat:'Sport',     year:1990, icon:'fa-fire-flame-curved',
      desc:'Faites chauffer la gomme dans de spectaculaires courses d\'endurance style Le Mans. Ce titre phare de la console GX4000 utilise à fond le hardware Plus.' },
    { title:'Cauldron II',       file:'CAULDRON2.CPR',  type:'cart', cat:'Platform',  year:1986, icon:'fa-hat-wizard',
      desc:'Transformez-vous en citrouille bondissante pour explorer le château de la Sorcière. Un jeu de plateforme culte aux rebonds très capricieux.' },
    { title:'Chevy Chase',       file:'CHEVYCHASE.CPR', type:'cart', cat:'Action',    year:1990, icon:'fa-car-side',
      desc:'Traversez des niveaux bourrés de pièges et d\'obstacles au volant de véhicules farfelus. Un jeu de course-action loufoque et exigeant.' },
    { title:'Copter 271',        file:'COPTER271.CPR',  type:'cart', cat:'Arcade',    year:1990, icon:'fa-helicopter',
      desc:'Prenez les commandes de votre hélicoptère pour des missions de sauvetage intenses. Gérez votre carburant tout en évitant les tirs de la DCA.' },
    { title:'Crazy Cars II',     file:'CRAZYCARS2.CPR', type:'cart', cat:'Sport',     year:1989, icon:'fa-car',
      desc:'Fuyez la police au volant de votre Ferrari F40. Un jeu de course audacieux utilisant un immense réseau routier et des barrages policiers.' },
    { title:'Dick Tracy',        file:'DICKTRACY.CPR',  type:'cart', cat:'Action',    year:1990, icon:'fa-user-secret',
      desc:'Nettoyez les rues de Chicago des gangsters dans cette adaptation du célèbre film. Fusillades intenses et séquences de conduite sont au programme.' },
    { title:'El Linaje Real',    file:'LINAJE.CPR',     type:'cart', cat:'RPG',       year:2022, icon:'fa-crown',
      desc:'Un jeu de rôle/aventure récent. Parcourez un royaume de fantasy, interagissez avec des dizaines de personnages et accomplissez des quêtes épiques.' },
    { title:'Fire and Forget II',file:'FAF2.CPR',       type:'cart', cat:'Action',    year:1990, icon:'fa-car-burst',
      desc:'Contrôlez le Thunder Master, un bolide blindé capable de s\'envoler. Détruisez les convois terroristes dans cet explosif jeu de tir en pseudo-3D.' },
    { title:'Fluff',             file:'FLUFF.CPR',      type:'cart', cat:'Platform',  year:1994, icon:'fa-paw',
      desc:'Dirigez une petite boule de poils dans un monde enchanteur. Un jeu de plateforme très abouti, conçu spécialement pour exploiter la gamme Plus.' },
    { title:'Foggy\'s Quest',    file:'FOGGYSQ.CPR',    type:'cart', cat:'RPG',       year:2024, icon:'fa-map',
      desc:'Une aventure très récente et colorée. Explorez les terres sauvages de Narg, récoltez des clés et triomphez d\'ennemis pour retrouver votre chemin.' },
    { title:'Game Over',         file:'GAMEOVER.CPR',   type:'cart', cat:'Action',    year:1987, icon:'fa-gun',
      desc:'Incarnez un guerrier galactique sur une planète hostile. Un run & gun réputé pour sa difficulté extrême et son excellente musique.' },
    { title:'Ghost Trick',       file:'GHOSTTRICK.CPR', type:'cart', cat:'Puzzle',    year:2023, icon:'fa-ghost',
      desc:'Une belle production homebrew de réflexion. Guidez judicieusement vos fantômes et utilisez le décor pour résoudre des énigmes tordues.' },
    { title:'Ghosts \'n Goblins',file:'GNG.CPR',        type:'cart', cat:'Action',    year:1986, icon:'fa-skull',
      desc:'La version cartouche du chef-d\'œuvre de Capcom. Affrontez morts-vivants et démons dans des niveaux à la difficulté légendaire.' },
    { title:'Hexavirus',         file:'HEXAVIRUS.CPR',  type:'cart', cat:'Puzzle',    year:2019, icon:'fa-virus',
      desc:'Un excellent jeu de stratégie récent. Conquérez une grille hexagonale en absorbant les couleurs adjacentes avant votre adversaire.' },
    { title:'Hyperdome',         file:'HYPERD.CPR',     type:'cart', cat:'Arcade',    year:1990, icon:'fa-rocket',
      desc:'À bord de votre vaisseau, survivez dans un environnement fermé rempli de dangers. Un jeu d\'action multidirectionnel rapide et nerveux.' },
    { title:'Invasion of the Zombie',file:'INVASIONZ.CPR',type:'cart',cat:'Action',   year:2010, icon:'fa-biohazard',
      desc:'Un jeu d\'action fantastique moderne. Frayez-vous un chemin face à des hordes de morts-vivants pour empêcher l\'extinction de la race humaine.' },
    { title:'Jarlac',            file:'JARLAC.CPR',     type:'cart', cat:'Platform',  year:2018, icon:'fa-shield-halved',
      desc:'Un excellent jeu de plateforme/action. Aidez un courageux chevalier à retrouver des artefacts magiques à travers des donjons périlleux.' },
    { title:'Klax',              file:'KLAX.CPR',       type:'cart', cat:'Puzzle',    year:1990, icon:'fa-boxes-stacked',
      desc:'Réceptionnez des tuiles colorées arrivant sur un tapis roulant et alignez-les par trois. Un puzzle-game d\'arcade au concept terriblement accrocheur.' },
    { title:'Kung-Fu Master',    file:'KUNGFU.CPR',     type:'cart', cat:'Action',    year:2023, icon:'fa-hand-fist',
      desc:'Gravissez les cinq étages du temple pour sauver Sylvia. Ce portage très récent sublime ce grand classique fondateur du beat\'em up.' },
    { title:'Lala',              file:'LALA.CPR',       type:'cart', cat:'Platform',  year:2010, icon:'fa-child-reaching',
      desc:'Une charmante production signée The Mojon Twins. Explorez un château magique, trouvez des fioles et évitez les gardes dans ce jeu de plateforme.' },
    { title:'Legend of Steel',   file:'LSTEL.CPR',      type:'cart', cat:'RPG',       year:2020, icon:'fa-dragon',
      desc:'Un RPG d\'action moderne pour l\'Amstrad. Parcourez un vaste monde ouvert, accumulez de l\'or, équipez-vous et tuez des monstres imposants.' },
    { title:'Mandarin 2',        file:'MANDARIN2.CPR',  type:'cart', cat:'Platform',  year:2024, icon:'fa-lemon',
      desc:'Une suite homebrew pétillante. Un jeu de plateforme très coloré où la précision de vos sauts sera mise à rude épreuve par des niveaux corsés.' },
    { title:'Missile Command',   file:'MISSILE.CPR',    type:'cart', cat:'Arcade',    year:2022, icon:'fa-meteor',
      desc:'Défendez vos bases contre une pluie ininterrompue d\'ogives nucléaires. Une version sublimée spécifiquement pour la gamme GX4000/CPC Plus.' },
    { title:'Monument',          file:'MONUMENT.CPR',   type:'cart', cat:'RPG',       year:2020, icon:'fa-monument',
      desc:'Pénétrez dans d\'anciennes ruines dans ce jeu d\'aventure soigné. Affrontez des pièges antiques et découvrez les sombres secrets d\'un monde oublié.' },
    { title:'Mystical',          file:'MYSTICAL.CPR',   type:'cart', cat:'RPG',       year:1991, icon:'fa-wand-sparkles',
      desc:'Un shoot \'em up fantastique aux allures de jeu de rôle. Incarnez un sorcier volant et dégommez des vagues d\'ennemis en ramassant des potions magiques.' },
    { title:'Navy SEALS',        file:'NAVYSEAL.CPR',   type:'cart', cat:'Action',    year:1991, icon:'fa-anchor',
      desc:'Infiltrez des bases terroristes lourdement gardées et libérez des otages. Un jeu d\'action frénétique qui exploite la palette de couleurs du CPC Plus.' },
    { title:'No Exit',           file:'NOEXIT.CPR',     type:'cart', cat:'Action',    year:1990, icon:'fa-door-closed',
      desc:'Un jeu de combat monstrueux en arène fermée. Affrontez des créatures abominables dans des combats brutaux à un contre un.' },
    { title:'Octopus',           file:'OCTOPUS.CPR',    type:'cart', cat:'Arcade',    year:2023, icon:'fa-water',
      desc:'Un sublime hommage récent au jeu électronique Game & Watch. Récupérez le trésor des profondeurs sans vous faire attraper par la pieuvre géante.' },
    { title:'Octopus 2.1',       file:'OCTOPUS21.CPR',  type:'cart', cat:'Arcade',    year:2023, icon:'fa-water',
      desc:'La version ultime et optimisée d\'Octopus. Encore plus rapide et fluide, idéale pour exploser les high scores sur votre console.' },
    { title:'Oh Chute',          file:'OHCHUTE.CPR',    type:'cart', cat:'Arcade',    year:2020, icon:'fa-parachute-box',
      desc:'Un petit jeu d\'arcade addictif et moderne. Gérez la chute libre de votre personnage et déclenchez le parachute au tout dernier moment pour marquer des points.' },
    { title:'Operation Thunderbolt',file:'OPTHUND.CPR', type:'cart', cat:'Action',    year:1990, icon:'fa-bolt',
      desc:'La suite directe du mythique Operation Wolf. Prenez votre uzi virtuel et dégommez tout ce qui bouge dans ce jeu de tir sur rails explosif.' },
    { title:'OPQA vs QAOP',      file:'OPQA.CPR',       type:'cart', cat:'Arcade',    year:2020, icon:'fa-keyboard',
      desc:'Un concept d\'arcade multijoueur décalé basé sur les légendaires touches directionnelles de l\'Amstrad. Parfait pour défier un ami lors de parties rapides.' },
    { title:'Pang',              file:'PANG.CPR',       type:'cart', cat:'Arcade',    year:1990, icon:'fa-circle-dot',
      desc:'L\'adaptation officielle sur cartouche. Parcourez le monde entier en détruisant stratégiquement des bulles extraterrestres qui se divisent en deux.' },
    { title:'Pang Plus',         file:'PANGPLUS.CPR',   type:'cart', cat:'Arcade',    year:2020, icon:'fa-circle-dot',
      desc:'Une version améliorée et lissée du célèbre classique. Faites éclater les bulles rebondissantes avec vos harpons sans vous faire toucher.' },
    { title:'Panza Kick Boxing', file:'PANZA.CPR',      type:'cart', cat:'Sport',     year:1991, icon:'fa-shoe-prints',
      desc:'Montez sur le ring et maîtrisez diverses techniques de boxe pieds-poings. Un jeu de combat sportif avec des animations saisissantes de réalisme.' },
    { title:'Phantomas 2.0',     file:'PHANTOMAS.CPR',  type:'cart', cat:'Platform',  year:2010, icon:'fa-user-ninja',
      desc:'Un remake moderne et très fluide d\'un classique espagnol. Explorez le château du comte Dracula pour le vaincre une bonne fois pour toutes.' },
    { title:'Piccrocs',          file:'PICCROCS.CPR',   type:'cart', cat:'Puzzle',    year:2020, icon:'fa-square',
      desc:'Résolvez des grilles logiques en noircissant les bonnes cases selon les indices chiffrés. Un Picross incontournable, moderne et relaxant.' },
    { title:'Ping Pong',         file:'PINGPONG.CPR',   type:'cart', cat:'Sport',     year:1985, icon:'fa-table-tennis-paddle-ball',
      desc:'La fabuleuse adaptation du tennis de table de Konami. Des mécaniques simples mais exigeantes qui offrent des échanges intenses.' },
    { title:'Plotting',          file:'PLOTTING.CPR',   type:'cart', cat:'Puzzle',    year:1990, icon:'fa-diagram-project',
      desc:'Un jeu de réflexion captivant. Lancez un bloc sur un amas de blocs de même motif pour les faire disparaître et nettoyer la zone dans le temps imparti.' },
    { title:'Pro Tennis Tour',   file:'TENNIS.CPR',     type:'cart', cat:'Sport',     year:1990, icon:'fa-table-tennis-paddle-ball',
      desc:'L\'une des meilleures simulations de tennis de sa génération. Maîtrisez le placement, variez la puissance de vos coups et remportez la victoire finale.' },
    { title:'Puzzle Bobble',     file:'PUZBOB.CPR',     type:'cart', cat:'Puzzle',    year:2020, icon:'fa-soap',
      desc:'Le brillant portage homebrew du spin-off de Bubble Bobble. Visez et tirez des bulles de couleur pour créer des correspondances et nettoyer l\'écran.' },
    { title:'Puzznic',           file:'PUZZNIC.CPR',    type:'cart', cat:'Puzzle',    year:1990, icon:'fa-cubes',
      desc:'Faites glisser des blocs aux symboles identiques pour les faire se toucher et disparaître. Un casse-tête qui devient très retors passé les premiers niveaux.' },
    { title:'Quarterback',       file:'TOMBRADY.CPR',   type:'cart', cat:'Sport',     year:1990, icon:'fa-football',
      desc:'Mettez votre casque et menez votre équipe de football américain. Un jeu de sport très tactique profitant pleinement des capacités du CPC Plus.' },
    { title:'Rick Dangerous',    file:'RICKC.CPR',      type:'cart', cat:'Platform',  year:1989, icon:'fa-person-running',
      desc:'La version cartouche du chef-d\'œuvre de la plateforme. Profitez de chargements instantanés, très utiles au vu de la difficulté des temples à traverser !' },
    { title:'Robocop 2',         file:'ROBOCOP2.CPR',   type:'cart', cat:'Action',    year:1990, icon:'fa-robot',
      desc:'Faites respecter la loi dans le vieux Detroit. Abattez les criminels, résolvez des puzzles de piratage et affrontez le terrible cyborg Cain.' },
    { title:'Solomon\'s Key',    file:'SOLOMON.CPR',    type:'cart', cat:'Puzzle',    year:1986, icon:'fa-key',
      desc:'Incarnez le sorcier Dana. Utilisez votre baguette pour créer ou détruire des blocs de pierre afin de récupérer la clé de chaque niveau.' },
    { title:'Sorcerers',         file:'SORCERERS.CPR',  type:'cart', cat:'RPG',       year:1990, icon:'fa-hat-wizard',
      desc:'Un pur dungeon crawler à l\'ancienne. Composez votre équipe, explorez de vastes couloirs en 3D case par case et lancez de puissants sortilèges.' },
    { title:'Striker',           file:'STRIKER.CPR',    type:'cart', cat:'Action',    year:1990, icon:'fa-dungeon',
      desc:'Un jeu d\'action et d\'exploration dans d\'obscures cryptes. Affrontez les monstres et sorciers locaux en maniant votre épée avec agilité.' },
    { title:'Super Pinball Magic',file:'PINBALL.CPR',   type:'cart', cat:'Arcade',    year:1991, icon:'fa-circle-notch',
      desc:'Une simulation de flipper incroyable s\'étalant sur plusieurs écrans verticaux. Tirez parti des bumpers et des rampes pour faire exploser le score.' },
    { title:'Switchblade',       file:'SWITCHBLD.CPR',  type:'cart', cat:'Platform',  year:1990, icon:'fa-scissors',
      desc:'Incarnez Hiro dans un immense labyrinthe souterrain truffé de cyborgs. Un formidable jeu d\'action/plateforme doté d\'une ambiance sombre et d\'une excellente maniabilité.' },
    { title:'Tactics GX',        file:'TACTICSGX.CPR',  type:'cart', cat:'Strategie', year:2020, icon:'fa-chess-knight',
      desc:'Un jeu de stratégie tactique au tour par tour. Placez judicieusement vos unités sur le damier de combat pour exploiter les faiblesses de l\'adversaire.' },
    { title:'Tennis Cup 2',      file:'TENNISC2.CPR',   type:'cart', cat:'Sport',     year:1990, icon:'fa-table-tennis-paddle-ball',
      desc:'Une très bonne simulation sportive proposant une vue arrière dynamique (split screen en multijoueur). Un gameplay riche et de beaux graphismes.' },
    { title:'The Enforcer',      file:'ENFORCER.CPR',   type:'cart', cat:'Action',    year:1990, icon:'fa-shield-halved',
      desc:'Aux commandes de votre vaisseau surarmé, éradiquez la menace extraterrestre. Un shoot vertical très nerveux avec de nombreuses vagues d\'ennemis.' },
    { title:'Tintin on the Moon',file:'TINTIN.CPR',     type:'cart', cat:'Action',    year:1990, icon:'fa-moon',
      desc:'Aidez Tintin à stopper les saboteurs en explorant l\'intérieur de la fusée spatiale, puis pilotez-la à l\'extérieur à travers des champs de météorites.' },
    { title:'Titanic Blinky',    file:'TITANICB.CPR',   type:'cart', cat:'Platform',  year:1990, icon:'fa-ship',
      desc:'Le facétieux fantôme Blinky est de retour ! Naviguez à travers les décors sous-marins et les cales d\'un navire coulé, tout en évitant des pièges marins.' },
    { title:'Wild Streets',      file:'WSTREETS.CPR',   type:'cart', cat:'Action',    year:1990, icon:'fa-paw',
      desc:'Incarnez un agent luttant contre la mafia, accompagné de sa panthère noire. Combattez dans la rue et ordonnez à votre félin d\'attaquer les malfrats.' },
    { title:'World Of Sports',   file:'WOSPORTS.CPR',   type:'cart', cat:'Sport',     year:1990, icon:'fa-trophy',
      desc:'Participez à diverses épreuves sportives estivales exigeant de redoutables réflexes et une grande résistance des joysticks.' },
    { title:'Yie Ar Kung-Fu',    file:'YIEAR.CPR',      type:'cart', cat:'Action',    year:2020, icon:'fa-yin-yang',
      desc:'Le père de tous les jeux de combat, entièrement modernisé pour la gamme Plus. Affrontez des maîtres martiaux aux styles très variés.' }
];

/* ── Tables de correspondance ───────────────────────────────── */
var CAT_COLORS = {
    'Action':    'var(--cat-action)',
    'Arcade':    'var(--cat-arcade)',
    'Platform':  'var(--cat-platform)',
    'RPG':       'var(--cat-rpg)',
    'Puzzle':    'var(--cat-puzzle)',
    'Sport':     'var(--cat-sport)',
    'Demo':      'var(--cat-demo)',
    'Strategie': 'var(--cat-strat)'
};

var MEDIA = {
    disc: { icon:'fa-compact-disc', label:'DSK', cls:'mb-disc' },
    snap: { icon:'fa-floppy-disk',  label:'SNA', cls:'mb-snap' },
    cart: { icon:'fa-gamepad',      label:'CPR', cls:'mb-cart' }
};

/* ── État de l'interface ────────────────────────────────────── */
var state = { cat:'all', media:'all', search:'', sort:'alpha' };

/* ─────────────────────────────────────────────────────────────
   UTILITAIRE — Échappement HTML
   ───────────────────────────────────────────────────────────── */
function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

/* ─────────────────────────────────────────────────────────────
   RENDU — Tags de filtres actifs
   ───────────────────────────────────────────────────────────── */
function renderActiveTags() {
    var wrap = document.getElementById('active-tags');
    wrap.innerHTML = '';
    if (state.cat !== 'all') {
        wrap.innerHTML += '<span class="active-tag"><i class="fas fa-tag"></i> ' +
            esc(state.cat === 'Strategie' ? 'Stratégie' : state.cat) + '</span>';
    }
    if (state.media !== 'all') {
        var labels = { disc:'Disquette', snap:'Snapshot', cart:'Cartouche' };
        wrap.innerHTML += '<span class="active-tag"><i class="fas fa-compact-disc"></i> ' +
            (labels[state.media] || state.media) + '</span>';
    }
    if (state.search.trim()) {
        wrap.innerHTML += '<span class="active-tag"><i class="fas fa-magnifying-glass"></i> "' +
            esc(state.search) + '"</span>';
    }
}

/* ─────────────────────────────────────────────────────────────
   RENDU — Construction d'une carte de jeu
   ───────────────────────────────────────────────────────────── */
function buildCard(g, i) {
    var m           = MEDIA[g.type] || MEDIA.disc;
    var col         = CAT_COLORS[g.cat] || 'var(--primary)';
    var fileName    = Array.isArray(g.file) ? g.file.join(',') : g.file;
    var primaryFile = Array.isArray(g.file) ? g.file[0] : g.file;
    var url         = 'game.html?type=' + encodeURIComponent(g.type) + '&file=' + encodeURIComponent(fileName);
    var hasVideo    = VIDEOS_EXISTANTES.indexOf(primaryFile) !== -1;

    var thumbUrl  = 'thumbnail/' + encodeURIComponent(primaryFile) + '.png';
    var thumbHTML = '<img class="card-thumbnail" src="' + thumbUrl + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';

    var videoHTML = thumbHTML;
    if (hasVideo) {
        var videoUrl = 'thumbnail/' + encodeURIComponent(primaryFile) + '.mp4#t=2';
        videoHTML += '<video class="card-video" loop muted playsinline preload="auto" ' +
                     'disablePictureInPicture controlslist="nodownload" onloadeddata="initVideo(this)">' +
                     '<source src="' + videoUrl + '" type="video/mp4">' +
                     '</video>';
    }

    var a = document.createElement('a');
    a.className = 'game-card';
    a.href      = url;
    a.setAttribute('data-desc', esc(g.desc));
    a.style.setProperty('--card-color', col);

    a.innerHTML =
        '<div class="card-visual">' +
            videoHTML +
            '<span class="card-idx">#' + String(i + 1).padStart(2, '0') + '</span>' +
            // LIGNE CORRIGÉE CI-DESSOUS :
            '<span class="media-badge ' + m.cls + '">' + m.label + '</span>' + 
            '<i class="fas ' + g.icon + ' main-icon"></i>' +
        '</div>' +
        '<div class="card-body">' +
            '<div class="card-title">' + esc(g.title) + '</div>' +
            '<div class="card-meta">' +
                '<span class="cat-tag">' + esc(g.cat) + '</span>' +
                '<span class="card-year">' + g.year + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="card-play-btn"><i class="fas fa-play"></i> Jouer</div>';

    return a;
}

/* ─────────────────────────────────────────────────────────────
   RENDU — Grille complète (filtre + tri)
   ───────────────────────────────────────────────────────────── */
function render() {
    var list = GAMES.slice();

    if (state.cat   !== 'all') list = list.filter(function (g) { return g.cat  === state.cat;   });
    if (state.media !== 'all') list = list.filter(function (g) { return g.type === state.media; });
    if (state.search.trim()) {
        var q = state.search.trim().toLowerCase();
        list = list.filter(function (g) {
            return g.title.toLowerCase().indexOf(q) >= 0 ||
                   g.cat.toLowerCase().indexOf(q)   >= 0 ||
                   g.file.toLowerCase().indexOf(q)  >= 0;
        });
    }

    list.sort(function (a, b) {
        switch (state.sort) {
            case 'alpha':      return a.title.localeCompare(b.title);
            case 'alpha-desc': return b.title.localeCompare(a.title);
            case 'year':       return a.year - b.year;
            case 'year-desc':  return b.year - a.year;
            case 'cat':        return a.cat.localeCompare(b.cat) || a.title.localeCompare(b.title);
            default:           return 0;
        }
    });

    var grid  = document.getElementById('games-grid');
    var empty = document.getElementById('empty-state');
    grid.innerHTML = '';

    if (list.length === 0) {
        empty.classList.add('show');
    } else {
        empty.classList.remove('show');
        list.forEach(function (g, i) { grid.appendChild(buildCard(g, i)); });
    }

    document.getElementById('visible-count').textContent = list.length;
    renderActiveTags();
}

/* ─────────────────────────────────────────────────────────────
   VIDÉO — Initialisation au chargement (frame 2s)
   ───────────────────────────────────────────────────────────── */
function initVideo(video) {
    video.currentTime = 2;
    video.classList.add('active');
}

/* ─────────────────────────────────────────────────────────────
   RESET — Remise à zéro de tous les filtres
   ───────────────────────────────────────────────────────────── */
function resetFilters() {
    state = { cat:'all', media:'all', search:'', sort:'alpha' };
    document.getElementById('search-input').value = '';
    document.getElementById('sort-select').value  = 'alpha';
    document.querySelectorAll('.filter-pill').forEach(function (b) { b.classList.remove('active'); });
    document.querySelector('#filter-cat  [data-cat="all"]').classList.add('active');
    document.querySelector('#filter-media [data-media="all"]').classList.add('active');
    render();
}

/* ─────────────────────────────────────────────────────────────
   ÉVÉNEMENTS — Filtres catégorie
   ───────────────────────────────────────────────────────────── */
document.getElementById('filter-cat').addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-pill');
    if (!btn) return;
    document.querySelectorAll('#filter-cat .filter-pill').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.cat = btn.dataset.cat;
    render();
});

/* ── Filtres média ───────────────────────────────────────────── */
document.getElementById('filter-media').addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-pill');
    if (!btn) return;
    document.querySelectorAll('#filter-media .filter-pill').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.media = btn.dataset.media;
    render();
});

/* ── Tri ─────────────────────────────────────────────────────── */
document.getElementById('sort-select').addEventListener('change', function () {
    state.sort = this.value;
    render();
});

/* ── Recherche (debounce 180 ms) ─────────────────────────────── */
var _searchTimer;
document.getElementById('search-input').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () { state.search = v; render(); }, 180);
});

/* ── Raccourcis clavier — "/" focus, "Escape" reset ──────────── */
document.addEventListener('keydown', function (e) {
    var inp = document.getElementById('search-input');
    if (e.key === '/' && document.activeElement !== inp) {
        e.preventDefault();
        inp.focus();
        inp.select();
    }
    if (e.key === 'Escape') {
        inp.value      = '';
        state.search   = '';
        render();
        inp.blur();
    }
});

/* ─────────────────────────────────────────────────────────────
   TOOLTIP & VIDÉO — Survol de la grille
   ───────────────────────────────────────────────────────────── */
var tooltip = document.getElementById('game-tooltip');
var grid    = document.getElementById('games-grid');

/** Suit la souris pour positionner le tooltip. */
grid.addEventListener('mousemove', function (e) {
    if (!tooltip.classList.contains('visible')) return;
    var x  = e.clientX + 16;
    var y  = e.clientY + 16;
    var tw = tooltip.offsetWidth  || 280;
    var th = tooltip.offsetHeight || 80;
    if (x + tw > window.innerWidth)  x = e.clientX - tw - 8;
    if (y + th > window.innerHeight) y = e.clientY - th - 8;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
});

grid.addEventListener('mouseover', function (e) {
    var card = e.target.closest('.game-card');
    if (!card) return;

    // 1. Tooltip
    if (card.dataset.desc) {
        tooltip.innerHTML  = card.dataset.desc;
        tooltip.style.left = '-9999px';
        tooltip.style.top  = '-9999px';
        tooltip.classList.add('visible');
    }

    // 2. Gestion conditionnelle Image / Vidéo
    var video = card.querySelector('.card-video');
    var img   = card.querySelector('.card-thumbnail');

    // On ne cache l'image QUE si l'élément vidéo existe dans le DOM
    if (video) {
        if (img) img.style.opacity = '0'; // On cache l'image
        video.play().catch(function () {});
    }
});

grid.addEventListener('mouseout', function (e) {
    var card = e.target.closest('.game-card');
    if (!card) return;

    tooltip.classList.remove('visible');

    var video = card.querySelector('.card-video');
    var img   = card.querySelector('.card-thumbnail');

    if (video) {
        video.pause();
    }
    // On réaffiche toujours l'image en sortant (si elle existe)
    if (img) img.style.opacity = '1';
});

/* ── Sécurité : retire les <video> dont la source MP4 est absente ── */
document.addEventListener('error', function (e) {
    if (e.target.tagName === 'SOURCE') {
        var video = e.target.parentNode;
        if (video) video.remove();
    }
}, true);

/* ─────────────────────────────────────────────────────────────
   INITIALISATION
   ───────────────────────────────────────────────────────────── */
render();
