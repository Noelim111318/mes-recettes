/* Mes Recettes — logique de l'app.
 * La coque PWA (service worker, bandeau installer, ecrans, a11y) vient
 * d'AppEngine (engine/engine.js). Ici : cablage des 4 ecrans + Firebase.
 */
import {
  watchAuth, signUp, signIn, logOut, resetPassword, authErrorMessage,
  signInWithGoogle, consumeRedirectError,
} from './auth.js';
import { subscribeToRecipes, saveRecipe, deleteRecipe, recipePhotos } from './recipes.js';
import { resetLocalPersistence } from './firebase-init.js';

var APP_VERSION = 'v1.3.2';
var E = window.AppEngine;
var DATA = window.APP_DATA || {};

E.boot({
  id: 'mes-recettes',
  version: APP_VERSION,
  stars: false,            // fond etoile hors-sujet pour un carnet de recettes
  streakBadgeSel: false,   // pas de serie/streak ici
  backButton: true,
});

// Ecran affiche par defaut tant que l'etat d'auth n'est pas connu (deja
// "active" dans le HTML) : synchronise l'etat interne du moteur avec ca.
E.screens.show('screen-auth', { push: false });

// Retour materiel au-dela du 1er ecran empile : pas d'etat memorise -> accueil.
E.on('screen:back', function () { E.screens.show('screen-home', { push: false }); });

/* ---------------------------------------------------------------- Etat */
var currentUser = null;
var recipes = [];
var unsubscribeRecipes = null;
var authMode = 'signin';
var editingRecipe = null;
var viewingRecipe = null;
var formReturnScreen = 'screen-home';
var newPhotoFiles = [];       // File[] nouvellement choisis, pas encore uploades
var keptPhotos = [];          // photos existantes conservees ({url, path}[])
var removedPhotos = [];       // photos retirees ({path, thumbPath}[])

