/* Mes Recettes — logique de l'app.
 * La coque PWA (service worker, bandeau installer, ecrans, a11y) vient
 * d'AppEngine (engine/engine.js). Ici : cablage des 4 ecrans + Firebase.
 */
import {
  watchAuth, signUp, signIn, logOut, resetPassword, authErrorMessage,
  signInWithGoogle, consumeRedirectError, sendVerificationEmail, refreshEmailVerified,
} from './auth.js';
import {
  subscribeToRecipes, subscribeToAllRecipes, subscribeToSharedWithMe,
  saveRecipe, deleteRecipe, recipePhotos, toggleFavorite,
  upsertUserProfile, findUserByEmail, getUserEmail, shareRecipeWith, unshareRecipeWith,
  fetchLegacyPhotoSize, fetchAllUsers,
  FREE_MAX_RECIPES, FREE_MAX_PHOTOS, freeRecipeSlot, subscribeToApproval, subscribeToUnlockRequest,
  sendUnlockRequest, fetchQuotaState, approveUser, revokeUser, rejectUnlockRequest,
} from './recipes.js';

// Doit rester identique a l'UID code en dur dans firestore.rules
// (isAdmin()) : la vraie securite vient des regles, ceci ne sert qu'a
// afficher/masquer le bouton cote interface.
var ADMIN_UID = 'EwBMsqx4MGXHNHcPlkpb7StazJp2';

var APP_VERSION = 'v1.10.3';
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
var adminUsers = [];    // vue admin uniquement (annuaire `users`)
var adminApproved = {};  // vue admin : { uid: true } des comptes debloques
var adminRequests = {};  // vue admin : { uid: { email, message, createdAt, status? } }
var adminOwnerBytes = null; // vue admin : { ownerId: octets }, null tant que non calcule
var sharedRecipes = []; // vue "partage avec moi"
var unsubscribeRecipes = null;
var unsubscribeAllRecipes = null;
var unsubscribeShared = null;
var unsubscribeApproval = null;
var unsubscribeUnlock = null;
var emailVerified = false;  // e-mail confirme (exige par firestore.rules pour creer une recette)
var isApproved = false;     // compte debloque par l'admin (voir firestore.rules)
var quotaLoaded = false;    // etat de deblocage connu (sinon on laisse les regles trancher)
var myUnlockRequest = null; // ma demande de deblocage : { message, status? } ou null
var unlockReturnScreen = 'screen-home';
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
  if (isFavoritedByMe(recipe)) chips.push('★');
  if (recipe.category) chips.push(recipe.category);
  var totalMin = (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0);
  if (totalMin) chips.push(totalMin + ' min');
  if (recipe.servings) chips.push(recipe.servings + ' pers.');
  if (recipe.difficulty) chips.push('▲'.repeat(recipe.difficulty));
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
    chip.className = 'chip' + (c === '★' ? ' chip--favorite' : '');
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
  if (!openForm(null, 'screen-home')) return;
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

/* ------------------------------------------------------ Quotas / deblocage */
// Compte non debloque : 2 recettes (emplacements {uid}_1/{uid}_2) et 3 photos
// par recette. La vraie limite est dans firestore.rules ; ceci evite juste
// une erreur de permission incomprehensible.
function isUnlocked() { return isApproved || currentUser === ADMIN_UID; }

// { allowed, id } : id = emplacement impose a la creation (null = id auto).
// Tant que l'etat de deblocage n'est pas connu (1re connexion hors-ligne), on
// laisse passer et les regles decident.
function newRecipeSlot() {
  if (isUnlocked()) return { allowed: true, id: null };
  if (!emailVerified) return { allowed: false, id: null };
  var id = freeRecipeSlot(currentUser, recipes);
  if (id) return { allowed: true, id: id };
  return { allowed: !quotaLoaded, id: null };
}

