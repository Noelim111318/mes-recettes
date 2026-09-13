/* Mes Recettes — logique de l'app.
 * La coque PWA (service worker, bandeau installer, ecrans, a11y) vient
 * d'AppEngine (engine/engine.js). Ici : cablage des 4 ecrans + Firebase.
 */
import {
  watchAuth, signUp, signIn, logOut, resetPassword, authErrorMessage,
  signInWithGoogle, consumeRedirectError,
} from './auth.js';
import {
  subscribeToRecipes, subscribeToAllRecipes, subscribeToSharedWithMe,
  saveRecipe, deleteRecipe, recipePhotos, toggleFavorite,
  upsertUserProfile, findUserByEmail, getUserEmail, shareRecipeWith, unshareRecipeWith,
} from './recipes.js';

// Doit rester identique a l'UID code en dur dans firestore.rules
// (isAdmin()) : la vraie securite vient des regles, ceci ne sert qu'a
// afficher/masquer le bouton cote interface.
var ADMIN_UID = 'EwBMsqx4MGXHNHcPlkpb7StazJp2';

var APP_VERSION = 'v1.7.0';
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
var currentUserEmail = '';
var recipes = [];
var allRecipes = [];    // vue admin uniquement
var sharedRecipes = []; // vue "partage avec moi"
var unsubscribeRecipes = null;
var unsubscribeAllRecipes = null;
var unsubscribeShared = null;
var authMode = 'signin';
var editingRecipe = null;
var viewingRecipe = null;
var formReturnScreen = 'screen-home';
var detailReturnScreen = 'screen-home';
// Photos du formulaire, dans l'ordre d'affichage voulu (la 1re = couverture) :
// { kept: {url,path,thumbUrl,thumbPath} } pour une photo deja envoyee, ou
// { file: File } pour une nouvelle, pas encore uploadee.
var photoItems = [];
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

  var moveWrap = document.createElement('div');
  moveWrap.className = 'row-move';
  var upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'row-move-btn row-move-up';
  upBtn.setAttribute('aria-label', 'Monter cette ligne');
  upBtn.textContent = '▲';
  var downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'row-move-btn row-move-down';
  downBtn.setAttribute('aria-label', 'Descendre cette ligne');
  downBtn.textContent = '▼';
  moveWrap.appendChild(upBtn);
  moveWrap.appendChild(downBtn);

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
  row.appendChild(moveWrap);
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
    var row = e.target.closest('.dynamic-list-row');
    if (!row) return;

    if (e.target.closest('.dynamic-list-remove')) {
      if (containerEl.children.length > 1) {
        row.remove();
      } else {
        row.querySelector('input').value = '';
      }
    } else if (e.target.closest('.row-move-up')) {
      if (row.previousElementSibling) containerEl.insertBefore(row, row.previousElementSibling);
    } else if (e.target.closest('.row-move-down')) {
      if (row.nextElementSibling) containerEl.insertBefore(row.nextElementSibling, row);
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

// Favori propre a chaque personne (proprietaire ou destinataire d'un
// partage) : `favoritedBy` liste les uid concernes. Repli sur l'ancien
// booleen `favorite` (proprietaire uniquement) pour les recettes ecrites
// avant ce champ, jamais migre en base.
function isFavoritedByMe(recipe) {
  if (recipe.favoritedBy) return recipe.favoritedBy.indexOf(currentUser) !== -1;
  return !!recipe.favorite && recipe.ownerId === currentUser;
}

function chipsFor(recipe) {
  var chips = [];
  if (isFavoritedByMe(recipe)) chips.push('★ Favori');
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

// Partages entre la liste perso et la vue admin (memes options de
// recherche/filtre sur les deux ecrans).
function buildCategoryOptions(selectEl, list) {
  var current = selectEl.value;
  // Regroupe sans tenir compte de la casse ("Dessert" et "dessert" comptent
  // pour une seule categorie), en gardant la 1re graphie rencontree.
  var seen = {};
  var cats = [];
  list.forEach(function (r) {
    var c = r.category;
    if (!c) return;
    var key = c.toLowerCase();
    if (!seen[key]) { seen[key] = true; cats.push(c); }
  });
  cats.sort(function (a, b) { return a.localeCompare(b, 'fr'); });

  selectEl.textContent = '';
  var allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Toutes';
  selectEl.appendChild(allOpt);
  cats.forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    selectEl.appendChild(opt);
  });
  if (cats.indexOf(current) !== -1) selectEl.value = current;
}