/* --------------------------------------------------------- Utilitaires */
function showError(sel, msg) { var el = E.$(sel); el.textContent = msg; el.hidden = false; }
function hideError(sel) { var el = E.$(sel); el.hidden = true; el.textContent = ''; }
function normalizeCategory(s) {
  s = (s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

/* ----------------------------------------------- Nombres en toutes lettres */
// La reconnaissance vocale transcrit "trois oeufs" tel quel au lieu de
// "3 oeufs" : on convertit les nombres ecrits en toutes lettres (0-99, plus
// les centaines) en chiffres apres la dictee. Couvre les quantites d'une
// recette ; pas d'ambition de parser le francais au-dela de ca.
function buildFrNumberMap() {
  var units = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
    'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
  var map = { une: 1 };
  units.forEach(function (w, i) { map[w] = i; });
  map['dix-sept'] = 17; map['dix-huit'] = 18; map['dix-neuf'] = 19;

  function teenWord(n) {
    if (n <= 16) return units[n];
    return n === 17 ? 'dix-sept' : n === 18 ? 'dix-huit' : 'dix-neuf';
  }

  [['vingt', 20], ['trente', 30], ['quarante', 40], ['cinquante', 50], ['soixante', 60]].forEach(function (t) {
    map[t[0]] = t[1];
    for (var u = 1; u <= 9; u++) map[t[0] + (u === 1 ? '-et-un' : '-' + units[u])] = t[1] + u;
  });
  map['soixante-dix'] = 70;
  map['soixante-et-onze'] = 71;
  for (var n1 = 72; n1 <= 79; n1++) map['soixante-' + teenWord(n1 - 60)] = n1;
  map['quatre-vingts'] = 80;
  map['quatre-vingt'] = 80;
  for (var n2 = 81; n2 <= 89; n2++) map['quatre-vingt-' + units[n2 - 80]] = n2;
  for (var n3 = 90; n3 <= 99; n3++) map['quatre-vingt-' + teenWord(n3 - 80)] = n3;
  return map;
}
var FR_NUMBER_MAP = buildFrNumberMap();
var FR_NUMBER_KEYS = Object.keys(FR_NUMBER_MAP).sort(function (a, b) {
  return b.split(/[\s-]+/).length - a.split(/[\s-]+/).length || b.length - a.length;
});
// Chaque mot-cle peut apparaitre tel quel (trait d'union) ou avec des
// espaces (la reconnaissance vocale ne met pas toujours les traits d'union).
var FR_NUMBER_RE = new RegExp('\\b(' + FR_NUMBER_KEYS.map(function (k) {
  return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]');
}).join('|') + ')\\b', 'gi');

function frNumbersToDigits(text) {
  var out = text.replace(FR_NUMBER_RE, function (m) {
    var key = m.toLowerCase().replace(/\s+/g, '-');
    return FR_NUMBER_MAP.hasOwnProperty(key) ? String(FR_NUMBER_MAP[key]) : m;
  });
  // Centaines : "trois cents", "cent cinquante", "cent" seul...
  out = out.replace(/\b(\d+\s+)?cents?\b(\s+\d+)?/gi, function (m, prefix, suffix) {
    var hundreds = prefix ? parseInt(prefix, 10) : 1;
    var rest = suffix ? parseInt(suffix, 10) : 0;
    return String(hundreds * 100 + rest);
  });
  return out;
}

/* -------------------------------------------------------- Dictee (micro) */
// Les claviers mobiles ont deja un micro integre, mais il n'est pas garanti
// actif partout (reglage iOS, etc.) : ce bouton dicte directement dans le
// champ via l'API Web Speech, quand le navigateur la supporte.
var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
function attachMic(input, btn) {
  if (!input || !btn) return;
  if (!SpeechRecognitionCtor) { btn.remove(); return; }
  btn.hidden = false;
  var recognition = null;
  var listening = false;
  btn.addEventListener('click', function () {
    if (listening) { if (recognition) recognition.stop(); return; }
    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'fr-FR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = function () { listening = true; btn.classList.add('mic-btn--on'); };
    recognition.onend = function () { listening = false; btn.classList.remove('mic-btn--on'); };
    recognition.onerror = function () { listening = false; btn.classList.remove('mic-btn--on'); };
    recognition.onresult = function (e) {
      var transcript = frNumbersToDigits(e.results[0][0].transcript);
      var sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
      input.value = input.value ? input.value + sep + transcript : transcript;
      // Pas de input.focus() ici : ça rouvrirait le clavier juste apres avoir dicte.
    };
    recognition.start();
  });
}
attachMic(E.$('#field-title'), E.$('#field-title-mic'));
attachMic(E.$('#field-category'), E.$('#field-category-mic'));
attachMic(E.$('#field-note'), E.$('#field-note-mic'));

/* ------------------------------------------------------- Notation (etoiles) */
function setRating(containerEl, val) {
  containerEl.dataset.value = val;
  Array.prototype.forEach.call(containerEl.querySelectorAll('.rating-btn'), function (btn) {
    btn.classList.toggle('rating-btn--on', Number(btn.dataset.val) <= val);
  });
}
function getRating(containerEl) { return Number(containerEl.dataset.value || 0); }
function wireRating(containerEl) {
  containerEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.rating-btn');
    if (!btn) return;
    var val = Number(btn.dataset.val);
    setRating(containerEl, getRating(containerEl) === val ? 0 : val);
  });
}
wireRating(E.$('#field-difficulty'));
wireRating(E.$('#field-budget'));

/* ------------------------------------------------------------- Regime */
function setDiets(containerEl, values) {
  Array.prototype.forEach.call(containerEl.querySelectorAll('input[type="checkbox"]'), function (cb) {
    cb.checked = values.indexOf(cb.value) !== -1;
  });
}
function getDiets(containerEl) {
  return Array.prototype.filter.call(containerEl.querySelectorAll('input[type="checkbox"]'), function (cb) {
    return cb.checked;
  }).map(function (cb) { return cb.value; });
}

function addDynamicRow(containerEl, placeholder, value) {
  var row = document.createElement('div');
  row.className = 'dynamic-list-row';

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input';
  input.placeholder = placeholder;
  input.value = value || '';

  var micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'mic-btn';
  micBtn.setAttribute('aria-label', 'Dicter cette ligne');
  micBtn.textContent = '🎤';
  micBtn.hidden = true;

  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'dynamic-list-remove';
  removeBtn.setAttribute('aria-label', 'Supprimer cette ligne');
  removeBtn.textContent = '×';

  row.appendChild(input);
  row.appendChild(micBtn);
  row.appendChild(removeBtn);
  containerEl.appendChild(row);
  attachMic(input, micBtn);
  return input;
}

