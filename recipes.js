/* Mes Recettes — CRUD Firestore + photo Storage.
 *
 * Isolation par utilisatrice : chaque recette porte un `ownerId`, la requete
 * liste filtre dessus, et les regles Firestore (firestore.rules) refusent
 * tout acces a un document dont on n'est pas proprietaire. `sharedWith` est
 * ecrit vide a la creation et jamais touche ici : reserve a une future
 * fonctionnalite de partage (pas de migration a prevoir).
 */
import { db, storage } from './firebase-init.js';
import {
  collection, query, where, orderBy, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

const RECIPES = collection(db, 'recipes');
const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;

export function subscribeToRecipes(ownerId, onChange, onError) {
  const q = query(RECIPES, where('ownerId', '==', ownerId), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    onChange(list);
  }, onError);
}

// fields : { title, category, timeMinutes, servings, ingredients, steps,
//            photoUrl, photoPath }  — les deux derniers = valeurs courantes
// (celles de la recette existante en edition, ou null pour une creation).
// photoFile : File|null, la nouvelle photo choisie (remplace l'existante).
export async function saveRecipe(ownerId, recipeId, fields, photoFile) {
  let photoUrl = fields.photoUrl ?? null;
  let photoPath = fields.photoPath ?? null;
  let photoError = null;

  if (photoFile) {
    if (!navigator.onLine) {
      photoError = new Error('offline');
    } else {
      try {
        const blob = await resizeImage(photoFile, MAX_DIM, JPEG_QUALITY);
        const path = `recipes/${ownerId}/${randomId()}.jpg`;
        const fileRef = ref(storage, path);
        await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
        const newUrl = await getDownloadURL(fileRef);
        const oldPath = photoPath;
        photoUrl = newUrl;
        photoPath = path;
        if (oldPath) deleteObject(ref(storage, oldPath)).catch(() => {});
      } catch (err) {
        photoError = err; // on garde l'ancienne photo (ou aucune)
      }
    }
  }

  const payload = {
    ownerId,
    title: fields.title,
    category: fields.category,
    timeMinutes: fields.timeMinutes,
    servings: fields.servings,
    ingredients: fields.ingredients,
    steps: fields.steps,
    photoUrl,
    photoPath,
    updatedAt: serverTimestamp(),
  };

  let id = recipeId;
  if (id) {
    await updateDoc(doc(db, 'recipes', id), payload);
  } else {
    payload.sharedWith = [];
    payload.createdAt = serverTimestamp();
    const created = await addDoc(RECIPES, payload);
    id = created.id;
  }

  return { id, photoError };
}

export async function deleteRecipe(recipeId, photoPath) {
  await deleteDoc(doc(db, 'recipes', recipeId));
  if (photoPath) {
    try { await deleteObject(ref(storage, photoPath)); } catch (_err) { /* best effort */ }
  }
}

function randomId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
}

// Redimensionne + recompresse cote client avant upload : photos de bonne
// qualite sans gonfler inutilement le stockage / la bande passante.
function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob a echoue'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')); };
    img.src = url;
  });
}
