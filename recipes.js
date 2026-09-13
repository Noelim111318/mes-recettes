/* Mes Recettes — CRUD Firestore + photos Storage.
 *
 * Isolation par utilisatrice : chaque recette porte un `ownerId`, la requete
 * liste filtre dessus, et les regles Firestore (firestore.rules) refusent
 * tout acces a un document dont on n'est pas proprietaire — sauf lecture
 * pour l'admin et les comptes listes dans `sharedWith`, qui peuvent en plus
 * chacun modifier leur propre entree dans `favoritedBy` et se retirer eux-
 * memes de `sharedWith` (voir firestore.rules).
 */
import { db, storage } from './firebase-init.js';
import {
  collection, query, where, orderBy, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, setDoc,
  arrayUnion, arrayRemove, limit,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject, getMetadata,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

const RECIPES = collection(db, 'recipes');
const USERS = collection(db, 'users');
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

// Recettes qu'une autre utilisatrice a partagees avec moi (lecture seule,
// comme la vue admin).
export function subscribeToSharedWithMe(uid, onChange, onError) {
  const q = query(RECIPES, where('sharedWith', 'array-contains', uid), orderBy('title'));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    onChange(list);
  }, onError);
}

/* ---------------------------------------------------- Annuaire / partage */
// A appeler une fois par connexion : garde a jour uid -> e-mail, necessaire
// pour retrouver l'uid d'une personne a partir de son e-mail (l'Admin SDK
// qui permettrait de le faire directement n'est pas accessible cote
// navigateur).
export function upsertUserProfile(uid, email) {
  return setDoc(doc(USERS, uid), { email: email || '' }, { merge: true });
}

// Retrouve l'uid d'une utilisatrice a partir de son e-mail exact (sensible a
// la casse telle qu'enregistree par Firebase Auth, generalement en
// minuscules). Renvoie null si personne ne correspond.
export async function findUserByEmail(email) {
  const q = query(USERS, where('email', '==', email), limit(1));
  const snap = await getDocs(q);
  return snap.empty ? null : snap.docs[0].id;
}

export async function getUserEmail(uid) {
  const snap = await getDoc(doc(USERS, uid));
  return snap.exists() ? (snap.data().email || '') : '';
}

export function shareRecipeWith(recipeId, uid) {
  return updateDoc(doc(db, 'recipes', recipeId), { sharedWith: arrayUnion(uid) });
}

export function unshareRecipeWith(recipeId, uid) {
  return updateDoc(doc(db, 'recipes', recipeId), { sharedWith: arrayRemove(uid) });
}

// Favori par personne (proprietaire ou destinataire d'un partage) : chacune
// marque/demarque sa propre entree dans `favoritedBy`, jamais un booleen
// unique qui n'aurait eu de sens que pour la proprietaire.
export function toggleFavorite(recipeId, uid, value) {
  return updateDoc(doc(db, 'recipes', recipeId), {
    favoritedBy: value ? arrayUnion(uid) : arrayRemove(uid),
  });
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
    // Absent sur les photos envoyees avant ce champ : 0 ici, recalcule a la
    // volee depuis Storage par fetchLegacyPhotoSize quand necessaire (voir
    // updateAdminUsage dans app.js).
    sizeBytes: p.sizeBytes || 0,
  }));
}

// Taille reelle (pleine + miniature) d'une photo envoyee avant l'ajout du
// champ `sizeBytes` : son document Firestore ne la connait pas, donc on la
// redemande a Storage. Reserve a l'estimation admin (getMetadata est une
// lecture, autorisee a l'admin par storage.rules comme la lecture
// Firestore) ; en best-effort, une photo introuvable compte pour 0 plutot
// que de faire echouer toute l'estimation.
export async function fetchLegacyPhotoSize(path, thumbPath) {
  let total = 0;
  for (const p of [path, thumbPath]) {
    if (!p) continue;
    try {
      const meta = await getMetadata(ref(storage, p));
      total += meta.size || 0;
    } catch (err) { /* photo supprimee entre-temps, ou introuvable : ignore */ }
  }
  return total;
}

// fields : { title, category, prepMinutes, cookMinutes, servings, difficulty,
//            budget, season, diets, conservationDays, note, ingredients,
//            steps }.
// orderedPhotos : dans l'ordre d'affichage voulu (le 1er = couverture) —
// { kept: {url,path,thumbUrl,thumbPath} } pour une photo deja envoyee, ou
// { file: File } pour une nouvelle a uploader. L'ordre est preserve dans le
// document final : une nouvelle photo peut devenir couverture meme s'il y a
// deja des photos existantes.
// removedPhotos : { path, thumbPath }[], photos retirees (supprimees du
// Storage apres l'ecriture reussie du document).
export async function saveRecipe(ownerId, recipeId, fields, orderedPhotos, removedPhotos) {
  const photos = [];
  let photoError = null;
  const online = navigator.onLine;

  for (const item of (orderedPhotos || [])) {
    if (item.kept) {
      photos.push(item.kept);
      continue;
    }
    if (!online) {
      if (!photoError) photoError = new Error('offline');
      continue;
    }
    try {
      const [fullBlob, thumbBlob] = await resizeImageVariants(item.file, [
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
      photos.push({ url, path, thumbUrl, thumbPath, sizeBytes: fullBlob.size + thumbBlob.size });
    } catch (err) {
      if (!photoError) photoError = err; // on garde ce qui a deja ete envoye avant l'echec
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
    payload.favoritedBy = [];
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
