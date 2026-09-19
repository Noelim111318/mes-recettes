/* Mes Recettes — initialisation Firebase (Auth + Firestore + Storage).
 *
 * SDK modulaire charge en ESM depuis le CDN officiel (pas de build, coherent
 * avec le reste de l'app). Version epinglee : la bumper de temps en temps
 * (voir README > Maintenance) et mettre a jour APP_SHELL dans
 * service-worker.js en meme temps.
 */
// Version epinglee (le specificateur d'un import ES doit etre un litteral,
// impossible a construire depuis une variable) : garder les 5 URLs alignees.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { firebaseConfig, APP_CHECK_SITE_KEY } from './firebase-config.js';

const app = initializeApp(firebaseConfig);

// App Check (reCAPTCHA Enterprise) : prouve a Firestore/Storage que la requete vient
// bien de cette app et pas d'un script qui appelle l'API directement. A
// initialiser avant tout autre service. Sur localhost, jeton de debug (imprime
// dans la console, a enregistrer dans la console Firebase > App Check).
if (APP_CHECK_SITE_KEY) {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);

// Efface le cache local Firestore (IndexedDB) : sans danger, c'est une copie,
// jamais la source de verite (qui vit sur le serveur). Sert a se remettre
// d'un conflit entre deux configurations de persistence incompatibles (ex.
// changement de gestionnaire d'onglets) sans que l'utilisatrice ait a vider
// elle-meme les donnees du site.
export async function resetLocalPersistence() {
  try {
    if (!indexedDB.databases) return;
    const dbs = await indexedDB.databases();
    await Promise.all(dbs
      .filter((d) => d.name && /firestore/i.test(d.name))
      .map((d) => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      })));
  } catch (e) { /* best effort */ }
}

// Cache local persistant (IndexedDB) : lectures/ecritures disponibles
// hors-ligne, mises en file et synchronisees automatiquement au retour du
// reseau. Multi-onglets : l'app peut tourner a la fois installee (PWA) et
// dans un onglet classique sans que l'un des deux cesse de recevoir les
// mises a jour en direct (c'etait le cas avec persistentSingleTabManager).
// Repli en cache memoire (pas de persistence hors-ligne pour cette session,
// mais l'app reste utilisable) si l'initialisation echoue -- ca peut arriver
// une fois quand une session precedente a laisse un cache incompatible.
// getFirestore() (pas un 2e initializeFirestore(), qui leve toujours une
// erreur si on l'appelle une 2e fois sur la meme app) recupere/cree
// l'instance par defaut, sans persistence explicite.
function createFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn('[firestore] persistence indisponible, repli memoire :', err);
    resetLocalPersistence();
    return getFirestore(app);
  }
}
export const db = createFirestore();

export const storage = getStorage(app);