function updateQuotaBanner() {
  var banner = E.$('#quota-banner');
  if (!currentUser || !quotaLoaded || isUnlocked()) { banner.hidden = true; return; }
  var text, btn;
  if (!emailVerified) {
    text = 'Vérifie ton e-mail pour pouvoir créer des recettes.';
    btn = 'Vérifier';
  } else if (!myUnlockRequest) {
    text = 'Compte en période d’essai : ' + FREE_MAX_RECIPES + ' recettes, ' + FREE_MAX_PHOTOS + ' photos par recette.';
    btn = 'Demander le déblocage';
  } else if (myUnlockRequest.status === 'refused') {
    text = 'Ta demande de déblocage a été refusée.';
    btn = 'Nouvelle demande';
  } else {
    text = 'Demande de déblocage envoyée, en attente de réponse.';
    btn = 'Voir ma demande';
  }
  E.$('#quota-banner-text').textContent = text;
  E.$('#quota-banner-btn').textContent = btn;
  banner.hidden = false;
}

// Deux modes : e-mail pas encore verifie -> consigne de verification ;
// sinon -> formulaire de demande de deblocage.
var unlockReason = '';
function renderUnlockScreen() {
  var verifyMode = !emailVerified && !isUnlocked();
  E.$('#unlock-verify').hidden = !verifyMode;
  E.$('#unlock-form').hidden = verifyMode;
  E.$('#unlock-intro').hidden = verifyMode;
  var status = E.$('#unlock-status');
  hideError('#unlock-verify-status');
  E.$('#unlock-verify-status').hidden = true;
  if (verifyMode) {
    status.hidden = true;
    E.$('#unlock-verify-text').textContent = 'Confirme d’abord ton adresse e-mail (' + currentUserEmail
      + ') : clique sur le lien reçu par e-mail (pense à regarder les spams), puis reviens ici.';
    return;
  }
  var refused = myUnlockRequest && myUnlockRequest.status === 'refused';
  E.$('#unlock-intro').textContent = (unlockReason ? unlockReason + ' ' : '')
    + 'Les nouveaux comptes sont limités à ' + FREE_MAX_RECIPES + ' recettes, avec ' + FREE_MAX_PHOTOS
    + ' photos maximum par recette. Explique brièvement pourquoi tu as besoin de plus : ta demande sera examinée avant déblocage.';
  status.hidden = !myUnlockRequest;
  if (myUnlockRequest) {
    status.textContent = refused
      ? 'Ta précédente demande a été refusée. Tu peux en envoyer une nouvelle.'
      : 'Demande envoyée, en attente de réponse. Tu peux la remplacer en renvoyant un message.';
  }
  E.$('#unlock-message').value = myUnlockRequest && !refused ? myUnlockRequest.message || '' : '';
  hideError('#unlock-error');
}

function openUnlockScreen(returnScreen, reason) {
  unlockReturnScreen = returnScreen || 'screen-home';
  unlockReason = reason || '';
  renderUnlockScreen();
  E.screens.show('screen-unlock', { push: true });
}

function showVerifyStatus(msg) {
  var el = E.$('#unlock-verify-status');
  el.textContent = msg;
  el.hidden = false;
}

E.$('#unlock-verify-back-btn').addEventListener('click', function () { E.screens.show(unlockReturnScreen, { push: true }); });
E.$('#unlock-resend-btn').addEventListener('click', function () {
  sendVerificationEmail()
    .then(function () { showVerifyStatus('E-mail envoyé.'); })
    .catch(function (err) { showVerifyStatus(authErrorMessage(err)); });
});
E.$('#unlock-check-btn').addEventListener('click', function () {
  refreshEmailVerified()
    .then(function (verified) {
      emailVerified = verified;
      updateQuotaBanner();
      if (verified) renderUnlockScreen();
      else showVerifyStatus('Pas encore vérifié : clique d’abord sur le lien reçu par e-mail.');
    })
    .catch(function (err) { showVerifyStatus(authErrorMessage(err)); });
});

E.$('#quota-banner-btn').addEventListener('click', function () { openUnlockScreen('screen-home'); });
E.$('#unlock-cancel-btn').addEventListener('click', function () { E.screens.show(unlockReturnScreen, { push: true }); });