// Decompose les caracteres accentues (e -> e + accent combinant) puis
// retire les accents : "gateau" retrouve "gâteau" sans que l'utilisatrice
// ait besoin de taper l'accent.
function foldAccents(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function filterRecipes(list, searchEl, categoryEl, favoritesEl, sharedEl) {
  var search = foldAccents((searchEl.value || '').trim().toLowerCase());
  var category = categoryEl.value;
  var categoryLower = category.toLowerCase();
  var favoritesOnly = !!(favoritesEl && favoritesEl.checked);
  var sharedOnly = !!(sharedEl && sharedEl.checked);
  return list.filter(function (r) {
    var matchSearch = !search || foldAccents((r.title || '').toLowerCase()).indexOf(search) !== -1;
    var matchCat = !category || (r.category || '').toLowerCase() === categoryLower;
    var matchFav = !favoritesOnly || isFavoritedByMe(r);
    var matchShared = !sharedOnly || !!r.__shared;
    return matchSearch && matchCat && matchFav && matchShared;
  });
}

// Mes recettes + celles partagees avec moi, fondues dans une seule liste
// (plus d'ecran separe) : chaque entree partagee porte `__shared` (marque au
// moment de la reception du snapshot, voir startSharedSubscription), utilise
// pour l'afficher avec l'e-mail de la proprietaire et pour le filtre dedie.
function combinedRecipes() {
  return recipes.concat(sharedRecipes);
}

function updateCategoryOptions() {
  buildCategoryOptions(E.$('#category-filter'), combinedRecipes());
}

function renderRecipeCard(recipe, returnScreen, showOwner) {
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

  var chips = chipsFor(recipe);
  if (showOwner && recipe.ownerEmail) chips.unshift(recipe.ownerEmail);
  var meta = document.createElement('div');
  meta.className = 'chip-row';
  renderChips(meta, chips);
  body.appendChild(meta);
  card.appendChild(body);

  card.addEventListener('click', function () { openDetail(recipe, returnScreen); });
  return card;
}

function renderList() {
  var list = E.$('#recipe-list');
  var empty = E.$('#empty-state');
  var all = combinedRecipes();
  var filtered = filterRecipes(all, E.$('#search-input'), E.$('#category-filter'), E.$('#favorites-filter'), E.$('#shared-filter'));

  list.textContent = '';
  filtered.forEach(function (r) { list.appendChild(renderRecipeCard(r, 'screen-home', !!r.__shared)); });

  if (filtered.length === 0) {
    empty.hidden = false;
    empty.textContent = all.length === 0
      ? 'Aucune recette pour l’instant — ajoute la première !'
      : 'Aucune recette ne correspond à ta recherche.';
  } else {
    empty.hidden = true;
  }

  E.store.save('lastSearch', E.$('#search-input').value);
}

E.$('#search-input').addEventListener('input', renderList);
E.$('#category-filter').addEventListener('change', renderList);
E.$('#favorites-filter').addEventListener('change', renderList);
E.$('#shared-filter').addEventListener('change', renderList);
E.$('#new-recipe-btn').addEventListener('click', function () { openForm(null, 'screen-home'); });
E.$('#logout-btn').addEventListener('click', function () { logOut(); });

/* -------------------------------------------------------------- Menu (⋮) */
(function wireMenu() {
  var toggleBtn = E.$('#menu-toggle-btn');
  var dropdown = E.$('#menu-dropdown');
  function close() { dropdown.hidden = true; toggleBtn.setAttribute('aria-expanded', 'false'); }
  toggleBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var opening = dropdown.hidden;
    dropdown.hidden = !opening;
    toggleBtn.setAttribute('aria-expanded', String(opening));
  });
  dropdown.addEventListener('click', function (e) { if (e.target.closest('button')) close(); });
  document.addEventListener('click', function (e) { if (!dropdown.hidden && !e.target.closest('.menu-wrap')) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();

/* ---------------------------------------------------------------- Detail */
function openDetail(recipe, returnScreen) {
  viewingRecipe = recipe;
  detailReturnScreen = returnScreen || 'screen-home';
  // Modifier/Supprimer/Partager restent reserves a la proprietaire de la
  // recette, meme pour l'admin qui parcourt en lecture seule (les regles
  // Firestore refuseraient de toute facon l'ecriture, mais autant ne pas
  // proposer un bouton qui echouerait).
  var isMine = recipe.ownerId === currentUser;
  var isShared = !isMine && (recipe.sharedWith || []).indexOf(currentUser) !== -1;
  E.$('#detail-owner-actions').hidden = !isMine;
  E.$('#detail-share-block').hidden = !isMine;
  E.$('#detail-shared-actions').hidden = !isShared;
  if (isMine) renderShareList(recipe);

  // Favori en libre-service pour la proprietaire et les destinataires d'un
  // partage (regles Firestore) ; en lecture pure (admin sur une recette qui
  // n'est ni sienne ni partagee avec elle), le bouton n'a pas d'action
  // possible, autant le masquer plutot que de proposer un clic qui echoue.
  E.$('#detail-favorite-btn').hidden = !(isMine || isShared);
  setFavoriteBtn(isFavoritedByMe(recipe));

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
  E.screens.show(detailReturnScreen, { push: true });
});
E.$('#detail-print-btn').addEventListener('click', function () {
  window.print();
});
E.$('#detail-edit-btn').addEventListener('click', function () {
  if (viewingRecipe) openForm(viewingRecipe, 'screen-detail');
});

/* ------------------------------------------------------------- Favoris */
function setFavoriteBtn(isFav) {
  var btn = E.$('#detail-favorite-btn');
  btn.textContent = isFav ? '★' : '☆';
  btn.setAttribute('aria-pressed', String(isFav));
}
function setFavoritedByMeLocally(recipe, value) {
  var arr = (recipe.favoritedBy || []).filter(function (u) { return u !== currentUser; });
  if (value) arr.push(currentUser);
  recipe.favoritedBy = arr;
}
E.$('#detail-favorite-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  var next = !isFavoritedByMe(viewingRecipe);
  setFavoriteBtn(next); // optimiste : pas d'attente reseau pour un simple toggle
  setFavoritedByMeLocally(viewingRecipe, next);
  toggleFavorite(viewingRecipe.id, currentUser, next).catch(function (err) {
    setFavoriteBtn(!next);
    setFavoritedByMeLocally(viewingRecipe, !next);
    E.announce('Favori non enregistré : ' + (err && err.message ? err.message : 'erreur.'), true);
  });
});

/* ----------------------------------------------------------- Dupliquer */
function openFormAsDuplicate(recipe) {
  openForm(null, 'screen-home');
  E.$('#field-title').value = recipe.title + ' (copie)';
  E.$('#field-category').value = recipe.category || '';
  E.$('#field-prep-time').value = recipe.prepMinutes || '';
  E.$('#field-cook-time').value = recipe.cookMinutes || '';
  E.$('#field-servings').value = recipe.servings || '';
  setRating(E.$('#field-difficulty'), recipe.difficulty || 0);
  setRating(E.$('#field-budget'), recipe.budget || 0);
  E.$('#field-season').value = recipe.season || '';
  E.$('#field-conservation').value = recipe.conservationDays || '';
  setDiets(E.$('#field-diets'), recipe.diets || []);
  E.$('#field-note').value = recipe.note || '';
  // Pas de photos sur la copie : elles restent liees au chemin Storage de
  // l'originale (les dupliquer couterait un upload complet a chaque copie,
  // et les reutiliser telles quelles casserait la copie si l'originale est
  // supprimee).
  resetDynamicList(E.$('#ingredients-list'), 'ex. 200 g de farine', recipe.ingredients);
  resetDynamicList(E.$('#steps-list'), 'Décris cette étape…', recipe.steps);
}
E.$('#detail-duplicate-btn').addEventListener('click', function () {
  if (viewingRecipe) openFormAsDuplicate(viewingRecipe);
});

/* -------------------------------------------------------------- Partage */
function renderShareList(recipe) {
  var wrap = E.$('#share-list');
  wrap.textContent = '';
  (recipe.sharedWith || []).forEach(function (uid) {
    var chip = document.createElement('span');
    chip.className = 'chip chip--removable';
    var label = document.createElement('span');
    label.textContent = '…';
    chip.appendChild(label);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Retirer ce partage');
    rm.addEventListener('click', function () {
      unshareRecipeWith(recipe.id, uid)
        .then(function () {
          recipe.sharedWith = (recipe.sharedWith || []).filter(function (u) { return u !== uid; });
          renderShareList(recipe);
          E.announce('Partage retiré.');
        })
        .catch(function (err) { showError('#share-error', err && err.message ? err.message : 'Erreur.'); });
    });
    chip.appendChild(rm);
    wrap.appendChild(chip);
    getUserEmail(uid).then(function (email) { label.textContent = email || uid; });
  });
}

E.$('#share-add-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  hideError('#share-error');
  var email = E.$('#share-email-input').value.trim().toLowerCase();
  if (!email) return;
  findUserByEmail(email).then(function (uid) {
    if (!uid) {
      showError('#share-error', "Aucun compte trouvé avec cet e-mail (la personne doit s'être déjà connectée une fois à l'app).");
      return;
    }
    if (uid === currentUser) { showError('#share-error', 'C’est déjà ta recette.'); return; }
    if ((viewingRecipe.sharedWith || []).indexOf(uid) !== -1) {
      showError('#share-error', 'Déjà partagé avec cette personne.');
      return;
    }
    return shareRecipeWith(viewingRecipe.id, uid).then(function () {
      viewingRecipe.sharedWith = (viewingRecipe.sharedWith || []).concat([uid]);
      E.$('#share-email-input').value = '';
      renderShareList(viewingRecipe);
      E.announce('Recette partagée.');
    });
  }).catch(function (err) {
    showError('#share-error', err && err.message ? err.message : 'Erreur.');
  });
});
E.$('#detail-delete-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  if (!window.confirm('Supprimer « ' + viewingRecipe.title + ' » ? Cette action est définitive.')) return;
  deleteRecipe(viewingRecipe.id, recipePhotos(viewingRecipe))
    .then(function () {
      E.announce('Recette supprimée.');
      renderList();
      E.screens.show(detailReturnScreen, { push: true });
    })
    .catch(function (err) {
      E.announce('Suppression impossible : ' + (err && err.message ? err.message : 'erreur.'), true);
    });
});