function resetDynamicList(containerEl, placeholder, values) {
  containerEl.textContent = '';
  var list = (values && values.length) ? values : [''];
  list.forEach(function (v) { addDynamicRow(containerEl, placeholder, v); });
}

function collectDynamicList(containerEl) {
  return Array.prototype.map.call(containerEl.querySelectorAll('input'), function (i) {
    return i.value.trim();
  }).filter(Boolean);
}

function wireDynamicListRemoval(containerEl) {
  containerEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.dynamic-list-remove');
    if (!btn) return;
    var row = btn.closest('.dynamic-list-row');
    if (containerEl.children.length > 1) {
      row.remove();
    } else {
      row.querySelector('input').value = '';
    }
  });
}
wireDynamicListRemoval(E.$('#ingredients-list'));
wireDynamicListRemoval(E.$('#steps-list'));

E.$('#add-ingredient-btn').addEventListener('click', function () {
  addDynamicRow(E.$('#ingredients-list'), 'ex. 200 g de farine', '').focus();
});
E.$('#add-step-btn').addEventListener('click', function () {
  addDynamicRow(E.$('#steps-list'), 'Décris cette étape…', '').focus();
});

// Suggestions de categories (datalist du formulaire).
(function fillCategorySuggestions() {
  var datalist = E.$('#category-suggestions');
  (DATA.categorySuggestions || []).forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c;
    datalist.appendChild(opt);
  });
})();

var SEASON_LABELS = { printemps: 'Printemps', ete: 'Été', automne: 'Automne', hiver: 'Hiver' };
var DIET_LABELS = {
  'sans-gluten': 'Sans gluten', 'sans-lactose': 'Sans lactose',
  'vegetarien': 'Végétarien', 'vegan': 'Végan',
};

function chipsFor(recipe) {
  var chips = [];
  if (recipe.category) chips.push(recipe.category);
  var totalMin = (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0);
  if (totalMin) chips.push(totalMin + ' min');
  if (recipe.servings) chips.push(recipe.servings + ' pers.');
  if (recipe.difficulty) chips.push('★'.repeat(recipe.difficulty));
  if (recipe.budget) chips.push('€'.repeat(recipe.budget));
  if (recipe.season) chips.push(SEASON_LABELS[recipe.season] || recipe.season);
  (recipe.diets || []).forEach(function (d) { chips.push(DIET_LABELS[d] || d); });
  if (recipe.conservationDays) chips.push('Se conserve ' + recipe.conservationDays + ' j');
  return chips;
}

function renderChips(el, chips) {
  el.textContent = '';
  chips.forEach(function (c) {
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = c;
    el.appendChild(chip);
  });
}

function fillList(el, items) {
  el.textContent = '';
  (items || []).forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    el.appendChild(li);
  });
}

/* ------------------------------------------------------- Hors-ligne (UI) */
function updateOfflineBadge() {
  E.$('#offline-badge').hidden = navigator.onLine;
}
window.addEventListener('online', function () {
  updateOfflineBadge();
  E.announce('Connexion rétablie, synchronisation en cours.');
});
window.addEventListener('offline', function () {
  updateOfflineBadge();
  E.announce('Hors-ligne : tes modifications seront synchronisées au retour du réseau.', true);
});
updateOfflineBadge();

/* --------------------------------------------------------------- Liste */
var savedSearch = E.store.load('lastSearch', '');
if (savedSearch) E.$('#search-input').value = savedSearch;

function updateCategoryOptions() {
  var select = E.$('#category-filter');
  var current = select.value;
  // Regroupe sans tenir compte de la casse ("Dessert" et "dessert" comptent
  // pour une seule categorie), en gardant la 1re graphie rencontree.
  var seen = {};
  var cats = [];
  recipes.forEach(function (r) {
    var c = r.category;
    if (!c) return;
    var key = c.toLowerCase();
    if (!seen[key]) { seen[key] = true; cats.push(c); }
  });
  cats.sort(function (a, b) { return a.localeCompare(b, 'fr'); });

  select.textContent = '';
  var allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Toutes';
  select.appendChild(allOpt);
  cats.forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  });
  if (cats.indexOf(current) !== -1) select.value = current;
}