E.$('#unlock-form').addEventListener('submit', function (e) {
  e.preventDefault();
  hideError('#unlock-error');
  var message = E.$('#unlock-message').value.trim();
  if (message.length < 10) return showError('#unlock-error', 'Explique ta demande en quelques mots (10 caractères minimum).');
  var btn = E.$('#unlock-submit-btn');
  btn.disabled = true;
  sendUnlockRequest(currentUser, currentUserEmail, message)
    .then(function () {
      btn.disabled = false;
      E.announce('Demande envoyée.');
      E.screens.show('screen-home', { push: true });
    })
    .catch(function (err) {
      btn.disabled = false;
      showError('#unlock-error', "Impossible d'envoyer la demande : " + (err && err.message ? err.message : 'erreur inconnue.'));
    });
});

function startQuotaSubscriptions(uid) {
  stopQuotaSubscriptions();
  unsubscribeApproval = subscribeToApproval(uid, function (approved) {
    isApproved = approved;
    quotaLoaded = true;
    updateQuotaBanner();
  }, function () { /* best-effort : les regles restent l'autorite */ });
  unsubscribeUnlock = subscribeToUnlockRequest(uid, function (req) {
    myUnlockRequest = req;
    updateQuotaBanner();
  }, function () {});
}
function stopQuotaSubscriptions() {
  if (unsubscribeApproval) { unsubscribeApproval(); unsubscribeApproval = null; }
  if (unsubscribeUnlock) { unsubscribeUnlock(); unsubscribeUnlock = null; }
  isApproved = false;
  quotaLoaded = false;
  emailVerified = false;
  myUnlockRequest = null;
  E.$('#quota-banner').hidden = true;
}

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

// Renvoie false (et ouvre l'ecran de deblocage) si un compte non debloque a
// atteint sa limite de recettes.
function openForm(recipe, returnScreen) {
  if (!recipe && !newRecipeSlot().allowed) {
    openUnlockScreen(returnScreen, 'Tu as atteint la limite de ' + FREE_MAX_RECIPES + ' recettes.');
    return false;
  }
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
  return true;
}

E.$('#field-photo').addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files || []);
  if (!isUnlocked() && photoItems.length + files.length > FREE_MAX_PHOTOS) {
    files = files.slice(0, Math.max(0, FREE_MAX_PHOTOS - photoItems.length));
    showError('#form-error', FREE_MAX_PHOTOS + ' photos maximum par recette tant que ton compte n’est pas débloqué.');
  }
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

  var slot = editingRecipe ? { allowed: true, id: null } : newRecipeSlot();
  if (!slot.allowed) return openUnlockScreen('screen-home', 'Tu as atteint la limite de ' + FREE_MAX_RECIPES + ' recettes.');

  var submitBtn = E.$('#form-submit-btn');
  submitBtn.disabled = true;

  saveRecipe(currentUser, editingRecipe ? editingRecipe.id : null, fields, photoItems, removedPhotos, slot.id)
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
// approxime en sommant les tailles des photos ; celles envoyees avant le
// champ `sizeBytes` (0 en base) sont redemandees a Storage a la volee et
// mises en cache ici (jamais ecrites en base : l'admin n'a pas le droit de
// modifier les recettes d'une autre personne, et ce n'est qu'une estimation).
var legacyPhotoSizeCache = {};
var adminUsageRequestId = 0;
function updateAdminUsage() {
  var requestId = ++adminUsageRequestId;
  var usageEl = E.$('#admin-usage');
  var items = [];
  allRecipes.forEach(function (r) {
    recipePhotos(r).forEach(function (p) { items.push({ owner: r.ownerId, photo: p }); });
  });

  var sizes = items.map(function (it) {
    var p = it.photo;
    if (p.sizeBytes) return Promise.resolve(p.sizeBytes);
    if (!p.path) return Promise.resolve(0);
    if (p.path in legacyPhotoSizeCache) return Promise.resolve(legacyPhotoSizeCache[p.path]);
    return fetchLegacyPhotoSize(p.path, p.thumbPath).then(function (bytes) {
      legacyPhotoSizeCache[p.path] = bytes;
      return bytes;
    });
  });

  Promise.all(sizes).then(function (values) {
    if (requestId !== adminUsageRequestId) return; // une vue plus recente a deja pris le relais
    var totalBytes = 0;
    adminOwnerBytes = {};
    values.forEach(function (bytes, i) {
      var owner = items[i].owner;
      adminOwnerBytes[owner] = (adminOwnerBytes[owner] || 0) + bytes;
      totalBytes += bytes;
    });
    var mb = totalBytes / (1024 * 1024);
    usageEl.textContent = 'Espace photos utilisé (estimation) : ' + mb.toFixed(1)
      + ' Mo / 5000 Mo gratuits — ' + allRecipes.length + ' recette' + (allRecipes.length > 1 ? 's' : '')
      + ', tous comptes confondus.';
    renderAdminUsers();
  });
}