E.$('#detail-leave-shared-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  if (!window.confirm('Retirer « ' + viewingRecipe.title + ' » de tes recettes partagées ?')) return;
  unshareRecipeWith(viewingRecipe.id, currentUser)
    .then(function () {
      sharedRecipes = sharedRecipes.filter(function (r) { return r.id !== viewingRecipe.id; });
      renderList();
      E.announce('Recette retirée de tes recettes partagées.');
      E.screens.show(detailReturnScreen, { push: true });
    })
    .catch(function (err) {
      E.announce('Impossible de retirer : ' + (err && err.message ? err.message : 'erreur.'), true);
    });
});

/* ------------------------------------------------------------ Formulaire */
// La 1re photo de photoItems sert de couverture (carte de la liste). Un clic
// sur l'etoile d'une autre photo la fait passer en tete. Delegation sur le
// conteneur (comme les listes ingredients/etapes) : l'index se lit sur la
// position DOM au moment du clic, pas besoin de le figer a la creation.
function renderPhotoGallery() {
  var wrap = E.$('#photo-gallery');
  wrap.textContent = '';
  photoItems.forEach(function (item, idx) {
    var src = item.kept ? item.kept.thumbUrl : URL.createObjectURL(item.file);
    wrap.appendChild(photoThumb(src, idx === 0));
  });
}