function renderRecipeCard(recipe) {
  var card = document.createElement('button');
  card.type = 'button';
  card.className = 'recipe-card';

  var photos = recipePhotos(recipe);
  if (photos.length) {
    var img = document.createElement('img');
    img.className = 'recipe-card-photo';
    img.src = photos[0].thumbUrl;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  } else {
    var ph = document.createElement('div');
    ph.className = 'recipe-card-photo recipe-card-photo--empty';
    ph.textContent = '🍽️';
    card.appendChild(ph);
  }

  var body = document.createElement('div');
  body.className = 'recipe-card-body';
  var title = document.createElement('div');
  title.className = 'recipe-card-title';
  title.textContent = recipe.title;
  body.appendChild(title);

  var meta = document.createElement('div');
  meta.className = 'chip-row';
  renderChips(meta, chipsFor(recipe));
  body.appendChild(meta);
  card.appendChild(body);

  card.addEventListener('click', function () { openDetail(recipe); });
  return card;
}

function renderList() {
  var list = E.$('#recipe-list');
  var empty = E.$('#empty-state');
  var search = (E.$('#search-input').value || '').trim().toLowerCase();
  var category = E.$('#category-filter').value;

  var categoryLower = category.toLowerCase();
  var filtered = recipes.filter(function (r) {
    var matchSearch = !search || (r.title || '').toLowerCase().indexOf(search) !== -1;
    var matchCat = !category || (r.category || '').toLowerCase() === categoryLower;
    return matchSearch && matchCat;
  });

  list.textContent = '';
  filtered.forEach(function (r) { list.appendChild(renderRecipeCard(r)); });

  if (filtered.length === 0) {
    empty.hidden = false;
    empty.textContent = recipes.length === 0
      ? 'Aucune recette pour l’instant — ajoute la première !'
      : 'Aucune recette ne correspond à ta recherche.';
  } else {
    empty.hidden = true;
  }

  E.store.save('lastSearch', E.$('#search-input').value);
}

E.$('#search-input').addEventListener('input', renderList);
E.$('#category-filter').addEventListener('change', renderList);
E.$('#new-recipe-btn').addEventListener('click', function () { openForm(null, 'screen-home'); });
E.$('#logout-btn').addEventListener('click', function () { logOut(); });

/* ---------------------------------------------------------------- Detail */
function openDetail(recipe) {
  viewingRecipe = recipe;

  var photosWrap = E.$('#detail-photos');
  var photos = recipePhotos(recipe);
  photosWrap.textContent = '';
  if (photos.length) {
    photos.forEach(function (p) {
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      img.loading = 'lazy';
      photosWrap.appendChild(img);
    });
    photosWrap.hidden = false;
  } else {
    photosWrap.hidden = true;
  }

  E.$('#detail-title').textContent = recipe.title;
  renderChips(E.$('#detail-meta'), chipsFor(recipe));
  fillList(E.$('#detail-ingredients'), recipe.ingredients);
  fillList(E.$('#detail-steps'), recipe.steps);

  var noteBlock = E.$('#detail-note-block');
  if (recipe.note) {
    E.$('#detail-note').textContent = recipe.note;
    noteBlock.hidden = false;
  } else {
    noteBlock.hidden = true;
  }

  E.screens.show('screen-detail', { push: true });
}

E.$('#detail-back-btn').addEventListener('click', function () {
  E.screens.show('screen-home', { push: true });
});
E.$('#detail-print-btn').addEventListener('click', function () {
  window.print();
});
E.$('#detail-edit-btn').addEventListener('click', function () {
  if (viewingRecipe) openForm(viewingRecipe, 'screen-detail');
});
E.$('#detail-delete-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  if (!window.confirm('Supprimer « ' + viewingRecipe.title + ' » ? Cette action est définitive.')) return;
  deleteRecipe(viewingRecipe.id, recipePhotos(viewingRecipe))
    .then(function () {
      E.announce('Recette supprimée.');
      renderList();
      E.screens.show('screen-home', { push: true });
    })
    .catch(function (err) {
      E.announce('Suppression impossible : ' + (err && err.message ? err.message : 'erreur.'), true);
    });
});

/* ------------------------------------------------------------ Formulaire */
function renderPhotoGallery() {
  var wrap = E.$('#photo-gallery');
  wrap.textContent = '';

  keptPhotos.forEach(function (p, idx) {
    wrap.appendChild(photoThumb(p.thumbUrl, function () {
      removedPhotos.push({ path: p.path, thumbPath: p.thumbPath });
      keptPhotos.splice(idx, 1);
      renderPhotoGallery();
    }));
  });
  newPhotoFiles.forEach(function (file, idx) {
    wrap.appendChild(photoThumb(URL.createObjectURL(file), function () {
      newPhotoFiles.splice(idx, 1);
      renderPhotoGallery();
    }));
  });
}