// Vue "Utilisateurs" : annuaire `users` (e-mail, inscription, derniere
// connexion) fusionne avec les recettes (comptes qui en ont mais qui n'ont
// pas encore de fiche dans l'annuaire, p.ex. inscrits avant sa creation).
// Les plus recemment inscrits en premier : c'est eux qu'on surveille.
function formatDate(ms) {
  return ms ? new Date(ms).toLocaleDateString('fr-FR') : '—';
}

function adminAction(promise, done) {
  promise.then(function () { done(); renderAdminUsers(); }).catch(function (err) {
    showVisibleError('Action admin échouée', err);
  });
}

function adminButton(label, primary, onClick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn ' + (primary ? 'btn--primary' : 'btn--ghost');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function hasPendingRequest(uid) {
  return !!adminRequests[uid] && adminRequests[uid].status !== 'refused';
}

function renderAdminUsers() {
  var wrap = E.$('#admin-user-list');
  var byUid = {};
  adminUsers.forEach(function (u) { byUid[u.uid] = { uid: u.uid, email: u.email, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt }; });
  var stats = {};
  allRecipes.forEach(function (r) {
    var st = stats[r.ownerId] || (stats[r.ownerId] = { recipes: 0, photos: 0 });
    st.recipes++;
    st.photos += recipePhotos(r).length;
    if (!byUid[r.ownerId]) byUid[r.ownerId] = { uid: r.ownerId, email: r.ownerEmail };
  });

  // Demandes en attente d'abord, puis inscriptions les plus recentes.
  var users = Object.keys(byUid).map(function (k) { return byUid[k]; });
  users.sort(function (a, b) {
    return (hasPendingRequest(b.uid) - hasPendingRequest(a.uid)) || ((b.createdAt || 0) - (a.createdAt || 0));
  });

  wrap.textContent = '';
  users.forEach(function (u) {
    var st = stats[u.uid] || { recipes: 0, photos: 0 };
    var isAdminUser = u.uid === ADMIN_UID;
    var row = document.createElement('div');
    row.className = 'user-row';

    var email = document.createElement('div');
    email.className = 'user-row-email';
    email.textContent = u.email || u.uid;
    row.appendChild(email);

    var dates = document.createElement('div');
    dates.className = 'user-row-dates';
    dates.textContent = 'Inscrit le ' + formatDate(u.createdAt) + ' · dernière connexion ' + formatDate(u.lastLoginAt);
    row.appendChild(dates);

    var chips = [st.recipes + ' recette' + (st.recipes > 1 ? 's' : ''), st.photos + ' photo' + (st.photos > 1 ? 's' : '')];
    if (adminOwnerBytes) chips.push(((adminOwnerBytes[u.uid] || 0) / (1024 * 1024)).toFixed(1) + ' Mo');
    chips.unshift(isAdminUser ? 'Admin' : (adminApproved[u.uid] ? 'Débloqué' : 'Limité'));
    var chipRow = document.createElement('div');
    chipRow.className = 'chip-row';
    renderChips(chipRow, chips);
    row.appendChild(chipRow);

    var req = adminRequests[u.uid];
    if (req && !isAdminUser) {
      var quote = document.createElement('p');
      quote.className = 'user-row-request';
      quote.textContent = (req.status === 'refused' ? '[Refusée] ' : '') + (req.message || '');
      row.appendChild(quote);
    }

    if (!isAdminUser) {
      var actions = document.createElement('div');
      actions.className = 'user-row-actions';
      if (adminApproved[u.uid]) {
        actions.appendChild(adminButton('Re-limiter', false, function () {
          adminAction(revokeUser(u.uid), function () { delete adminApproved[u.uid]; });
        }));
      } else {
        actions.appendChild(adminButton('Débloquer', true, function () {
          adminAction(approveUser(u.uid), function () { adminApproved[u.uid] = true; delete adminRequests[u.uid]; });
        }));
        if (hasPendingRequest(u.uid)) {
          actions.appendChild(adminButton('Refuser', false, function () {
            adminAction(rejectUnlockRequest(u.uid), function () { adminRequests[u.uid].status = 'refused'; });
          }));
        }
      }
      row.appendChild(actions);
    }

    wrap.appendChild(row);
  });

  var pending = Object.keys(adminRequests).filter(hasPendingRequest).length;
  E.$('[data-admin-tab="users"]').textContent = 'Utilisateurs' + (pending ? ' (' + pending + ')' : '');
}

