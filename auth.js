/* Mes Recettes — authentification (email/mot de passe). */
import { auth } from './firebase-init.js';
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const ERROR_MESSAGES = {
  'auth/email-already-in-use': 'Cet e-mail est déjà utilisé.',
  'auth/invalid-email': 'Adresse e-mail invalide.',
  'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
  'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
  'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
  'auth/user-not-found': 'E-mail ou mot de passe incorrect.',
  'auth/too-many-requests': 'Trop de tentatives, réessaie plus tard.',
  'auth/network-request-failed': 'Pas de connexion réseau.',
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

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}
