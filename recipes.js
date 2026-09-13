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
// 1600px suffit a l'ecran mais pas a l'impression (a peine ~13 cm de large a
// 300 dpi). 3000px couvre une pleine page de livre (jusqu'a ~25 cm a 300
// dpi) tout en restant tres loin des quotas gratuits (5 Go = ~1700 photos a
// cette taille/qualite).
const MAX_DIM = 3000;
const JPEG_QUALITY = 0.9;
// Miniature dediee (cartes de la liste, galerie du formulaire) : bien plus
// legere que la photo pleine taille, pour ne pas la telecharger juste pour
// l'afficher en 88px de cote.
const THUMB_DIM = 320;
const THUMB_QUALITY = 0.6;

export function subscribeToRecipes(ownerId, onChange, onError) {
  // Tri alphabetique stable : un ordre par derniere modification changeait a
  // chaque edition, ce qui rendait la liste imprevisible d'une visite a
  // l'autre.
  const q = query(RECIPES, where('ownerId', '==', ownerId), orderBy('title'));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    onChange(list);
  }, onError);
}

// Toutes les recettes, tous comptes confondus — reserve a l'admin cote
// regles Firestore (lecture seule) ; un compte non admin recoit une erreur
// de permission si cette requete est lancee.
export function subscribeToAllRecipes(onChange, onError) {
  const q = query(RECIPES, orderBy('title'));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    onChange(list);
  }, onError);
}

// Ancien format (v1.1.0 et avant, ou photos envoyees avant l'ajout des
// miniatures) : normalise vers { url, path, thumbUrl, thumbPath }, avec la
// photo pleine taille en repli si aucune miniature dediee n'existe.
export function recipePhotos(recipe) {
  let list;
  if (recipe.photos) list = recipe.photos;
  else if (recipe.photoUrl) list = [{ url: recipe.photoUrl, path: recipe.photoPath || null }];
  else list = [];
  return list.map((p) => ({
    url: p.url,
    path: p.path || null,
    thumbUrl: p.thumbUrl || p.url,
    thumbPath: p.thumbPath || null,
  }));
}

// fields : { title, category, prepMinutes, cookMinutes, servings, difficulty,
//            budget, season, diets, conservationDays, note, ingredients,
//            steps, photos }  — `photos` = les photos conservees (deja
// existantes, moins celles retirees dans le formulaire).
// newPhotoFiles : File[], nouvelles photos a uploader et ajouter.
// removedPhotos : { path, thumbPath }[], photos retirees (supprimees du
// Storage apres l'ecriture reussie du document).
export async function saveRecipe(ownerId, recipeId, fields, newPhotoFiles, removedPhotos) {
  const photos = (fields.photos || []).slice();
  let photoError = null;

  if (newPhotoFiles && newPhotoFiles.length) {
    if (!navigator.onLine) {
      photoError = new Error('offline');
    } else {
      for (const file of newPhotoFiles) {
        try {
          const [fullBlob, thumbBlob] = await resizeImageVariants(file, [
            { maxDim: MAX_DIM, quality: JPEG_QUALITY },
            { maxDim: THUMB_DIM, quality: THUMB_QUALITY },
          ]);
          const id = randomId();
          const path = `recipes/${ownerId}/${id}.jpg`;
          const thumbPath = `recipes/${ownerId}/${id}-thumb.jpg`;
          await uploadBytes(ref(storage, path), fullBlob, { contentType: 'image/jpeg' });
          await uploadBytes(ref(storage, thumbPath), thumbBlob, { contentType: 'image/jpeg' });
          const url = await getDownloadURL(ref(storage, path));
          const thumbUrl = await getDownloadURL(ref(storage, thumbPath));
          photos.push({ url, path, thumbUrl, thumbPath });
        } catch (err) {
          photoError = err; // on garde ce qui a deja ete envoye avant l'echec
          break;
        }
      }
    }
  }

  const payload = {
    ownerId,
    // Denormalise depuis auth.currentUser.email : evite d'avoir a resoudre
    // un uid -> e-mail cote client (l'Admin SDK necessaire pour ca n'est
    // pas accessible depuis le navigateur) pour la vue admin.
    ownerEmail: fields.ownerEmail || '',
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

  (removedPhotos || []).forEach((p) => {
    if (p.path) deleteObject(ref(storage, p.path)).catch(() => {});
    if (p.thumbPath) deleteObject(ref(storage, p.thumbPath)).catch(() => {});
  });

  return { id, photoError };
}

export async function deleteRecipe(recipeId, photos) {
  await deleteDoc(doc(db, 'recipes', recipeId));
  (photos || []).forEach((p) => {
    if (p && p.path) deleteObject(ref(storage, p.path)).catch(() => {});
    if (p && p.thumbPath) deleteObject(ref(storage, p.thumbPath)).catch(() => {});
  });
}

function randomId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')); };
    img.src = url;
  });
}

function drawToBlob(img, maxDim, quality) {
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
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob a echoue'))), 'image/jpeg', quality);
  });
}

// Decode l'image une seule fois, en tire plusieurs variantes (pleine taille +
// miniature) : evite de redecoder le fichier source pour chaque taille.
async function resizeImageVariants(file, variants) {
  const { img, url } = await loadImage(file);
  try {
    const blobs = [];
    for (const v of variants) blobs.push(await drawToBlob(img, v.maxDim, v.quality));
    return blobs;
  } finally {
    URL.revokeObjectURL(url);
  }
}