function photoThumb(src, isCover) {
  var box = document.createElement('div');
  box.className = 'photo-thumb' + (isCover ? ' photo-thumb--cover' : '');
  var img = document.createElement('img');
  img.src = src;
  img.alt = '';
  box.appendChild(img);

  if (isCover) {
    var badge = document.createElement('span');
    badge.className = 'photo-thumb-badge';
    badge.textContent = 'Couverture';
    box.appendChild(badge);
  } else {
    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'photo-thumb-cover-btn';
    star.setAttribute('aria-label', 'Définir comme couverture');
    star.textContent = '★';
    box.appendChild(star);
  }

  var rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'photo-thumb-remove';
  rm.setAttribute('aria-label', 'Retirer cette photo');
  rm.textContent = '×';
  box.appendChild(rm);

  return box;
}

E.$('#photo-gallery').addEventListener('click', function (e) {
  var wrap = E.$('#photo-gallery');
  var box = e.target.closest('.photo-thumb');
  if (!box) return;
  var idx = Array.prototype.indexOf.call(wrap.children, box);
  if (idx === -1) return;

  if (e.target.closest('.photo-thumb-cover-btn')) {
    var item = photoItems.splice(idx, 1)[0];
    photoItems.unshift(item);
    renderPhotoGallery();
  } else if (e.target.closest('.photo-thumb-remove')) {
    var removed = photoItems.splice(idx, 1)[0];
    if (removed.kept) removedPhotos.push({ path: removed.kept.path, thumbPath: removed.kept.thumbPath });
    renderPhotoGallery();
  }
});

