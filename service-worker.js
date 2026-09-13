/* Mes Recettes — service worker.
 * Toute la logique (precache tolerant, network-first, purge, cache runtime)
 * est dans engine/sw-core.js. Ici on declare juste l'identite du cache et la
 * liste des fichiers de la coque.
 *
 * >>> A chaque livraison : ./tools/bump-version.sh vX.Y.Z
 *     (bumpe APP_VERSION ici + index.html + app.js + manifest.json d'un coup)
 *     puis ajoute tout nouveau fichier statique a APP_SHELL ci-dessous.
 */
self.APP_SLUG = 'mes-recettes';
self.APP_VERSION = 'v1.3.0';

self.APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './data.js',
  './firebase-config.js',
  './firebase-init.js',
  './auth.js',
  './recipes.js',
  './manifest.json',
  './engine/engine.js',
  './engine/engine.css',
  './engine/sw-core.js',
  './engine/fonts/nunito-latin.woff2',
  './engine/fonts/nunito-latin-ext.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  // SDK Firebase (version epinglee, voir firebase-init.js) : precache pour
  // que l'app demarre hors-ligne meme si le cache HTTP du navigateur a ete
  // vide. Precache tolerant : une eventuelle erreur CORS/reseau ici
  // n'empeche pas l'installation du reste de la coque.
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js'
];

importScripts('./engine/sw-core.js');
