/* Mes Recettes — logique de l'app.
 * La coque PWA (service worker, bandeau installer, ecrans, a11y) vient
 * d'AppEngine (engine/engine.js). Ici : cablage des 4 ecrans + Firebase.
 */
import {
  watchAuth, signUp, signIn, logOut, resetPassword, authErrorMessage,
  signInWithGoogle, consumeRedirectError,
} from './auth.js';
import { subscribeToRecipes, saveRecipe, deleteRecipe } from './recipes.js';

var APP_VERSION = 'v1.0.0';
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
var photoFile = null;

/* --------------------------------------------------------- Utilitaires */
function showError(sel, msg) { var el = E.$(sel); el.textContent = msg; el.hidden = false; }
function hideError(sel) { var el = E.$(sel); el.hidden = true; el.textContent = ''; }

function addDynamicRow(containerEl, placeholder, value) {
  var row = document.createElement('div');
  row.className = 'dynamic-list-row';

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input';
  input.placeholder = placeholder;
  input.value = value || '';

  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'dynamic-list-remove';
  removeBtn.setAttribute('aria-label', 'Supprimer cette ligne');
  removeBtn.textContent = '×';

  row.appendChild(input);
  row.appendChild(removeBtn);
  containerEl.appendChild(row);
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

function chipsFor(recipe) {
  var chips = [];
  if (recipe.category) chips.push(recipe.category);
  if (recipe.timeMinutes) chips.push(recipe.timeMinutes + ' min');
  if (recipe.servings) chips.push(recipe.servings + ' pers.');
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
  var cats = Array.from(new Set(recipes.map(function (r) { return r.category; }).filter(Boolean)))
    .sort(function (a, b) { return a.localeCompare(b, 'fr'); });

  select.textContent = '';
  var allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Toutes les catégories';
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

  if (recipe.photoUrl) {
    var img = document.createElement('img');
    img.className = 'recipe-card-photo';
    img.src = recipe.photoUrl;
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

  var filtered = recipes.filter(function (r) {
    var matchSearch = !search || (r.title || '').toLowerCase().indexOf(search) !== -1;
    var matchCat = !category || r.category === category;
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

  var photo = E.$('#detail-photo');
  if (recipe.photoUrl) {
    photo.src = recipe.photoUrl;
    photo.hidden = false;
  } else {
    photo.hidden = true;
    photo.removeAttribute('src');
  }

  E.$('#detail-title').textContent = recipe.title;
  renderChips(E.$('#detail-meta'), chipsFor(recipe));
  fillList(E.$('#detail-ingredients'), recipe.ingredients);
  fillList(E.$('#detail-steps'), recipe.steps);

  E.screens.show('screen-detail', { push: true });
}

E.$('#detail-back-btn').addEventListener('click', function () {
  E.screens.show('screen-home', { push: true });
});
E.$('#detail-edit-btn').addEventListener('click', function () {
  if (viewingRecipe) openForm(viewingRecipe, 'screen-detail');
});
E.$('#detail-delete-btn').addEventListener('click', function () {
  if (!viewingRecipe) return;
  if (!window.confirm('Supprimer « ' + viewingRecipe.title + ' » ? Cette action est définitive.')) return;
  deleteRecipe(viewingRecipe.id, viewingRecipe.photoPath)
    .then(function () {
      E.announce('Recette supprimée.');
      E.screens.show('screen-home', { push: true });
    })
    .catch(function (err) {
      E.announce('Suppression impossible : ' + (err && err.message ? err.message : 'erreur.'), true);
    });
});

/* ------------------------------------------------------------ Formulaire */
function openForm(recipe, returnScreen) {
  editingRecipe = recipe || null;
  formReturnScreen = returnScreen || 'screen-home';
  photoFile = null;

  E.$('#form-title').textContent = editingRecipe ? 'Modifier la recette' : 'Nouvelle recette';
  E.$('#field-title').value = editingRecipe ? editingRecipe.title : '';
  E.$('#field-category').value = editingRecipe ? (editingRecipe.category || '') : '';
  E.$('#field-time').value = (editingRecipe && editingRecipe.timeMinutes) ? editingRecipe.timeMinutes : '';
  E.$('#field-servings').value = (editingRecipe && editingRecipe.servings) ? editingRecipe.servings : '';
  E.$('#field-photo').value = '';

  var preview = E.$('#photo-preview');
  if (editingRecipe && editingRecipe.photoUrl) {
    preview.src = editingRecipe.photoUrl;
    preview.hidden = false;
  } else {
    preview.hidden = true;
    preview.removeAttribute('src');
  }

  resetDynamicList(E.$('#ingredients-list'), 'ex. 200 g de farine', editingRecipe ? editingRecipe.ingredients : null);
  resetDynamicList(E.$('#steps-list'), 'Décris cette étape…', editingRecipe ? editingRecipe.steps : null);

  hideError('#form-error');
  E.screens.show('screen-form', { push: true });
}

E.$('#field-photo').addEventListener('change', function (e) {
  var file = e.target.files && e.target.files[0];
  photoFile = file || null;
  if (file) {
    var preview = E.$('#photo-preview');
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  }
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
    category: E.$('#field-category').value.trim(),
    timeMinutes: Number(E.$('#field-time').value) || 0,
    servings: Number(E.$('#field-servings').value) || 0,
    ingredients: ingredients,
    steps: steps,
    photoUrl: editingRecipe ? editingRecipe.photoUrl : null,
    photoPath: editingRecipe ? editingRecipe.photoPath : null,
  };

  var submitBtn = E.$('#form-submit-btn');
  submitBtn.disabled = true;

  saveRecipe(currentUser, editingRecipe ? editingRecipe.id : null, fields, photoFile)
    .then(function (result) {
      submitBtn.disabled = false;
      if (result.photoError) {
        E.announce('Recette enregistrée. Photo non envoyée (hors-ligne ou erreur réseau) : réessaie en modifiant la recette une fois reconnecté.', true);
      } else {
        E.announce('Recette enregistrée.');
      }
      E.screens.show('screen-home', { push: true });
    })
    .catch(function (err) {
      submitBtn.disabled = false;
      showError('#form-error', "Impossible d'enregistrer : " + (err && err.message ? err.message : 'erreur inconnue.'));
    });
});

/* -------------------------------------------------- Recettes (Firestore) */
function startRecipesSubscription(uid) {
  stopRecipesSubscription();
  unsubscribeRecipes = subscribeToRecipes(uid, function (list) {
    recipes = list;
    updateCategoryOptions();
    renderList();
  }, function (err) {
    E.announce('Erreur de synchronisation : ' + (err && err.message ? err.message : 'réessaie plus tard.'), true);
  });
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
    startRecipesSubscription(currentUser);
    E.screens.show('screen-home', { push: false });
  } else {
    currentUser = null;
    stopRecipesSubscription();
    E.$('#auth-form').reset();
    setAuthMode('signin');
    E.screens.show('screen-auth', { push: false });
  }
});
