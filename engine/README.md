# pwa-engine — API

`engine/engine.js` expose un objet global **`AppEngine`**. Aucun build, aucune
dependance. `engine/engine.css` fournit la coque visuelle. `engine/sw-core.js`
est le corps du service worker (voir plus bas).

Ne modifie pas ces fichiers dans une app : edite-les ici (dans
`toolbox/pwa-engine/`), puis `tools/sync-engine.sh <chemin>/mon-app`.

## Demarrage

```js
AppEngine.boot({
  id: 'monapp',            // requis — prefixe localStorage + slug SW
  version: 'v1.0.0',       // badge d'entete + cache-buster du SW
  // --- tout le reste est optionnel ---
  swUrl: 'service-worker.js',
  starsSel: '#stars', stars: 60,        // false ou 0 pour desactiver
  versionBadgeSel: '#app-version',      // false pour ne pas ecrire le badge
  streakBadgeSel: '#streak-badge',      // false pour ne pas afficher la serie
  strings: { streak: (n) => n + ' d\'affilee' },  // surcharge des textes (i18n)
  screenHash: true,                     // #play dans l'URL (refresh garde l'ecran + gere le retour)
  backButton: true,                     // sinon : fleche retour via popstate (voir screens.show push)
  autoReload: false,                    // ne recharge pas seul sur maj SW
  install: {                            // false pour pas de bandeau
    showOn: () => AppEngine.screens.current() === 'screen-home',
    iosHint: 'Sur iPhone : Partager -> Sur l\'ecran d\'accueil.',
  },
  serviceWorker: true,                  // false en dev si tu preferes
});
```

