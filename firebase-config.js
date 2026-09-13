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
export const firebaseConfig = {
  apiKey: '__FIREBASE_API_KEY__',
  authDomain: '__FIREBASE_PROJECT_ID__.firebaseapp.com',
  projectId: '__FIREBASE_PROJECT_ID__',
  storageBucket: '__FIREBASE_STORAGE_BUCKET__',
  messagingSenderId: '__FIREBASE_SENDER_ID__',
  appId: '__FIREBASE_APP_ID__',
};
