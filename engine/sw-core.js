/* pwa-engine — coeur du service worker, identique pour toutes les apps.
 *
 * Le service-worker.js a la racine de chaque app ne fait que definir quelques
 * variables puis importer ce fichier :
 *
 *   self.APP_SLUG    = 'monapp';
 *   self.APP_VERSION = 'v1.0.0';
 *   self.APP_SHELL   = ['./', './index.html', ...];
 *   importScripts('./engine/sw-core.js');
 *
 * (retro-compat : self.APP_CACHE = 'monapp-v1.0.0' est encore accepte.)
 *
 * Deux caches :
 *   <slug>-<version>   la coque precachee, remplacee a chaque version
 *   <slug>-runtime     le reste (plafonne, vide a chaque activation)
 *
 * Strategie :
 *  - precache tolerant : chaque URL de APP_SHELL est ajoutee individuellement,
 *    une 404 isolee (p.ex. une icone pas encore generee) n'empeche plus
 *    l'installation ;
 *  - PAS de skipWaiting automatique : c'est la page qui decide quand la
 *    nouvelle version prend la main (AppEngine envoie SKIP_WAITING) ;
 *  - navigations HTML : network-first (avec navigation preload), repli cache ;
 *  - reste : cache-first + revalidation en arriere-plan, reecrite dans le
 *    cache d'ou vient la copie (sinon une version perimee subsiste et finit
 *    par masquer la fraiche).
 */
(function () {
  'use strict';

  var VERSION = self.APP_VERSION || null;
  var SLUG = self.APP_SLUG || null;
  var CACHE_NAME = self.APP_CACHE || ((SLUG || 'app') + '-' + (VERSION || 'v1'));
  if (!SLUG) SLUG = CACHE_NAME.replace(/-[^-]*$/, '');   // retro-compat : deduit du nom de cache
  var APP_SHELL = self.APP_SHELL || ['./', './index.html'];
  var RUNTIME = SLUG + '-runtime';
  var RUNTIME_MAX = self.APP_RUNTIME_MAX || 50;

  // Caches appartenant a CETTE app : <slug>-v<...> uniquement. Un simple
  // prefixe "<slug>-" attraperait aussi les caches d'une app voisine dont le
  // slug commence pareil (monapp / monapp-pro).
  var OWN = new RegExp('^' + SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-v[0-9]');

  function cachePut(name, req, resp) {
    return caches.open(name).then(function (cache) { return cache.put(req, resp); });
  }

  // Garde au plus `max` entrees dans un cache (evince les plus anciennes).
  function trim(name, max) {
    return caches.open(name).then(function (cache) {
      return cache.keys().then(function (keys) {
        if (keys.length <= max) return null;
        return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); }));
      });
    });
  }

  // Cherche dans la coque puis dans le runtime, en retenant OU la copie a ete
  // trouvee : la revalidation doit reecrire dans le meme cache.
  function lookup(req) {
    return caches.open(CACHE_NAME).then(function (c) {
      return c.match(req).then(function (r) {
        if (r) return { resp: r, cache: CACHE_NAME };
        return caches.open(RUNTIME).then(function (rc) {
          return rc.match(req).then(function (rr) {
            return rr ? { resp: rr, cache: RUNTIME } : null;
          });
        });
      });
    });
  }

  self.addEventListener('install', function (event) {
    event.waitUntil(
      caches.open(CACHE_NAME).then(function (cache) {
        return Promise.all(APP_SHELL.map(function (u) {
          return cache.add(new Request(u, { cache: 'reload' })).catch(function (err) {
            console.warn('[sw] precache ignore : ' + u + ' (' + (err && err.message) + ')');
          });
        }));
      })
    );
    // Pas de skipWaiting() ici : sinon la nouvelle version prendrait la main
    // pendant que la page tourne encore sur l'ancien JS (melange de versions),
    // et AppEngine.boot({ autoReload:false }) ne pourrait rien retenir.
  });

  self.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      Promise.resolve()
        .then(function () {
          return self.registration.navigationPreload
            ? self.registration.navigationPreload.enable().catch(function () {})
            : null;
        })
        .then(function () { return caches.keys(); })
        .then(function (keys) {
          return Promise.all(keys
            // anciennes versions de cette app + le runtime (reparti de zero :
            // ses entrees datent de la version precedente)
            .filter(function (k) { return k !== CACHE_NAME && (k === RUNTIME || OWN.test(k)); })
            .map(function (k) { return caches.delete(k); }));
        })
        .then(function () { return self.clients.claim(); })
    );
  });

  self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;

    // Navigations HTML : preload -> reseau -> cache -> index.html
    if (req.mode === 'navigate') {
      event.respondWith(
        Promise.resolve(event.preloadResponse).then(function (preloaded) {
          if (preloaded) {
            if (preloaded.ok) cachePut(CACHE_NAME, req, preloaded.clone());
            return preloaded;
          }
          return fetch(req).then(function (resp) {
            if (resp && resp.ok) cachePut(CACHE_NAME, req, resp.clone());
            return resp;
          });
        }).catch(function () {
          return caches.match(req).then(function (cached) { return cached || caches.match('./index.html'); });
        })
      );
      return;
    }

    // Reste : cache d'abord, revalidation en tache de fond dans le meme cache.
    event.respondWith(
      lookup(req).then(function (hit) {
        var target = hit ? hit.cache : RUNTIME;
        var network = fetch(req).then(function (resp) {
          if (resp && resp.status === 200 && new URL(req.url).origin === self.location.origin) {
            cachePut(target, req, resp.clone()).then(function () {
              if (target === RUNTIME) trim(RUNTIME, RUNTIME_MAX);
            });
          }
          return resp;
        }).catch(function () { return hit && hit.resp; });
        return (hit && hit.resp) || network;
      })
    );
  });
})();