`boot()` renvoie `{ install }` ; `install.refresh()` re-evalue la visibilite du
bandeau (deja appele automatiquement a chaque changement d'ecran). Il ecrit
aussi un `console.info` avec la version du moteur et de l'app.

## Briques

### `AppEngine.store` — localStorage prefixe par `id`
| | |
|---|---|
| `load(key, dflt)` | JSON.parse, renvoie `dflt` si absent / illisible / mode prive |
| `save(key, val)` | JSON.stringify, avale les erreurs (quota, mode prive) |
| `remove(key)` | supprime |
| `keys()` | toutes les cles de cette app (sans le prefixe) |
| `clear()` | efface tout ce qui appartient a cette app (bouton "reset") |
| `migrate({ 1: fn, 2: fn })` | joue une fois chaque `fn` dont le numero depasse le schema courant, dans l'ordre, et memorise le schema atteint. Si une etape jette : arret **sans** avancer le schema (elle sera rejouee) + `store:migrate-error` |
| `ns(id)` | change le prefixe (fait par `boot`) |

### `AppEngine.screens` — un `.screen` visible a la fois
| | |
|---|---|
| `show('screen-play', opts)` | montre cet ecran, pose `body.play-active`, remonte en haut, **deplace le focus** sur le 1er `h1/h2/h3` (ou `[autofocus]`), emet `screen:show`. `opts.focus:false` pour ne pas bouger le focus. `opts.push:true` pousse une entree d'historique. `opts.hash:false` n'ecrit pas le hash (mode `screenHash`). |
| `current()` | id de l'ecran actif (`'screen-play'`) ou `null` |
| `fromHash()` | id d'ecran nomme par `location.hash` (`#play`), ou `null`. Au boot : `screens.show(screens.fromHash() || 'screen-home')` |
| `onShow(fn)` | alias de `on('screen:show', fn)` ; renvoie la fonction de retrait |
| `wireBack()` | cable `popstate` : restaure l'ecran de `history.state`, sinon emet `screen:back`. Appele par `boot({ backButton:true })`. |
| `wireHash()` | `location.hash` <-> ecran dans les deux sens (retour inclus). Appele par `boot({ screenHash:true })` ; `show()` ecrit alors `#<nom>` a chaque changement. Ne pas combiner avec `backButton`. |
| `back()` | retour arriere : delegue a `history.back()` si `screenHash`/`backButton` est cable, sinon emet `screen:back` |

Les classes `body.<nom>-active` sont recalculees a chaque `show()` : les ecrans
ajoutes au DOM apres coup fonctionnent.

### `AppEngine.on(evt, fn)` / `AppEngine.emit(evt, data)` — bus d'evenements
`on()` renvoie une fonction pour se desabonner. Evenements emis par le moteur :

| evenement | data |
|---|---|
| `screen:show` | `id` de l'ecran |
| `screen:back` | — (retour materiel sans ecran memorise) |
| `install:available` | `{ mode: 'prompt' \| 'ios' }` |
| `install:done` | `null` |
| `sw:registered` | l'objet `ServiceWorkerRegistration` |
| `sw:updateready` | `{ registration, apply() }` — nouvelle version prete |
| `sw:error` | l'erreur d'enregistrement |
| `store:quota` | `{ key, error }` — un `store.save()` a echoue (mode prive / quota) |
| `store:migrate-error` | `{ step, error }` — une etape de `store.migrate()` a jete ; le schema n'a pas avance |

### `AppEngine.strings` / `AppEngine.setStrings({...})` — textes (i18n)
Defauts FR. Surcharge par `boot({ strings })` ou `setStrings()`. Cles :
`streak(n)`, `weekDayLabels[]`, `weekNotPlayed`, `weekCell(correct, seen, pct)`,
`weekSummary(seen, days, rate)`, `installIosHint`.

### `AppEngine.announce(msg, assertive?)`
Ecrit `msg` dans une region `aria-live` visually-hidden (creee au 1er appel).
Pour signaler aux lecteurs d'ecran un evenement qui n'a pas le focus (score,
fin de partie...). `assertive:true` interrompt l'annonce en cours.

### `AppEngine.sound` — WebAudio, sans fichier
| | |
|---|---|
| `enable(bool)` | active/coupe (defaut : actif) |
| `enabled` | lecture seule |
| `resume()` | (re)cree l'AudioContext — a appeler sur le 1er geste utilisateur |
| `tone(freq, startAt, dur, type, peak)` | bip brut ; si le contexte ne tourne pas encore, mis en file et rejoue au prochain `resume()` (plus de 1er son muet) |
| `feedback(ok)` | accord montant si `ok`, descendant sinon |

### `AppEngine.haptic(type)`
`'success'` | `'error'` | `'tap'` (defaut), ou passe directement un nombre / un
tableau de durees (ms). No-op si `navigator.vibrate` absent.

### `AppEngine.fx`
| | |
|---|---|
| `stars(el, count=60)` | remplit `el` de `.star` scintillantes |
| `burst(positive, {container, colors})` | gerbe de particules depuis le centre — **no-op** si `prefers-reduced-motion: reduce` |

### `AppEngine.history` — serie de jours + suivi quotidien
| | |
|---|---|
| `bumpStreak()` | 1x par partie : +1 si joue hier, reset sinon, rien si deja aujourd'hui |
| `streak()` | `{ count, alive }` |
| `renderStreak(el)` | ecrit `strings.streak(n)` (ou cache `el`) |
| `logDaily(seen, correct)` | journalise le jour, purge > 60 j |
| `renderWeek({bars, block, summary})` | barres des 7 derniers jours (cache `block` si vide) |
| `dayStr(ms)` | `'2026-09-07'` |

### `AppEngine.reduceMotion`
Booleen : l'utilisateur a demande moins d'animations (`prefers-reduced-motion`).

### bas niveau (si tu n'utilises pas `boot`)
`AppEngine.installBanner(cfg)` -> `{ refresh }` · `AppEngine.registerServiceWorker({version, url, autoReload})` · `AppEngine.$ / $$`

## Service worker

`service-worker.js` de l'app se limite a :

```js
self.APP_SLUG = 'monapp';           // prefixe des caches de cette app
self.APP_VERSION = 'v1.0.0';        // <slug>-<version> = nom du cache de coque
self.APP_SHELL = ['./', './index.html', './app.css', './app.js', /* ... */];
// self.APP_RUNTIME_MAX = 50;       // plafond du cache "runtime" (defaut 50)
importScripts('./engine/sw-core.js');
```

(`self.APP_CACHE = 'monapp-v1.0.0'` reste accepte pour les vieilles apps.)

Deux caches : `<slug>-<version>` (la coque precachee) et `<slug>-runtime`
(le reste, plafonne a `APP_RUNTIME_MAX`).

`sw-core.js` :
- **install** : precache **tolerant** de `APP_SHELL` — chaque URL est ajoutee
  individuellement, une 404 isolee (icone pas encore generee) n'empeche plus
  l'installation. **Pas de `skipWaiting()`** : c'est la page qui decide quand la
  nouvelle version prend la main (voir `autoReload` / `sw:updateready`), sinon
  elle continuerait a tourner sur l'ancien JS avec les nouveaux assets ;
- **activate** : active la *navigation preload*, supprime les anciennes versions
  **de cette app uniquement** (`<slug>-v…`, pas `<slug>-pro-v…` d'une app
  voisine) ainsi que `<slug>-runtime` (ses entrees datent de la version
  precedente), puis `clients.claim` ;
- **fetch** : navigations HTML -> preload puis reseau puis cache puis
  `index.html` (une reponse en erreur n'est jamais mise en cache) ; reste ->
  cache d'abord + revalidation en tache de fond **reecrite dans le cache d'ou
  vient la copie**, jamais promue de `runtime` vers la coque.

**A chaque livraison** : `tools/bump-version.sh vX.Y.Z` (bumpe la version dans
`app.js`, `service-worker.js`, `index.html`, `manifest.json`) et ajoute les
nouveaux fichiers a `APP_SHELL`.

**Mise a jour.** Par defaut (`autoReload` non passe) : `AppEngine` poste
`SKIP_WAITING` des qu'une version est prete, puis recharge **sur
`controllerchange`** — c'est-a-dire quand le nouveau SW controle reellement la
page, pas juste apres avoir demande. Un premier enregistrement (aucun SW avant)
ne declenche pas de rechargement.

**Reload non force** : `boot({ autoReload: false })` puis
```js
AppEngine.on('sw:updateready', function (u) {
  // afficher "nouvelle version dispo", et sur clic :
  u.apply();   // le SW prend la main ; recharge quand ca t'arrange
});
```
Tant que `apply()` n'est pas appele, l'ancien SW reste aux commandes : rien ne
change sous les pieds de l'utilisateur.

## HTML attendu

`boot()` avec les valeurs par defaut cherche : `#stars`, `#app-version`,
`#streak-badge`, `#install-row` + `#install-btn` + `#install-dismiss` +
`#install-hint`, et des `.screen` avec `id="screen-*"`. Tout est optionnel /
reconfigurable ; voir `template/index.html`.
