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
self.APP_VERSION = 'v1.10.0';

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
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js'
];

/* Cache des photos (Firebase Storage). Les URLs sont immuables (nom de fichier
 * = UUID, jamais reecrit) : cache-first sans revalidation, donc plus aucun
 * re-telechargement au refresh — un « hash a comparer » couterait quand meme
 * un aller-retour reseau par photo. Le moteur ne cache pas le cross-origin,
 * d'ou ce handler, declare AVANT importScripts pour passer en premier.
 * Cache separe (pas prefixe <slug>-v...) : survit aux bumps de version.
 * Requete refaite en mode cors pour obtenir une reponse lisible (une reponse
 * opaque compterait ~7 Mo de quota chacune) ; repli sur la requete d'origine
 * si le serveur n'autorise pas le CORS. */
var PHOTO_CACHE = 'mes-recettes-photos';
var PHOTO_CACHE_MAX = 300;

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || req.destination !== 'image') return;
  if (new URL(req.url).hostname !== 'firebasestorage.googleapis.com') return;
  event.stopImmediatePropagation();
  event.respondWith(
    caches.open(PHOTO_CACHE).then(function (cache) {
      return cache.match(req.url).then(function (hit) {
        if (hit) return hit;
        return fetch(req.url, { mode: 'cors' }).then(function (resp) {
          if (resp.status !== 200) return resp;
          cache.put(req.url, resp.clone()).then(function () {
            return cache.keys();
          }).then(function (keys) {
            keys.slice(0, Math.max(0, keys.length - PHOTO_CACHE_MAX)).forEach(function (k) { cache.delete(k); });
          }).catch(function () {});
          return resp;
        }).catch(function () { return fetch(req); });
      });
    })
  );
});

importScripts('./engine/sw-core.js');