function photoThumb(src, onRemove) {
  var box = document.createElement('div');
  box.className = 'photo-thumb';
  var img = document.createElement('img');
  img.src = src;
  img.alt = '';
  var rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'photo-thumb-remove';
  rm.setAttribute('aria-label', 'Retirer cette photo');
  rm.textContent = '×';
  rm.addEventListener('click', onRemove);
  box.appendChild(img);
  box.appendChild(rm);
  return box;
}

function openForm(recipe, returnScreen) {
  editingRecipe = recipe || null;
  formReturnScreen = returnScreen || 'screen-home';
  newPhotoFiles = [];
  removedPhotos = [];
  keptPhotos = editingRecipe ? recipePhotos(editingRecipe).slice() : [];

  E.$('#form-title').textContent = editingRecipe ? 'Modifier la recette' : 'Nouvelle recette';
  E.$('#field-title').value = editingRecipe ? editingRecipe.title : '';
  E.$('#field-category').value = editingRecipe ? (editingRecipe.category || '') : '';
  E.$('#field-prep-time').value = (editingRecipe && editingRecipe.prepMinutes) ? editingRecipe.prepMinutes : '';
  E.$('#field-cook-time').value = (editingRecipe && editingRecipe.cookMinutes) ? editingRecipe.cookMinutes : '';
  E.$('#field-servings').value = (editingRecipe && editingRecipe.servings) ? editingRecipe.servings : '';
  setRating(E.$('#field-difficulty'), editingRecipe ? (editingRecipe.difficulty || 0) : 0);
  setRating(E.$('#field-budget'), editingRecipe ? (editingRecipe.budget || 0) : 0);
  E.$('#field-season').value = editingRecipe ? (editingRecipe.season || '') : '';
  E.$('#field-conservation').value = (editingRecipe && editingRecipe.conservationDays) ? editingRecipe.conservationDays : '';
  setDiets(E.$('#field-diets'), editingRecipe ? (editingRecipe.diets || []) : []);
  E.$('#field-note').value = editingRecipe ? (editingRecipe.note || '') : '';
  E.$('#field-photo').value = '';
  renderPhotoGallery();

  resetDynamicList(E.$('#ingredients-list'), 'ex. 200 g de farine', editingRecipe ? editingRecipe.ingredients : null);
  resetDynamicList(E.$('#steps-list'), 'Décris cette étape…', editingRecipe ? editingRecipe.steps : null);

  hideError('#form-error');
  E.screens.show('screen-form', { push: true });
}

E.$('#field-photo').addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files || []);
  newPhotoFiles = newPhotoFiles.concat(files);
  e.target.value = ''; // permet de re-choisir le meme fichier plus tard
  renderPhotoGallery();
});

E.$('#form-cancel-btn').addEventListener('click', function () {
  E.screens.show(formReturnScreen, { push: true });
});

E.$('#recipe-form').addEventListener('submit', function (e) {
  e.preventDefault();
  hideError('#form-error');

  var title = E.$('#field-title').value.trim();
  var ingredients = collectDynamicList(E.$('#ingredients-list'));
  var steps = collectDynamicList(E.$('#steps-list'));

  if (!title) return showError('#form-error', 'Le titre est obligatoire.');
  if (ingredients.length === 0) return showError('#form-error', 'Ajoute au moins un ingrédient.');
  if (steps.length === 0) return showError('#form-error', 'Ajoute au moins une étape.');

  var fields = {
    title: title,
    category: normalizeCategory(E.$('#field-category').value),
    prepMinutes: Number(E.$('#field-prep-time').value) || 0,
    cookMinutes: Number(E.$('#field-cook-time').value) || 0,
    servings: Number(E.$('#field-servings').value) || 0,
    difficulty: getRating(E.$('#field-difficulty')),
    budget: getRating(E.$('#field-budget')),
    season: E.$('#field-season').value,
    conservationDays: Number(E.$('#field-conservation').value) || 0,
    diets: getDiets(E.$('#field-diets')),
    note: E.$('#field-note').value.trim(),
    ingredients: ingredients,
    steps: steps,
    photos: keptPhotos,
  };

  var submitBtn = E.$('#form-submit-btn');
  submitBtn.disabled = true;

  saveRecipe(currentUser, editingRecipe ? editingRecipe.id : null, fields, newPhotoFiles, removedPhotos)
    .then(function (result) {
      submitBtn.disabled = false;
      if (result.photoError) {
        E.announce('Recette enregistrée. Certaines photos n’ont pas pu être envoyées (hors-ligne ou erreur réseau) : réessaie en modifiant la recette une fois reconnecté.', true);
      } else {
        E.announce('Recette enregistrée.');
      }
      renderList();
      E.screens.show('screen-home', { push: true });
    })
    .catch(function (err) {
      submitBtn.disabled = false;
      showError('#form-error', "Impossible d'enregistrer : " + (err && err.message ? err.message : 'erreur inconnue.'));
    });
});

