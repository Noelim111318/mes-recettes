# Mes Recettes

PWA de gestion de recettes de cuisine, privée par compte (email/mot de
passe), hors-ligne avec synchronisation automatique. Construite sur
**pwa-engine** (dossier `engine/` : service worker, bandeau d'installation,
navigation entre écrans) + **Firebase** (Auth, Firestore, Storage, Hosting).

Aucun build : SDK Firebase chargé en ESM directement depuis le CDN officiel
(`firebase-init.js`).

## Lancer en local

Un service worker exige http:// (pas file://) :

```
python3 -m http.server 8000
# puis http://localhost:8000
```

Il faut d'abord avoir rempli `firebase-config.js` (voir *Mise en place
Firebase* ci-dessous) — sans ça, l'écran de connexion s'affiche mais les
appels Firebase échouent.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | coque + 4 écrans (`#screen-auth`, `#screen-home`, `#screen-form`, `#screen-detail`) |
| `data.js` | suggestions de catégories (pas les recettes, qui vivent dans Firestore) |
| `firebase-config.js` | config web Firebase (non secrète — à remplir, voir plus bas) |
| `firebase-init.js` | initialise App Check / Auth / Firestore (cache local persistant) / Storage |
| `auth.js` | inscription / connexion / déconnexion / mot de passe oublié |
| `recipes.js` | CRUD Firestore + upload/suppression photo Storage (compression client) |
| `app.js` | câblage des 4 écrans, recherche/filtre, formulaire dynamique |
| `app.css` | palette (`@import "engine/engine.css"` + tokens `:root` surchargés) |
| `firestore.rules` / `storage.rules` | isolation par `ownerId` / `uid`, quotas des comptes non débloqués |
| `service-worker.js` | identité du cache + cache-first des photos Firebase Storage (URLs immuables, cache `mes-recettes-photos`, 300 entrées max) |
| `firebase.json` / `.firebaserc` | config Hosting + Firestore + Storage |
| `engine/` | moteur pwa-engine, **copié** depuis `toolbox/pwa-engine` (ne pas éditer ici) |

## Modèle de données (Firestore, collection `recipes`)

```
{
  ownerId, title, category,
  prepMinutes, cookMinutes, servings,
  difficulty,        // 0-5 (0 = non renseigne)
  budget,             // 0-5 (0 = non renseigne)
  season,             // '' | printemps | ete | automne | hiver
  diets: string[],    // sous-ensemble de sans-gluten / sans-lactose / vegetarien / vegan
  conservationDays,   // 0 = non renseigne
  note,                // anecdote / origine / astuce, en vue d'un futur livre de recettes
  ingredients: string[], steps: string[],
  photoUrl, photoPath,
  sharedWith: [],   // toujours vide pour l'instant — réservé à un futur partage
  createdAt, updatedAt
}
```

`sharedWith` n'est écrit qu'à la création (toujours `[]`) et jamais lu
ailleurs : pas de migration nécessaire le jour où le partage sera implémenté,
il suffira d'élargir `allow read` dans `firestore.rules`.

## Annuaire (Firestore, collection `users`)

```
{ email, createdAt, lastLoginAt }   // doc id = uid ; alimenté à chaque connexion
```

Lu par l'écran Admin (onglet *Utilisateurs* : inscription, dernière
connexion, nombre de recettes/photos, espace estimé). `createdAt` /
`lastLoginAt` viennent de `user.metadata` (Firebase Auth) et n'apparaissent
qu'à la prochaine connexion de chaque compte.

## Quotas anti-abus et déblocage

Un compte non débloqué est limité à **2 recettes** (emplacements à l'id imposé
`{uid}_1` / `{uid}_2` : les règles ne savent pas compter, mais un id est
unique) et **3 photos par recette**, appliqué dans `firestore.rules`.

