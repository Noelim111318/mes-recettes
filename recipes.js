/* Mes Recettes — CRUD Firestore + photos Storage.
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
  addDoc, updateDoc, deleteDoc, doc,
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

// Ancien format (v1.1.0 et avant) : une seule photo dans photoUrl/photoPath.
// Convertit a la volee vers le format tableau, sans migration Firestore.
export function recipePhotos(recipe) {
  if (recipe.photos) return recipe.photos;
  if (recipe.photoUrl) return [{ url: recipe.photoUrl, path: recipe.photoPath || null }];
  return [];
}

// fields : { title, category, prepMinutes, cookMinutes, servings, difficulty,
//            budget, season, diets, conservationDays, note, ingredients,
//            steps, photos }  — `photos` = les photos conservees (deja
// existantes, moins celles retirees dans le formulaire).
// newPhotoFiles : File[], nouvelles photos a uploader et ajouter.
// removedPhotoPaths : string[], chemins Storage des photos retirees (a
// supprimer apres l'ecriture reussie du document).
export async function saveRecipe(ownerId, recipeId, fields, newPhotoFiles, removedPhotoPaths) {
  const photos = (fields.photos || []).slice();
  let photoError = null;

  if (newPhotoFiles && newPhotoFiles.length) {
    if (!navigator.onLine) {
      photoError = new Error('offline');
    } else {
      for (const file of newPhotoFiles) {
        try {
          const blob = await resizeImage(file, MAX_DIM, JPEG_QUALITY);
          const path = `recipes/${ownerId}/${randomId()}.jpg`;
          const fileRef = ref(storage, path);
          await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
          const url = await getDownloadURL(fileRef);
          photos.push({ url, path });
        } catch (err) {
          photoError = err; // on garde ce qui a deja ete envoye avant l'echec
          break;
        }
      }
    }
  }

  const payload = {
    ownerId,
    title: fields.title,
    category: fields.category,
    prepMinutes: fields.prepMinutes,
    cookMinutes: fields.cookMinutes,
    servings: fields.servings,
    difficulty: fields.difficulty,
    budget: fields.budget,
    season: fields.season,
    diets: fields.diets,
    conservationDays: fields.conservationDays,
    note: fields.note,
    ingredients: fields.ingredients,
    steps: fields.steps,
    photos,
    // Horodatage client (pas serverTimestamp) : resout immediatement dans le
    // cache local, y compris hors-ligne, pour que la liste (triee dessus)
    // se remette a jour tout de suite au lieu d'attendre l'aller-retour
    // serveur (pendant lequel un serverTimestamp() reste `null`, donc trie
    // en dernier au lieu d'apparaitre en tete).
    updatedAt: Date.now(),
  };

  let id = recipeId;
  if (id) {
    await updateDoc(doc(db, 'recipes', id), payload);
  } else {
    payload.sharedWith = [];
    payload.createdAt = Date.now();
    const created = await addDoc(RECIPES, payload);
    id = created.id;
  }

  (removedPhotoPaths || []).forEach((p) => { if (p) deleteObject(ref(storage, p)).catch(() => {}); });

  return { id, photoError };
}

export async function deleteRecipe(recipeId, photos) {
  await deleteDoc(doc(db, 'recipes', recipeId));
  (photos || []).forEach((p) => {
    if (p && p.path) deleteObject(ref(storage, p.path)).catch(() => {});
  });
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
