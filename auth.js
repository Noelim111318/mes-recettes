/* Mes Recettes — authentification (email/mot de passe + Google). */
import { auth } from './firebase-init.js';
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const googleProvider = new GoogleAuthProvider();

const ERROR_MESSAGES = {
  'auth/email-already-in-use': 'Cet e-mail est déjà utilisé.',
  'auth/invalid-email': 'Adresse e-mail invalide.',
  'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
  'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
  'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
  'auth/user-not-found': 'E-mail ou mot de passe incorrect.',
  'auth/too-many-requests': 'Trop de tentatives, réessaie plus tard.',
  'auth/network-request-failed': 'Pas de connexion réseau.',
  'auth/account-exists-with-different-credential': 'Cet e-mail est déjà utilisé avec un autre mode de connexion.',
  'auth/popup-closed-by-user': 'Connexion annulée.',
};

export function authErrorMessage(err) {
  return ERROR_MESSAGES[err && err.code] || 'Une erreur est survenue, réessaie.';
}

// Envoie l'e-mail de verification dans la foulee (best-effort : le renvoi
// reste possible depuis l'app). Les creations de recettes l'exigent (voir
// firestore.rules), les comptes Google sont verifies d'office.
export function signUp(email, password) {
  return createUserWithEmailAndPassword(auth, email, password).then((cred) => {
    sendEmailVerification(cred.user).catch(() => {});
    return cred;
  });
}

export function sendVerificationEmail() {
  return sendEmailVerification(auth.currentUser);
}

// Relit le compte et force un nouveau jeton (les regles lisent
// `email_verified` dans le jeton, pas dans l'objet utilisateur). Renvoie le
// nouvel etat de verification.
export async function refreshEmailVerified() {
  const user = auth.currentUser;
  if (!user) return false;
  await user.reload();
  await user.getIdToken(true);
  return user.emailVerified;
}

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logOut() {
  return signOut(auth);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// Popup par defaut (marche dans un onglet de navigateur classique, pas de
// rechargement de page donc pas de course avec la maj du service worker).
// Repli en redirection si la popup est bloquee/indisponible (PWA installee
// en mode standalone, certains navigateurs mobiles).
export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider).catch((err) => {
    var code = err && err.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, googleProvider);
    }
    throw err;
  });
}

// A appeler une fois au demarrage : recupere l'erreur d'un signInWithGoogle
// precedent si la redirection a echoue (onAuthStateChanged gere deja le cas
// de succes). Resout a `null` s'il n'y avait pas de redirection en cours.
export function consumeRedirectError() {
  return getRedirectResult(auth).then(() => null).catch((err) => err);
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}