function openForm(recipe, returnScreen) {
  editingRecipe = recipe || null;
  formReturnScreen = returnScreen || 'screen-home';
  removedPhotos = [];
  photoItems = editingRecipe ? recipePhotos(editingRecipe).map(function (p) { return { kept: p }; }) : [];

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
  files.forEach(function (f) { photoItems.push({ file: f }); });
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
    ownerEmail: currentUserEmail,
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
  };

  var submitBtn = E.$('#form-submit-btn');
  submitBtn.disabled = true;

  saveRecipe(currentUser, editingRecipe ? editingRecipe.id : null, fields, photoItems, removedPhotos)
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
// Affiche l'erreur a l'ecran (pas seulement via E.announce, invisible pour
// un public voyant) : une erreur avalee silencieusement est pire qu'un
// plantage visible, impossible a diagnostiquer a distance.
function showVisibleError(prefix, err) {
  var msg = prefix + ' : ' + (err && err.message ? err.message : String(err))
    + (err && err.code ? ' (' + err.code + ')' : '');
  console.error(msg, err);
  var el = document.getElementById('diag-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'diag-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;'
      + 'background:#c0392b;color:#fff;padding:10px;font:12px monospace;'
      + 'white-space:pre-wrap;max-height:50vh;overflow:auto;';
    document.body.appendChild(el);
  }
  el.textContent += msg + '\n\n';
  E.announce(msg, true);
}
function recoverFromPersistenceError(err) {
  showVisibleError('Erreur de synchronisation des recettes', err);
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

/* ----------------------------------------------------------------- Admin */
// Abonnement "toutes les recettes" demarre seulement a l'ouverture de
// l'ecran admin (pas en continu) : evite des lectures Firestore inutiles
// pour une fonctionnalite rarement utilisee. Memes options de
// recherche/filtre que la liste perso (buildCategoryOptions/filterRecipes).
function renderAdminList() {
  var wrap = E.$('#admin-recipe-list');
  var empty = E.$('#admin-empty-state');
  var filtered = filterRecipes(allRecipes, E.$('#admin-search-input'), E.$('#admin-category-filter'));

  wrap.textContent = '';
  filtered.forEach(function (r) { wrap.appendChild(renderRecipeCard(r, 'screen-admin', true)); });

  if (filtered.length === 0) {
    empty.hidden = false;
    empty.textContent = allRecipes.length === 0
      ? 'Aucune recette, tous comptes confondus.'
      : 'Aucune recette ne correspond à ta recherche.';
  } else {
    empty.hidden = true;
  }
}

E.$('#admin-search-input').addEventListener('input', renderAdminList);
E.$('#admin-category-filter').addEventListener('change', renderAdminList);

// Estimation (pas un chiffre facture) : seule la Storage compte vraiment
// dans les quotas gratuits chez nous, et elle n'est pas consultable depuis
// le navigateur (l'API de monitoring exige des identifiants serveur). On
// approxime en sommant les tailles des photos deja connues du client.
function updateAdminUsage() {
  var totalBytes = 0;
  allRecipes.forEach(function (r) {
    recipePhotos(r).forEach(function (p) { totalBytes += p.sizeBytes || 0; });
  });
  var mb = totalBytes / (1024 * 1024);
  E.$('#admin-usage').textContent = 'Espace photos utilisé (estimation) : ' + mb.toFixed(1)
    + ' Mo / 5000 Mo gratuits — ' + allRecipes.length + ' recette' + (allRecipes.length > 1 ? 's' : '')
    + ', tous comptes confondus.';
}

E.$('#admin-btn').addEventListener('click', function () {
  E.$('#admin-search-input').value = '';
  unsubscribeAllRecipes = subscribeToAllRecipes(function (list) {
    allRecipes = list;
    buildCategoryOptions(E.$('#admin-category-filter'), allRecipes);
    renderAdminList();
    updateAdminUsage();
  }, function (err) {
    showVisibleError('Erreur de synchronisation (admin)', err);
  });
  E.screens.show('screen-admin', { push: true });
});
E.$('#admin-back-btn').addEventListener('click', function () {
  if (unsubscribeAllRecipes) { unsubscribeAllRecipes(); unsubscribeAllRecipes = null; }
  allRecipes = [];
  E.screens.show('screen-home', { push: true });
});

/* ------------------------------------------------------ Partage avec moi */
// Fondu dans la liste principale (renderList/combinedRecipes) : plus
// d'ecran ni d'abonnement a la demande, l'abonnement tourne en continu des
// la connexion (voir startSharedSubscription, appele par watchAuth) comme
// celui des recettes perso.
function startSharedSubscription(uid) {
  stopSharedSubscription();
  try {
    unsubscribeShared = subscribeToSharedWithMe(uid, function (list) {
      sharedRecipes = list.map(function (r) { r.__shared = true; return r; });
      updateCategoryOptions();
      renderList();
    }, function (err) {
      recoverFromPersistenceError(err);
    });
  } catch (err) {
    recoverFromPersistenceError(err);
  }
}
function stopSharedSubscription() {
  if (unsubscribeShared) { unsubscribeShared(); unsubscribeShared = null; }
  sharedRecipes = [];
}

/* --------------------------------------------------------------- Export */
E.$('#export-json-btn').addEventListener('click', function () {
  var data = recipes.map(function (r) {
    return {
      title: r.title, category: r.category, prepMinutes: r.prepMinutes, cookMinutes: r.cookMinutes,
      servings: r.servings, difficulty: r.difficulty, budget: r.budget, season: r.season,
      diets: r.diets, conservationDays: r.conservationDays, note: r.note,
      ingredients: r.ingredients, steps: r.steps, favorite: isFavoritedByMe(r),
      photos: recipePhotos(r).map(function (p) { return p.url; }),
    };
  });
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'mes-recettes-' + E.history.dayStr(Date.now()) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  E.announce('Export JSON téléchargé.');
});

function appendBookRecipe(wrap, r) {
  var block = document.createElement('div');
  block.className = 'book-recipe';

  var photos = recipePhotos(r);
  if (photos.length) {
    var photosWrap = document.createElement('div');
    photosWrap.className = 'detail-photos';
    photos.forEach(function (p) {
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      photosWrap.appendChild(img);
    });
    block.appendChild(photosWrap);
  }

  var h2 = document.createElement('h2');
  h2.textContent = r.title;
  block.appendChild(h2);

  var meta = document.createElement('div');
  meta.className = 'chip-row';
  renderChips(meta, chipsFor(r));
  block.appendChild(meta);

  var ingHeading = document.createElement('h3');
  ingHeading.className = 'detail-heading';
  ingHeading.textContent = 'Ingrédients';
  block.appendChild(ingHeading);
  var ingList = document.createElement('ul');
  ingList.className = 'detail-list';
  fillList(ingList, r.ingredients);
  block.appendChild(ingList);

  var stepHeading = document.createElement('h3');
  stepHeading.className = 'detail-heading';
  stepHeading.textContent = 'Étapes';
  block.appendChild(stepHeading);
  var stepList = document.createElement('ol');
  stepList.className = 'detail-list detail-list--steps';
  fillList(stepList, r.steps);
  block.appendChild(stepList);

  if (r.note) {
    var noteHeading = document.createElement('h3');
    noteHeading.className = 'detail-heading';
    noteHeading.textContent = 'Note personnelle';
    block.appendChild(noteHeading);
    var noteP = document.createElement('p');
    noteP.className = 'detail-note';
    noteP.textContent = r.note;
    block.appendChild(noteP);
  }

  wrap.appendChild(block);
}

E.$('#export-book-btn').addEventListener('click', function () {
  var wrap = E.$('#book-content');
  wrap.textContent = '';
  recipes.forEach(function (r) { appendBookRecipe(wrap, r); });
  E.screens.show('screen-book', { push: true });
});
E.$('#book-back-btn').addEventListener('click', function () {
  E.screens.show('screen-home', { push: true });
});
E.$('#book-print-btn').addEventListener('click', function () {
  window.print();
});

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
    currentUserEmail = user.email || '';
    E.$('#admin-btn').hidden = currentUser !== ADMIN_UID;
    // Alimente l'annuaire uid -> e-mail (necessaire pour partager par
    // e-mail) ; best-effort, ne doit pas bloquer la connexion si ca echoue.
    upsertUserProfile(currentUser, currentUserEmail).catch(function () {});
    // L'ecran d'accueil s'affiche dans tous les cas : une erreur Firestore
    // (ex. conflit de persistence locale, gere dans startRecipesSubscription)
    // ne doit jamais bloquer la transition post-connexion.
    E.screens.show('screen-home', { push: false });
    startRecipesSubscription(currentUser);
    startSharedSubscription(currentUser);
  } else {
    currentUser = null;
    currentUserEmail = '';
    stopRecipesSubscription();
    stopSharedSubscription();
    if (unsubscribeAllRecipes) { unsubscribeAllRecipes(); unsubscribeAllRecipes = null; }
    allRecipes = [];
    E.$('#auth-form').reset();
    setAuthMode('signin');
    E.screens.show('screen-auth', { push: false });
  }
});
