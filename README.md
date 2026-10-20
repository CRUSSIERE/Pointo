# Pointo

Pointo est une application web (PWA) qui calcule ton heure de départ au plus tôt et suit tes heures supplémentaires.

## Développement

Application statique (HTML/CSS/JS), sans dépendances ni étape de build. Ouvre simplement `index.html` dans un navigateur, ou sers le dossier avec un serveur statique quelconque, par exemple :

```bash
npx serve .
```

## Déploiement sur Render

Ce dépôt contient un fichier `render.yaml` qui déploie le site en tant que site statique Render. Sur [render.com](https://render.com), crée un nouveau "Blueprint" à partir de ce dépôt et Render détectera automatiquement la configuration.

## Tests

- `npm test` : tests des calculs (heures supp, absences, migration des données) dans `calc.test.js`, Node 20+.
- `npm run test:e2e` : parcours complets dans Chromium (`e2e/app.e2e.js`), dont la reprise des données de l'ancienne version et le mode hors-ligne. Première fois : `npm ci && npx playwright install chromium`.

À chaque push, GitHub Actions lance les deux (`.github/workflows/tests.yml`). Render ne déploie que si ces tests sont verts (`autoDeployTrigger: checksPass`), et la build Render relance `npm test`.
