/* Mes Recettes — authentification (email/mot de passe + Google). */
import { auth } from './firebase-init.js';
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  GoogleAuthProvider,
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

export function signUp(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
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

// Redirection plutot que popup : plus fiable en PWA installee (standalone),
// ou les popups sont parfois bloquees/mal gerees par le navigateur.
export function signInWithGoogle() {
  return signInWithRedirect(auth, googleProvider);
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
