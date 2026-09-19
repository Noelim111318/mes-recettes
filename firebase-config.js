/* Mes Recettes — configuration web Firebase.
 *
 * Cet objet n'est PAS un secret (voir la doc Firebase officielle) : il
 * identifie juste le projet auprès du SDK, la sécurité réelle vient des
 * règles Firestore/Storage (voir firestore.rules / storage.rules). Il peut
 * donc être commité tel quel.
 *
 * A remplir après création du projet sur https://console.firebase.google.com
 * (Paramètres du projet > Général > Vos applications > icône Web > objet de
 * config affiché). Colle l'objet tel quel à la place de celui-ci.
 */
// Cle de site reCAPTCHA v3 pour App Check (publique, pas un secret). Vide =
// App Check desactive. Voir README > App Check pour l'obtenir.
export const APP_CHECK_SITE_KEY = '6LcePsQtAAAAAN3Hs8VwO9WumLzJ5-SlfbM2Kovb';

export const firebaseConfig = {
  apiKey: 'AIzaSyDewBKNIa4Avvb1SCS52OCMrOafOvAQ8J0',
  authDomain: 'mes-recettes-aea4e.firebaseapp.com',
  projectId: 'mes-recettes-aea4e',
  storageBucket: 'mes-recettes-aea4e.firebasestorage.app',
  messagingSenderId: '901184916298',
  appId: '1:901184916298:web:6a9f38e0145c01f7614fb3',
  measurementId: 'G-NN7TNTFZGX',
};