- `quotas/{uid}` : existe = compte débloqué (écrit par l'admin seul).
- `unlockRequests/{uid}` : `{ email, message, createdAt, status? }`, demande
  avec motivation (500 car. max) envoyée depuis l'écran « Débloquer mon
  compte » ; `status: 'refused'` posé par l'admin.
- Écran Admin → *Utilisateurs* : demandes en attente en tête ; boutons
  Débloquer / Refuser / Re-limiter.
- **E-mail vérifié obligatoire** pour créer une recette ou envoyer une demande
  (jeton `email_verified`, vérifié dans les règles) ; les comptes Google le
  sont d'office, un compte débloqué par l'admin en est dispensé. Le lien est
  envoyé à l'inscription, renvoyable depuis l'écran de déblocage.
- Limite connue : le nombre de fichiers envoyés dans Storage n'est pas
  plafonnable côté règles (taille ≤ 5 Mo seulement) ; filet : alerte de
  budget Blaze. **À la 1re mise en ligne, tous les comptes existants sont
  limités** : les débloquer depuis l'écran Admin.

## App Check (anti-bots)

Prouve à Firestore/Storage que la requête vient de l'app et pas d'un script
qui appelle l'API directement (reCAPTCHA Enterprise, gratuit jusqu'à 10 000
évaluations/mois — largement assez ici, un jeton dure 1 h). Désactivé tant
que `APP_CHECK_SITE_KEY` est vide dans `firebase-config.js`.

1. `gcloud services enable recaptchaenterprise.googleapis.com firebaseappcheck.googleapis.com`
2. `gcloud recaptcha keys create --web --integration-type=score --display-name=mes-recettes --domains=<domaines Hosting>,localhost`
   → identifiant de clé = clé de site à coller dans `APP_CHECK_SITE_KEY`.
3. Lier la clé à l'app dans App Check (API `apps/<appId>/recaptchaEnterpriseConfig`,
   ou console Firebase → App Check → reCAPTCHA Enterprise).
4. Laisser tourner quelques jours : App Check → Firestore / Storage affichent
   la part de requêtes « vérifiées ». Puis **Appliquer** (enforcement) sur
   Firestore et Storage. Pas sur Auth (exige Identity Platform, payant) :
   l'inscription reste protégée par la vérification d'e-mail + les quotas.
5. En local : le jeton de debug s'affiche dans la console du navigateur, à
   enregistrer dans App Check → Gérer les jetons de débogage.

## Mise en place Firebase (une fois)

1. Créer un projet sur la [console Firebase](https://console.firebase.google.com).
2. **Authentication** → Sign-in method → activer *E-mail/Mot de passe* et *Google*
   (celui-ci demande un e-mail d'assistance du projet).
3. **Firestore Database** → créer une base (mode production).
4. **Storage** → activer. Ça demande de passer au plan **Blaze** (carte
   bancaire à associer **une fois, au niveau du projet** — pas par
   utilisatrice de l'app). L'usage réel d'un carnet de recettes perso reste
   dans le tier gratuit du Blaze.
5. Paramètres du projet → Général → *Vos applications* → ajouter une appli
   Web → copier l'objet `firebaseConfig` affiché, le coller tel quel dans
   `firebase-config.js` (remplace tout le fichier, ce n'est pas un secret).
6. Mettre l'ID du projet dans `.firebaserc` (`default`).

### Déployer les règles de sécurité

```
npx firebase-tools login          # ouvre le navigateur pour l'autorisation
npx firebase-tools deploy --only firestore:rules,storage
```

### Déploiement continu (GitHub → Firebase Hosting)

Dépôt cible : `https://github.com/Noelim111318/mes-recettes`.

```
git init
git remote add origin https://github.com/Noelim111318/mes-recettes.git
git add -A
git commit -m "Mes Recettes — v1.0.0"
git branch -M main
git push -u origin main

npx firebase-tools init hosting:github
```

`hosting:github` demande une autorisation GitHub (navigateur), puis crée un
compte de service Firebase, chiffre sa clé et l'ajoute comme secret sur le
dépôt, et écrit les workflows GitHub Actions :
- push sur `main` → déploiement sur le canal live ;
- pull request → canal de preview éphémère.

Une fois fait, chaque `git push` sur `main` déploie automatiquement.

## Maintenance

- **SDK Firebase** : version épinglée dans `firebase-init.js`, `auth.js`,
  `recipes.js` et `service-worker.js` (`APP_SHELL`). Pour bumper : changer le
  numéro de version dans les 4 fichiers en même temps, puis
  `./tools/bump-version.sh vX.Y.Z`.
- **Moteur pwa-engine** : `../toolbox/pwa-engine/tools/sync-engine.sh
  <chemin>/recettes` puis `./tools/bump-version.sh vX.Y.Z` ici (le cache SW
  inclut `engine/*`, sans bump les clients gardent l'ancien).
- **Nouveau fichier statique** : l'ajouter à `APP_SHELL` dans
  `service-worker.js`.

## API du moteur

Voir `engine/README.md`.
