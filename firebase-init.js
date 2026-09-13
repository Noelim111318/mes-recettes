/* Mes Recettes — initialisation Firebase (Auth + Firestore + Storage).
 *
 * SDK modulaire charge en ESM depuis le CDN officiel (pas de build, coherent
 * avec le reste de l'app). Version epinglee : la bumper de temps en temps
 * (voir README > Maintenance) et mettre a jour APP_SHELL dans
 * service-worker.js en meme temps.
 */
// Version epinglee (le specificateur d'un import ES doit etre un litteral,
// impossible a construire depuis une variable) : garder les 4 URLs alignees.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Cache local persistant (IndexedDB) : lectures/ecritures disponibles
// hors-ligne, mises en file et synchronisees automatiquement au retour du
// reseau. Un seul onglet actif a la fois (suffisant pour un usage perso).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
});

export const storage = getStorage(app);