function showAdminTab(tab) {
  var users = tab === 'users';
  document.querySelectorAll('.admin-tab').forEach(function (btn) {
    var active = btn.getAttribute('data-admin-tab') === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  E.$('#admin-recipes-filters').hidden = users;
  E.$('#admin-recipe-list').hidden = users;
  E.$('#admin-user-list').hidden = !users;
  if (users) E.$('#admin-empty-state').hidden = true;
  else renderAdminList();
}

document.querySelectorAll('.admin-tab').forEach(function (btn) {
  btn.addEventListener('click', function () { showAdminTab(btn.getAttribute('data-admin-tab')); });
});

E.$('#admin-btn').addEventListener('click', function () {
  E.$('#admin-search-input').value = '';
  showAdminTab('recipes');
  Promise.all([fetchAllUsers(), fetchQuotaState()]).then(function (res) {
    adminUsers = res[0];
    adminApproved = {};
    res[1].approved.forEach(function (uid) { adminApproved[uid] = true; });
    adminRequests = {};
    res[1].requests.forEach(function (r) { adminRequests[r.uid] = r; });
    renderAdminUsers();
  }).catch(function (err) {
    showVisibleError('Erreur de chargement des utilisateurs (admin)', err);
  });
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
  adminUsers = [];
  adminApproved = {};
  adminRequests = {};
  adminOwnerBytes = null;
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
    emailVerified = user.emailVerified;
    // Verifie peut-etre depuis un autre appareil : relit le compte (et le
    // jeton lu par les regles) sans bloquer la connexion.
    if (!emailVerified) {
      refreshEmailVerified().then(function (verified) {
        if (currentUser !== user.uid) return;
        emailVerified = verified;
        updateQuotaBanner();
      }).catch(function () {});
    }
    E.$('#admin-btn').hidden = currentUser !== ADMIN_UID;
    // Alimente l'annuaire uid -> e-mail (necessaire pour partager par
    // e-mail) ; best-effort, ne doit pas bloquer la connexion si ca echoue.
    upsertUserProfile(currentUser, currentUserEmail, user.metadata).catch(function () {});
    // L'ecran d'accueil s'affiche dans tous les cas : une erreur Firestore
    // (ex. conflit de persistence locale, gere dans startRecipesSubscription)
    // ne doit jamais bloquer la transition post-connexion.
    E.screens.show('screen-home', { push: false });
    startRecipesSubscription(currentUser);
    startSharedSubscription(currentUser);
    startQuotaSubscriptions(currentUser);
  } else {
    currentUser = null;
    currentUserEmail = '';
    stopRecipesSubscription();
    stopSharedSubscription();
    stopQuotaSubscriptions();
    if (unsubscribeAllRecipes) { unsubscribeAllRecipes(); unsubscribeAllRecipes = null; }
    allRecipes = [];
    adminUsers = [];
    adminApproved = {};
    adminRequests = {};
    adminOwnerBytes = null;
    E.$('#auth-form').reset();
    setAuthMode('signin');
    E.screens.show('screen-auth', { push: false });
  }
});