/* -------------------------------------------------- Recettes (Firestore) */
// Filet de securite pour un conflit de persistence locale (ex. changement de
// configuration Firestore d'une version a l'autre) : efface le cache local
// (sans danger, aucune donnee n'y vit reellement) et recharge une seule fois
// par session, plutot que de laisser l'app bloquee.
function recoverFromPersistenceError(err) {
  if (sessionStorage.getItem('mr-recovered') === '1') {
    E.announce('Erreur de synchronisation persistante : ' + (err && err.message ? err.message : ''), true);
    return;
  }
  sessionStorage.setItem('mr-recovered', '1');
  resetLocalPersistence().then(function () { location.reload(); });
}

function startRecipesSubscription(uid) {
  stopRecipesSubscription();
  try {
    unsubscribeRecipes = subscribeToRecipes(uid, function (list) {
      recipes = list;
      updateCategoryOptions();
      renderList();
    }, function (err) {
      recoverFromPersistenceError(err);
    });
  } catch (err) {
    recoverFromPersistenceError(err);
  }
}
function stopRecipesSubscription() {
  if (unsubscribeRecipes) { unsubscribeRecipes(); unsubscribeRecipes = null; }
  recipes = [];
}

/* --------------------------------------------------------------- Auth */
function setAuthMode(mode) {
  authMode = mode;
  E.$('#auth-submit').textContent = mode === 'signup' ? 'Créer le compte' : 'Se connecter';
  E.$('#auth-toggle').textContent = mode === 'signup' ? 'Déjà un compte ? Connecte-toi' : 'Pas de compte ? Crée-en un';
}

E.$('#auth-toggle').addEventListener('click', function () {
  setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
});

E.$('#auth-google-btn').addEventListener('click', function () {
  hideError('#auth-error');
  signInWithGoogle().catch(function (err) { showError('#auth-error', authErrorMessage(err)); });
});

E.$('#auth-forgot').addEventListener('click', function () {
  var email = E.$('#auth-email').value.trim();
  if (!email) { showError('#auth-error', 'Renseigne ton e-mail puis clique à nouveau.'); return; }
  hideError('#auth-error');
  resetPassword(email)
    .then(function () { E.announce('E-mail de réinitialisation envoyé si ce compte existe.', true); })
    .catch(function (err) { showError('#auth-error', authErrorMessage(err)); });
});

E.$('#auth-form').addEventListener('submit', function (e) {
  e.preventDefault();
  hideError('#auth-error');
  var email = E.$('#auth-email').value.trim();
  var password = E.$('#auth-password').value;
  var submitBtn = E.$('#auth-submit');
  submitBtn.disabled = true;
  var action = authMode === 'signup' ? signUp(email, password) : signIn(email, password);
  action
    .catch(function (err) { showError('#auth-error', authErrorMessage(err)); })
    .then(function () { submitBtn.disabled = false; });
});

consumeRedirectError().then(function (err) {
  if (err) showError('#auth-error', authErrorMessage(err));
});

watchAuth(function (user) {
  if (user) {
    currentUser = user.uid;
    // L'ecran d'accueil s'affiche dans tous les cas : une erreur Firestore
    // (ex. conflit de persistence locale, gere dans startRecipesSubscription)
    // ne doit jamais bloquer la transition post-connexion.
    E.screens.show('screen-home', { push: false });
    startRecipesSubscription(currentUser);
  } else {
    currentUser = null;
    stopRecipesSubscription();
    E.$('#auth-form').reset();
    setAuthMode('signin');
    E.screens.show('screen-auth', { push: false });
  }
});
