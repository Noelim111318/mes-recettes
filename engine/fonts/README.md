# Nunito

`nunito-latin.woff2` / `nunito-latin-ext.woff2` — sous-ensembles de Nunito
(Vernon Adams, Cyreal, Jacques Le Bailly), sous **SIL Open Font License 1.1**.

Auto-hebergee pour que l'appli garde sa police hors-ligne. `engine/engine.css`
la charge via `@font-face` avec `system-ui` en repli.

Tu n'en veux pas ? Supprime ce dossier, retire le bloc `@font-face` de
`engine/engine.css`, et enleve les deux `engine/fonts/*.woff2` de `APP_SHELL`
dans `service-worker.js`.
