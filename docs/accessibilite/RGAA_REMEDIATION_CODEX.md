# Remédiation RGAA 4.1.2 - VigiEau grand public

> **Document d’exécution pour Codex CLI**  
> Dépôt : `MTES-MCT/vigieau`  
> Branche analysée : `develop`  
> Instantané de référence : `b0f69c474ecdece92bebdf505d8e151b96fb5a5d` (06/08/2026)  
> Source d’audit : rapport Temesis du 04/07/2024, RGAA 4.1.2  
> Périmètre strict : application grand public uniquement

Ce fichier transforme le rapport PDF en contrat de remédiation exploitable par un agent de code. Il ne doit **pas** être traité comme une suite de remplacements HTML à appliquer aveuglément : l’interface et le dépôt ont évolué entre l’audit de juillet 2024 et la branche `develop` actuelle.

## 1. Mission

Corriger exhaustivement les écarts RGAA applicables au **site grand public VigiEau**, apporter les tests de non-régression pertinents, produire une matrice de preuves et conserver un historique Git lisible.

L’audit 2024 mesurait 46,30 % de conformité et recensait 93 problèmes d’accessibilité, dont 9 bloquants, 61 majeurs et 23 mineurs. L’objectif de cette intervention est de traiter tous les constats encore applicables dans l’interface actuelle, sans inventer qu’un ancien constat reste ouvert lorsqu’un composant a disparu ou a déjà été corrigé.

## 2. Périmètre

### Inclus

- `apps/frontend/**`
- le comportement grand public rendu par `apps/frontend`
- les contenus statiques, JSON, SVG, CSS et documents directement liés par l’application publique
- les tests du frontend public
- exceptionnellement un contrat/API public si une correction frontend est impossible autrement, avec justification explicite

### Exclus

- `apps/frontend-admin/**`
- `apps/backend-admin/**`
- toute interface d’administration
- les refactorings sans rapport avec l’accessibilité
- les mises à jour de dépendances non nécessaires à la correction
- la création d’une MR, le push ou le déploiement

Ne jamais modifier le périmètre admin « par cohérence ». Ne jamais lancer une commande qui reformate massivement le monorepo entier.

## 3. Règle de priorité des sources

Pour chaque ticket :

1. inspecter le **DOM et le comportement actuels** de `develop`;
2. comprendre l’intention du critère RGAA et l’impact utilisateur décrit par le rapport;
3. utiliser de préférence la sémantique HTML native et un pattern ARIA actuel;
4. appliquer la correction minimale compatible avec l’architecture actuelle;
5. ajouter une preuve automatisée ou manuelle;
6. classer l’ancien constat avec un état et une justification.

Les exemples de code du rapport sont indicatifs. Ne pas reproduire un pattern ancien lorsqu’un pattern actuel plus robuste existe. Exemple : pour la combobox, un pattern valide avec `aria-activedescendant` est acceptable et souvent préférable à la mise au focus de chaque `<li>`.

## 4. États obligatoires de la matrice

Chaque ligne de la matrice ci-dessous doit finir avec l’un de ces états :

- `TODO`
- `IN_PROGRESS`
- `FIXED`
- `ALREADY_OK` : déjà conforme sur `develop`, preuve obligatoire
- `N/A_CURRENT_UI` : composant/flux supprimé ou remplacé, équivalent actuel audité
- `BLOCKED_CONTENT` : document ou contenu hors maîtrise, propriétaire et solution de repli documentés
- `NEEDS_MANUAL_VALIDATION`
- `WONT_FIX_DECISION` : seulement avec décision produit/juridique explicite, jamais par convenance technique

Pour toute ligne close, ajouter dans la colonne **Preuve** :

- fichier(s) et zone concernée;
- test ajouté ou commande exécutée;
- vérification manuelle éventuelle;
- justification si `ALREADY_OK`, `N/A_CURRENT_UI` ou `BLOCKED_CONTENT`.

## 5. État actuel du dépôt à connaître

Le dépôt courant utilise Node 24 et npm 11. L’application publique est un frontend Nuxt 3 / Vue 3 dans `apps/frontend`.

Commandes ciblées, sans admin :

```bash
# Depuis la racine du dépôt
npm --prefix apps/frontend ci
npm run dev:services
npm run dev:public

npm run lint:public-frontend
npm --prefix apps/frontend run test:unit
npm --prefix apps/frontend run build
npm --prefix apps/frontend run cy:e2e
npm run smoke:public
```

Adapter l’installation uniquement si le lockfile courant impose une autre commande. Ne pas lancer `npm run dev`, `npm run build` ou `npm run lint` à la racine lorsque cela entraîne aussi les applications admin; préférer les scripts publics ci-dessus.

Chemins importants :

```text
apps/frontend/client/app.vue
apps/frontend/client/layouts/basic.vue
apps/frontend/client/pages/**
apps/frontend/client/components/FdrAutoComplete.vue
apps/frontend/client/components/accueil/**
apps/frontend/client/components/carte/**
apps/frontend/client/components/donnees/**
apps/frontend/client/components/gestes/**
apps/frontend/client/components/mail/**
apps/frontend/client/components/mixins/**
apps/frontend/client/components/situation/**
apps/frontend/client/data/faq.json
apps/frontend/client/data/gestes.json
apps/frontend/client/data/liens.json
apps/frontend/cypress/**
apps/frontend/test/**
```

## 6. Contrat d’exécution

Avant toute modification :

1. exécuter `git status --short`;
2. ne pas écraser ni inclure dans un commit des modifications préexistantes de l’utilisateur;
3. créer ou mettre à jour une section de suivi dans ce fichier;
4. inspecter le code, le DOM rendu et les tests existants;
5. établir la liste exacte des fichiers concernés;
6. seulement ensuite modifier.

Après chaque lot :

1. lancer les tests ciblés;
2. lancer `npm run lint:public-frontend`;
3. lancer au minimum le build public;
4. lancer les tests e2e concernés quand l’environnement est disponible;
5. exécuter `git diff --check`;
6. inspecter `/diff`;
7. lancer `/review` ou `codex review --uncommitted`;
8. corriger les findings;
9. mettre à jour la matrice et les preuves;
10. créer **un commit cohérent pour le lot**, sans push.

Ne pas créer un commit pour chacune des 93 observations. Un commit par lot fonctionnel cohérent est plus lisible.

## 7. Principes techniques non négociables

### HTML et ARIA

- privilégier les éléments HTML natifs;
- ne pas ajouter de rôle redondant ou incorrect;
- ne jamais utiliser de `tabindex` positif;
- limiter `tabindex="-1"` aux cibles de focus programmatique;
- ne jamais masquer aux technologies d’assistance une information nécessaire;
- une zone `aria-live` doit exister avant le changement qu’elle annonce;
- ne pas créer plusieurs régions live concurrentes pour le même événement;
- vérifier le nom, rôle, valeur et état dans l’arbre d’accessibilité, pas seulement dans le template Vue.

### Focus et SPA

- navigation de page : titre pertinent + focus au début du nouveau contenu;
- action dans une page : focus vers la zone mise à jour seulement si nécessaire;
- ouverture d’une modale : focus initial logique, focus contenu, Échap, fermeture et restauration;
- aucun focus ne doit devenir invisible;
- pas de déplacement de focus surprenant pendant la saisie.

### Formulaires

- chaque contrôle a une étiquette visible ou une étiquette accessible robuste;
- le caractère obligatoire est annoncé avant l’erreur;
- aides et erreurs sont associées au contrôle;
- `aria-invalid` reflète l’état réel;
- type et `autocomplete` correspondent à la finalité;
- le clavier Entrée soumet réellement les formulaires;
- les IDs sont uniques, y compris entre variantes responsive rendues simultanément.

### Images, liens et contenus

- image décorative : `alt=""`, pas de title;
- image informative : alternative équivalente complète;
- nouvelle fenêtre : information dans le nom accessible;
- les informations ne reposent pas sur CSS, couleur ou pseudo-élément seul;
- les listes, titres, paragraphes et tableaux restent compréhensibles sans CSS.

### Composants DSFR

Inspecter le DOM généré par la version installée. Corriger d’abord l’utilisation locale et les props. Si le composant de dépendance ne permet pas un rendu conforme :

1. documenter le défaut;
2. créer un composant local conforme ou un wrapper;
3. éviter toute modification de `node_modules`;
4. n’augmenter une dépendance qu’avec justification et validation de non-régression.

### Cartographie et contenus tiers

La carte et l’iframe Tally étaient exemptées dans l’audit, mais :

- le titre et l’insertion de l’iframe restent à corriger;
- les mécanismes locaux de focus restent à corriger;
- les informations essentielles de localisation/restriction doivent disposer d’une alternative accessible;
- l’exemption ne permet pas de supprimer l’accès clavier à une fonctionnalité indispensable sans alternative.

## 8. Définition de terminé

L’intervention n’est terminée que lorsque :

- toutes les lignes de la matrice sont qualifiées;
- toutes les lignes applicables sont `FIXED` ou `ALREADY_OK` avec preuve;
- aucun fichier admin n’a été modifié;
- le flux critique adresse -> consultation des restrictions fonctionne au clavier;
- les sélecteurs profil/type/zone sont correctement nommés;
- les changements de route, résultats et pagination sont annoncés;
- les modales sont utilisables au clavier et sous lecteur d’écran;
- le contenu est utilisable à 320 px et à 400 % de zoom;
- les contrastes visés sont mesurés;
- lint, tests unitaires, build et tests e2e publics sont verts, ou toute impossibilité d’environnement est documentée;
- un contrôle manuel des pages critiques est consigné;
- la déclaration d’accessibilité n’est pas déclarée « totalement conforme » sans audit formel le justifiant.

## 9. Reconnaissance rapide de `develop`

Constats utiles avant démarrage, à confirmer par Codex :

- `layouts/basic.vue` contient déjà les liens d’évitement et un `<main role="main" id="main-content">`;
- le logo opérateur utilise déjà le nom de l’application comme alternative;
- `Gestes.vue` contient déjà une alternative détaillée du graphique avec « Source : Ademe »;
- `TypesEau.vue` utilise déjà des alternatives vides pour les illustrations;
- `Faq.vue` utilise déjà des titres de questions `h4` et le texte de contact est un paragraphe;
- `Liens.vue` ajoute déjà une mention « nouvelle fenêtre » dans les titles;
- la combobox actuelle reste problématique : `aria-expanded` constant, `tabindex` positif, options dans l’ordre de tabulation et relation d’option active incomplète;
- l’image de newsletter porte encore un alt probablement décoratif;
- l’illustration « données » porte un `title` mais pas d’alt explicite;
- `SituationStatus.vue` contient des IDs dupliqués et une prop `titile` mal orthographiée;
- plusieurs constats de restriction ont été partiellement corrigés, mais les modales et annonces de statut nécessitent encore une validation;
- les tableaux/paginations DSFR doivent être vérifiés dans le DOM rendu, car les templates Vue ne suffisent pas.

Ces observations ne remplacent pas la matrice : elles servent à éviter les corrections aveugles.

### Suivi d'exécution — baseline WP0 du 10/08/2026

Référence de départ : branche `develop`, commit `9aa6472`, worktree propre. La
baseline a été exécutée avec Node `24.16.0` et npm `11.17.0` via `npx`, car le
`npm` installé globalement avec cette version de Node est désormais en version
12. Aucun fichier admin n'a été modifié.

Convention de preuve retenue : chaque état fermé de la matrice renvoie à un
fichier ou à une zone du DOM, à une commande automatisée et, lorsque le critère
l'exige, à la ligne correspondante de la matrice manuelle. Un scan axe seul
n'est jamais utilisé pour fermer un ticket.

Routes publiques inventoriées :

```text
/
/abonnements
/abonnements/nouveau
/accessibilite
/carte
/cookies
/donnees
/donnees/carte-commune
/donnees/carte-historique
/donnees/commune/:code_insee
/donnees/departement
/donnees/surface
/donnees-personnelles
/emails
/emails/smgc
/mentions-legales
/situation
/stats
```

Résultats de référence :

| Contrôle | Résultat WP0 | Preuve |
|---|---|---|
| Installation publique verrouillée | OK | `npx npm@11.17.0 --prefix apps/frontend ci` : 1 721 paquets installés, lockfile inchangé. |
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 40/40 tests réussis. |
| Build public | OK | `npm@11.17.0 --prefix apps/frontend run build` : génération Nuxt réussie, 23 routes pré-rendues. |
| Lint public | ÉCHEC PRÉEXISTANT | 353 erreurs et 778 avertissements avant remédiation; dette mesurée, à ne pas confondre avec les régressions des lots. |
| Cypress historique `accueil.cy.js` | ÉCHEC PRÉEXISTANT | 2/6 tests réussis; quatre sélecteurs/assertions sont obsolètes alors que l'interface est rendue. Les scénarios seront remplacés par des assertions métier et RGAA stables. |
| Scan axe WCAG A/AA des routes statiques critiques | OK INSUFFISANT SEUL | 7/7 pages sans violation automatique (`/`, accessibilité, cookies, mentions légales, abonnement, données, carte), mais le contrôle manuel et le DOM démontrent des écarts non détectés. |
| DOM hydraté | CONTRÔLÉ | Chrome Headless sur le serveur Nuxt local : `main`, liens d'évitement, header/footer, images, FAQ, combobox, tabs et liens externes inspectés. |

Écarts actuels complémentaires découverts pendant WP0 et à traiter dans les
lots correspondants :

- HTML invalide produisant des paragraphes vides ou une réorganisation du DOM
  (`pages/accessibilite`, `pages/cookies`, `pages/donnees-personnelles`, carte
  communale et légendes de sélecteurs) ;
- paragraphe de description vide généré par le footer DSFR sur toutes les
  routes ;
- routes actuelles non présentes dans l'échantillon 2024 (`/stats`,
  `/emails/**`, plusieurs routes `/donnees/**` et `/donnees-personnelles`) à
  inclure dans la régression finale ;
- déclaration publique fondée sur un audit Temesis de janvier 2025 (65,38 %),
  plus récent que le rapport 2024 à l'origine de cette matrice. Les constats
  affichés par cette déclaration restent ouverts tant qu'ils ne sont pas
  démontrés corrigés.

Répartition des lignes sans lot explicite : `COOKIE-01` est qualifiée dans WP1,
`HOME-03` dans WP1 (navigation et focus SPA) et `HOME-04` dans WP2 (image
décorative). `SH-02` appartient à WP1; WP5 ne réouvrira que les interactions
spécifiques au flux situation. WP9 reste propriétaire de la conformité des
documents, même lorsque leur lien est corrigé dans un lot antérieur.

## 10. Lots de travail et commits

### WP0 - Baseline et matrice

- relever les pages/routes actuelles;
- exécuter les tests existants;
- prendre un état de référence des parcours clavier;
- qualifier chaque ligne `TODO`, `ALREADY_OK`, `N/A_CURRENT_UI` ou ouverte;
- ne corriger aucun code tant que la cartographie n’est pas suffisamment fiable.

Commit suggéré :

```text
test(a11y): establish RGAA remediation baseline
```

### WP1 - Shell, navigation SPA et focus

Couvre `G-03`, `G-04`, `HDR-*`, `FTR-*`, `SH-02`, `SH-03`.

Commit suggéré :

```text
fix(a11y): restore public navigation and SPA focus semantics
```

### WP2 - Contrastes, images et liens externes partagés

Couvre `G-01`, `NEWS-01`, `CONS-*`, `LINK-*`, occurrences de nouvelle fenêtre et images décoratives.

Commit suggéré :

```text
fix(a11y): correct shared contrast image and link semantics
```

### WP3 - Combobox adresse

Couvre `ADR-01` à `ADR-08`, plus `HOME-01` et `HOME-02`.

Ajouter des tests clavier précis : flèches, Entrée, Échap, Tab, clic, liste vide, chargement, sélection, reprise de saisie.

Commit suggéré :

```text
fix(a11y): implement an accessible address combobox
```

### WP4 - Formulaires et abonnement

Couvre `NEWS-02` à `NEWS-07`, formulaire de recherche principal et soumission au clavier.

Commit suggéré :

```text
fix(a11y): make public forms and validation accessible
```

### WP5 - Choix profil/type/zone, fil d’Ariane et Tally

Couvre `SH-02`, `SH-04` à `SH-07`.

Commit suggéré :

```text
fix(a11y): correct public selectors breadcrumbs and feedback flow
```

### WP6 - Carte, tableau, pagination et responsive

Couvre `G-02`, `HOME-05` à `HOME-18`.

C’est un lot risqué : inspecter le DOM DSFR et ajouter des tests e2e ciblés. Si la pagination de dépendance est non conforme, créer une implémentation locale testée.

Commit suggéré :

```text
fix(a11y): repair public map data table and pagination
```

### WP7 - Contenus éditoriaux, gestes, FAQ et liens utiles

Couvre `GEST-*`, `FAQ-*`, `SH-01`, HTML injecté par `v-html`.

Corriger aussi le HTML malformé, sans réécrire le fond éditorial.

Commit suggéré :

```text
fix(a11y): correct public content hierarchy and list semantics
```

### WP8 - Situation, restrictions et modales

Couvre `SIT-01`, `CRISIS-01` à `CRISIS-12`, plus les annonces de changement de profil/type/zone.

Commit suggéré :

```text
fix(a11y): make restriction cards and dialogs accessible
```

### WP9 - Pages institutionnelles et documents

Couvre `DOC-01`, `ACC-01`, `LEG-*` et tous les PDF dynamiques ou statiques.

Ne pas prétendre corriger un PDF externe avec un attribut de lien. Produire l’alternative ou documenter le blocage.

Commit suggéré :

```text
fix(a11y): provide accessible public document alternatives
```

### WP10 - Régression finale et preuves

- audit clavier complet;
- 320 px, zoom 200 % texte et 400 % interface;
- contrôle de contraste;
- lecture linéaire sans CSS;
- NVDA/Firefox ou NVDA/Chrome sur les parcours critiques;
- exécution des commandes de validation;
- fermeture de la matrice;
- revue globale du diff contre la branche de départ.

Commit suggéré :

```text
docs(a11y): close RGAA remediation matrix with evidence
```

## 11. Matrice exhaustive issue par issue

Dans la colonne **État / preuve**, remplacer `TODO` et ajouter les preuves au fil du travail.

### A. Éléments globaux, gabarits et navigation
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `G-01` | § 8.1, p. 12 | 3.2 | Majeur | Corriger les contrastes insuffisants des libellés de niveaux « Alerte » et « Alerte renforcée ». Vérifier tous les usages actuels des couleurs, pas seulement la capture de 2024. Seuils : 4,5:1 pour le texte courant, 3:1 pour le grand texte. | `apps/frontend/client/**` ; rechercher les classes `situation-level-*`, badges et variables de couleurs. | PROBABLEMENT OUVERT : `SituationHeader.vue` contient encore une couleur personnalisée `#A18E3A`; mesurer le rendu réel. | `TODO` |
| `G-02` | § 8.2, p. 13 | 10.11 | Bloquant | À 320 px de largeur, aucun contenu ni contrôle utile ne doit disparaître et aucun défilement horizontal global ne doit être requis. Couvrir notamment carte/données, tableaux, filtres et pagination. | `components/carte/**`, `components/donnees/**`, pages `/carte` et `/donnees`, styles globaux. | OUVERT À REVALIDER : les composants et l’architecture ont changé depuis 2024. | `TODO` |
| `G-03` | § 9.1, p. 13-14 | 9.2, 12.6 | Majeur / mineur | Une zone principale unique doit être exposée et atteignable/évitable. Vérifier le DOM rendu, le lien d’évitement, l’unicité de `main` et la cible `#main-content`. | `client/layouts/basic.vue`, composants DSFR de layout. | SEMBLE DÉJÀ CORRIGÉ : `<main role="main" id="main-content">` et liens d’évitement présents; ne pas modifier sans échec démontré. | `ALREADY_OK` — DOM hydraté WP0 : une seule cible `<main role="main" id="main-content">`; les deux liens d’évitement ciblent le contenu et le footer. Le CSS DSFR public importé rend `.fr-skiplinks:focus-within` relatif, opaque et sans translation. |
| `G-04` | § 10.1, p. 14-16 | 6.1, 7.1, 8.5, 8.6, 12.8 | Majeur | Pour toute navigation SPA : employer lien ou bouton selon le comportement, mettre à jour le titre de page, annoncer le changement et placer le focus à un emplacement logique sans casser l’historique ni la navigation clavier. | `client/app.vue`, pages, middleware, router-links, utilitaires de navigation. | PROBABLEMENT OUVERT : les pages définissent souvent `useHead`, mais aucun gestionnaire global de focus de route n’est visible. | `TODO` |
| `HDR-01` | § 11.1, p. 16 | 1.3 | Mineur | L’alternative du logo opérateur doit être pertinente et ne pas contenir « logo du produit ». | `client/layouts/basic.vue` et rendu de `DsfrHeader`. | SEMBLE DÉJÀ CORRIGÉ : l’alternative vaut le nom de l’application. | `ALREADY_OK` — DOM hydraté WP0 : l’image opérateur du header expose `alt="VigiEau"`; `layouts/basic.vue` alimente cette valeur depuis `appName`. |
| `HDR-02` | § 11.2, p. 16-17 | 10.2, 7.1 | Majeur | Le bouton du menu mobile doit avoir un nom accessible en contenu réel/masqué, et déclarer correctement qu’il ouvre une boîte de dialogue (`aria-haspopup="dialog"` si nécessaire). | `client/layouts/basic.vue`, `DsfrHeader`, version installée de `@gouvminint/vue-dsfr`. | À VÉRIFIER DANS LE DOM RENDU : ne pas patcher la dépendance si une prop suffit. | `ALREADY_OK` — DOM hydraté à 320 px WP0 : `#button-menu` expose `aria-label="Menu"`, `title="Menu"`, `aria-controls="header-navigation"` et `aria-haspopup="dialog"`; l’icône CSS est décorative. Le comportement de focus reste dans `HDR-04`. |
| `HDR-03` | § 11.3, p. 17 | 7.1 | Majeur | La boîte de dialogue du menu mobile doit avoir un nom pertinent, sans terme technique tel que « modal ». | `client/layouts/basic.vue`, `DsfrHeader`. | SEMBLE PARTIELLEMENT CORRIGÉ : `menuModalLabel="Menu"`; vérifier le rendu. | `ALREADY_OK` — DOM hydraté à 320 px WP0 : `#header-navigation[role="dialog"][aria-modal="true"][aria-label="Menu"]`. Les autres exigences de focus restent dans `HDR-02`/`HDR-04`. |
| `HDR-04` | § 11.4, p. 17-18 | 12.8 | Majeur | À l’ouverture du menu mobile, positionner le focus dans la boîte de dialogue, le contenir jusqu’à fermeture, restaurer le focus sur le déclencheur et supprimer toute imbrication de `nav` inutile. | `DsfrHeader` rendu et éventuels overrides locaux. | À TESTER MANUELLEMENT AU CLAVIER ET SOUS LECTEUR D’ÉCRAN. | `TODO` |
| `FTR-01` | § 12.1, p. 18-19 | 6.1 | Majeur | Les liens de retour à l’accueil et leurs images doivent avoir un intitulé cohérent avec le contenu visible. Éviter deux liens concurrents et conserver une alternative « VigiEau » pertinente. | `client/layouts/basic.vue`, rendu de `DsfrFooter`. | SEMBLE DÉJÀ CORRIGÉ : `homeTitle="Accueil VigiEau"` et alt opérateur; vérifier le DOM. | `ALREADY_OK` — DOM hydraté WP0 : un lien de marque footer `title="Accueil VigiEau"` contient l’unique image opérateur `alt="VigiEau"`. |
| `FTR-02` | § 12.2, p. 19 | 6.1, 10.2 | Majeur | Tout lien ouvrant une nouvelle fenêtre doit l’annoncer de façon accessible. Centraliser la règle si possible; l’icône CSS seule ne suffit pas. Le nom accessible doit conserver le libellé visible. | Tous les `target="_blank"` dans `apps/frontend/client/**`, données HTML/JSON et composants DSFR. | PARTIELLEMENT CORRIGÉ : plusieurs liens ont un `title`, mais des liens dynamiques et ceux de `SituationHeader.vue` restent à vérifier. | `TODO` |
| `COOKIE-01` | § 13, p. 19 | À requalifier | À vérifier | Le rapport n’observait aucun bandeau/modale de cookies. Si un mécanisme existe désormais, l’auditer comme toute boîte de dialogue : nom, focus, fermeture, arrière-plan inerte et restitution des choix. | `client/pages/cookies/**`, configuration Matomo/consentement et composants chargés au runtime. | NOUVEAU PÉRIMÈTRE POSSIBLE : ne pas conclure N/A sans inspection. | `N/A_CURRENT_UI` — recherche source WP0 et DOM des routes publiques : aucun bandeau/dialogue de consentement; `matomo.client.ts` déclare `requireConsent: false` et `requireCookieConsent: false`, la page `/cookies` documentant l’exemption. Le HTML invalide de cette page reste un écart complémentaire WP7/WP9. |

### B. Documents téléchargeables
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `DOC-01` | § 14.1, p. 20-21 | 13.3 | Bloquant | Les PDF cités doivent être accessibles ou disposer d’une alternative accessible équivalente en HTML/DOCX. Documenter précisément toute exemption applicable; ne pas la présumer. | `client/data/faq.json`, liens vers Guide circulaire, synthèse usages, instruction ORSEC et autres PDF; fichiers éventuellement hors dépôt. | BLOCAGE CONTENU POSSIBLE : si le PDF est externe et non maîtrisé, créer une alternative HTML utile ou consigner le propriétaire/la décision. Ne jamais marquer « corrigé » avec un simple changement de `title`. | `TODO` |

### C. Combobox de recherche d’adresse
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `ADR-01` | § 15.2, p. 22 | 11.2, 8.9 | Bloquant / mineur | Le libellé visible « Entrez votre adresse complète » doit être le nom accessible effectif du champ et être associé explicitement. Aucun libellé masqué contradictoire. | `components/FdrAutoComplete.vue`, `components/mixins/SearchAddress.vue`. | PARTIELLEMENT CORRIGÉ : le libellé visible est désormais transmis; vérifier les IDs générés et le nom calculé. | `TODO` |
| `ADR-02` | § 15.3, p. 23 | 7.1 | Majeur | Exposer un vrai pattern combobox : `role=combobox`, `aria-autocomplete=list`, `aria-expanded` dynamique, `aria-controls` vers la listbox, `aria-haspopup=listbox` si utile et relation active cohérente. | `components/FdrAutoComplete.vue`. | OUVERT : `aria-expanded` est actuellement toujours `true`, `aria-haspopup` reçoit un booléen et aucune relation `aria-controls`/`aria-activedescendant` n’est visible. | `TODO` |
| `ADR-03` | § 15.4, p. 24 | 11.10 | Majeur | Indiquer visuellement et programmatiquement le caractère obligatoire; ne pas se contenter de la validation après soumission. | `FdrAutoComplete.vue`, `SearchAddress.vue`, usages dans `Search.vue` et `MailForm.vue`. | PARTIELLEMENT CORRIGÉ : prop `required` présente; vérifier le texte visible généré par DSFR. | `TODO` |
| `ADR-04` | § 15.5, p. 25 | 11.10 | Majeur | L’exemple d’adresse doit être un texte d’aide persistant associé au champ par `aria-describedby`, pas seulement un placeholder. | `FdrAutoComplete.vue` (`hint`) et DOM généré par `DsfrInput`. | SEMBLE CORRIGÉ VIA `hint`, À VÉRIFIER DANS LE DOM. | `TODO` |
| `ADR-05` | § 15.6, p. 26 | 11.13 | Majeur | Utiliser un `autocomplete` pertinent (`street-address` ou valeur RGAA/HTML adaptée au champ complet). Ne pas désactiver arbitrairement le remplissage automatique; justifier tout changement dynamique. | `FdrAutoComplete.vue`. | À RECONCEVOIR : le code bascule actuellement entre `off` et `address-line1` selon le focus. | `TODO` |
| `ADR-06` | § 15.7, p. 26-27 | 7.1 | Majeur | La liste doit être une `listbox` nommée; chaque suggestion une `option` avec état sélectionné cohérent et IDs stables. | `FdrAutoComplete.vue`. | PARTIEL : rôles présents, mais vérifier nom non vide, IDs, sélection et DOM. | `TODO` |
| `ADR-07` | § 15.8, p. 28 | 7.5 | Majeur | Annoncer le nombre de suggestions au moyen d’une zone de statut existant avant la mise à jour, sans bavardage excessif ni annonces doublées. | `FdrAutoComplete.vue`. | PARTIEL : une zone `aria-live` existe; vérifier son apparition (`v-show`), son comportement et le libellé. | `TODO` |
| `ADR-08` | § 15.9, p. 29 | 7.1, 12.8 | Bloquant | La navigation clavier doit suivre un pattern combobox valide : flèches, Entrée, Échap, Tab, souris; l’option active doit être exposée. Aucun `tabindex` positif; éviter que chaque option ajoute un arrêt de tabulation. | `FdrAutoComplete.vue` et tests. | OUVERT : `ul tabindex="1"`, options `tabindex="0"`, sélection et option active ne sont pas correctement reliées. Corriger sans reproduire aveuglément l’ancien exemple de déplacement de focus. | `TODO` |

### D. Abonnement / « Restez informé »
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `NEWS-01` | § 15.11, p. 30 | 1.2 | Mineur | L’illustration de la newsletter, si décorative, doit avoir `alt=""` et aucun `title` redondant. | `components/mixins/Email.vue`. | PROBABLEMENT OUVERT : alt actuel « Newsletter email ». | `TODO` |
| `NEWS-02` | § 15.12, p. 31 | 7.1 | Majeur | Si l’inscription utilise encore une modale : nom valide, `aria-modal=true`, arrière-plan non exposé et focus géré. Si le flux est désormais une page, classer l’ancien ticket `N/A_CURRENT_UI` et auditer la page équivalente. | `pages/abonnements/**`, `components/mail/MailForm.vue`, anciennes modales éventuelles. | FLUX 2024 SEMBLE REMPLACÉ PAR UNE PAGE : ne pas appliquer une correction de modale inexistante. | `N/A_CURRENT_UI` — le déclencheur ouvre la route `/abonnements/nouveau`, confirmée dans le DOM hydraté WP0; les modales de résultat et le formulaire équivalent restent audités par `NEWS-03` à `NEWS-07`. |
| `NEWS-03` | § 15.13, p. 32 | 7.1, 8.9, 11.5-11.7 | Majeur / mineur | Regrouper les choix de profil sous un `fieldset`/`legend` explicite ou un composant natif équivalent; chaque contrôle doit être compréhensible isolément. | `components/mixins/Profile.vue`, `components/mail/MailForm.vue`. | À VÉRIFIER DANS LE DOM GÉNÉRÉ. | `TODO` |
| `NEWS-04` | § 15.14, p. 32-33 | 11.10, 11.11, 11.13 | Majeur | Pour l’e-mail : aide persistante, exemple de format, message de correction utile, `autocomplete=email`, type de champ approprié et association des erreurs. | `components/mail/MailForm.vue`. | PARTIELLEMENT CORRIGÉ : hint et autocomplete présents; le champ est encore `type=text`, et les associations d’erreurs doivent être vérifiées. | `TODO` |
| `NEWS-05` | § 15.15, p. 33 | 6.1, 10.2 | Majeur | Le lien vers les données personnelles ouvert dans une nouvelle fenêtre doit l’annoncer de manière accessible. | `components/mail/MailForm.vue`. | SEMBLE CORRIGÉ PAR `title`; vérifier nom accessible. | `TODO` |
| `NEWS-06` | § 15.16, p. 34 | 11.10 | Majeur | Tous les champs obligatoires (profil, type d’eau, adresse/point, e-mail, consentement) doivent être annoncés avant interaction et porter les attributs pertinents. | `MailForm.vue`, `Profile.vue`, `SearchAddress.vue`, composants DSFR. | PARTIELLEMENT CORRIGÉ; vérifier le rendu et les groupes. | `TODO` |
| `NEWS-07` | § 15.17, p. 35 | 11.10, 11.11 | Majeur | Chaque erreur doit nommer le champ, être liée au contrôle (`aria-describedby` ou mécanisme équivalent), activer `aria-invalid=true`, être retirée/corrigée ensuite et être annoncée au bon moment. | `MailForm.vue`, utilitaire `showInputError`, `DsfrInputGroup` rendu. | OUVERT À TESTER : les props d’erreur existent, mais la relation DOM n’est pas démontrée. | `TODO` |

### E. Consommation, gestes, liens utiles et FAQ
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `CONS-01` | § 15.19, p. 36 | 1.3 | Bloquant | L’alternative du graphique doit restituer toutes les données utiles et inclure « Source : Ademe »; supprimer tout `title` contradictoire. | `components/accueil/Gestes.vue`, ressource `/repartition_consommation.svg`. | SEMBLE DÉJÀ CORRIGÉ : alt détaillé avec source; vérifier le DOM de `DsfrPicture`. | `ALREADY_OK` — DOM hydraté WP0 : `DsfrPicture` rend les neuf parts, leurs pourcentages et « Source : Ademe » dans `alt`, avec `title=""`; la légende visible donne aussi la source. |
| `CONS-02` | § 15.20, p. 37 | 1.2 | Mineur | L’illustration du calculateur, si décorative, doit être ignorée (`alt=""`) et sans `title`. | `components/gestes/Callout.vue` et composants associés. | À VÉRIFIER. | `ALREADY_OK` — DOM hydraté WP0 et `components/gestes/Callout.vue` : `/callout_simulateur.svg` rend `alt=""` sans attribut `title`. |
| `CONS-03` | § 15.21, p. 37 | 6.1, 10.2 | Majeur | Le lien vers le calculateur externe doit annoncer la nouvelle fenêtre. | `components/gestes/Callout.vue`. | À VÉRIFIER. | `TODO` |
| `GEST-01` | § 15.23, p. 38 | 8.9 | Mineur | Le texte introductif « En plus des restrictions… » doit être un vrai paragraphe. | `components/accueil/Gestes.vue`. | SEMBLE DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : le texte complet est porté par un élément `<p>`. |
| `GEST-02` | § 15.24, p. 38 | 7.1 | Majeur | Ne pas exposer une tablist vide ni des rôles `tabpanel` sans onglets valides. Si l’interface actuelle utilise des boutons/tags pour filtrer, choisir un pattern unique et conforme; ne pas neutraliser les rôles avec `role=""` sans vérifier le DOM final. | `components/accueil/Gestes.vue`, `components/situation/Restrictions.vue`, `DsfrTabs`. | PROBABLEMENT OUVERT/PARTIEL : `DsfrTabs` est utilisé avec des tags externes et `role=""`. | `TODO` |
| `GEST-03` | § 15.25, p. 39 | 8.9, 9.3 | Mineur | Structurer chaque éco-geste en paragraphe cohérent ou l’ensemble en liste; le sens doit rester clair sans CSS. | `components/gestes/Card.vue`, `data/gestes.json`. | À VÉRIFIER. | `TODO` |
| `LINK-01` | § 15.27, p. 40 | 8.9 | Mineur | Le texte introductif « Toutes les ressources… » doit être un paragraphe. | `components/accueil/Liens.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : l’introduction est un élément `<p>` précédant la liste de ressources. |
| `LINK-02` | § 15.28, p. 40 | 6.1, 10.2 | Majeur | Tous les liens utiles externes doivent annoncer la nouvelle fenêtre et conserver un intitulé explicite. | `components/accueil/Liens.vue`, `data/liens.json`. | SEMBLE CORRIGÉ PAR `title`; vérifier le DOM et `rel=noopener`/`external`. | `TODO` |
| `FAQ-01` | § 15.30, p. 41 | 9.3 | Majeur | Les titres de catégories ne doivent pas être enfants directs d’une liste d’accordéons si la structure HTML l’interdit. Vérifier le DOM rendu par `DsfrAccordionsGroup`. | `components/accueil/Faq.vue`. | PARTIELLEMENT CORRIGÉ VISUELLEMENT; le DOM du composant DSFR doit être inspecté. | `TODO` |
| `FAQ-02` | § 15.31, p. 41-42 | 9.1 | Majeur | Les questions doivent avoir le niveau de titre attendu (`h4` dans la hiérarchie actuelle). | `components/accueil/Faq.vue`. | SEMBLE DÉJÀ CORRIGÉ avec `titleTag="h4"`. | `ALREADY_OK` — DOM hydraté WP0 : chaque catégorie est un `h3` et chaque `fr-accordion__title` rendu est un `h4`. |
| `FAQ-03` | § 15.32, p. 42 | 9.3 | Majeur | La liste des causes de sécheresse doit être une vraie liste non ordonnée. | `client/data/faq.json`. | SEMBLE CORRIGÉ, mais corriger le HTML malformé/typos (`&nbps;`) et tester le rendu `v-html`. | `TODO` |
| `FAQ-04` | § 15.33, p. 43 | 9.3 | Majeur | Les quatre niveaux d’alerte doivent être une liste ordonnée. | `client/data/faq.json`. | SEMBLE DÉJÀ CORRIGÉ. | `ALREADY_OK` — contenu et DOM hydraté WP0 : les quatre niveaux sont les quatre items d’un `<ol>`. |
| `FAQ-05` | § 15.34, p. 44 | 9.3 | Majeur | Les axes du plan d’action doivent être une liste; les flèches purement décoratives doivent être masquées aux TA. | `client/data/faq.json`. | SEMBLE DÉJÀ CORRIGÉ, à valider. | `ALREADY_OK` — contenu et DOM hydraté WP0 : trois items dans un `<ul>`; chaque flèche est dans un `<span aria-hidden="true">`. |
| `FAQ-06` | § 15.35, p. 44 | 6.1, 10.2 | Majeur | Les liens externes de la réponse sur le plan d’action doivent annoncer la nouvelle fenêtre. | `client/data/faq.json`. | PARTIELLEMENT CORRIGÉ; vérifier tous les liens injectés par `v-html`. | `TODO` |
| `FAQ-07` | § 15.36, p. 45 | 9.3 | Majeur | L’énumération de la réponse sur les pouvoirs du maire doit être structurée en liste. Conserver le type de liste conforme au sens; le rapport proposait `ol`, le contenu actuel utilise `ul`, à arbitrer selon l’ordre sémantique. | `client/data/faq.json`. | À REQUALIFIER : ne pas transformer en `ol` sans justification sémantique. | `ALREADY_OK` — contenu et DOM hydraté WP0 : les trois compétences indépendantes sont dans un `<ul>`; l’ordre n’exprime ni procédure ni classement, donc une liste non ordonnée est sémantiquement correcte. |
| `FAQ-08` | § 15.37, p. 45 | 6.1, 10.2, 13.3 | Majeur / bloquant contenu | Les liens de la réponse sur l’arrosage doivent annoncer la nouvelle fenêtre; traiter aussi l’accessibilité des PDF liés. | `client/data/faq.json`. | PARTIELLEMENT CORRIGÉ POUR LES LIENS, DOCUMENTS ENCORE À TRAITER. | `TODO` |
| `FAQ-09` | § 15.38, p. 45 | 6.1, 10.2 | Majeur | Le lien vers la qualité de l’eau doit annoncer la nouvelle fenêtre. | `client/data/faq.json`. | SEMBLE CORRIGÉ. | `TODO` |
| `FAQ-10` | § 15.39, p. 45 | 6.1, 10.2, 13.3 | Majeur / contenu | Le lien/PDF de la réponse hôpitaux-EHPAD doit annoncer la nouvelle fenêtre et offrir une version accessible si nécessaire. | `client/data/faq.json`. | À VÉRIFIER ET TRAITER CÔTÉ DOCUMENT. | `TODO` |
| `FAQ-11` | § 15.40, p. 46 | 6.1, 10.2, 13.3 | Majeur / contenu | Le lien/PDF sur l’approvisionnement en cas de coupure doit annoncer la nouvelle fenêtre et offrir une alternative accessible. | `client/data/faq.json`. | À VÉRIFIER ET TRAITER CÔTÉ DOCUMENT. | `TODO` |
| `FAQ-12` | § 15.41, p. 46 | 9.3 | Majeur | Les solutions d’approvisionnement doivent être structurées en liste; masquer les flèches décoratives si présentes. | `client/data/faq.json`. | À VÉRIFIER. | `TODO` |

### F. Composants partagés hors contenu éditorial
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `SH-01` | § 15.42, p. 46 | 8.9 | Mineur | Le texte « Vous souhaitez nous poser… » doit être un paragraphe. | `components/accueil/Faq.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : le texte et son lien de contact sont contenus dans un `<p>`. |
| `SH-02` | § 15.43, p. 47 | 7.1, 12.8 | Majeur | Sur mobile, le bouton d’affichage du fil d’Ariane ne doit pas exposer d’état/relations inadaptés; après activation, déplacer le focus vers le fil ou le lien Accueil. | `DsfrBreadcrumb` sur pages accessibilité, mentions légales et situation. | À TESTER DANS LE DOM/COMPORTEMENT DE LA VERSION DSFR INSTALLÉE. | `TODO` |
| `SH-03` | § 15.44, p. 47-48 | 12.8 | Majeur | Après activation d’un lien interne qui remplace le contenu sans rechargement, appliquer la stratégie SPA de titre et focus. | Footer, header, quick links, FAQ/CTA et router-links. | PROBABLEMENT OUVERT GLOBAL. | `TODO` |
| `SH-04` | § 15.45, p. 48 | 11.1 | Bloquant | Chaque `select` du choix de type/profil/zone doit avoir une étiquette accessible unique. Préférer `label`/`aria-labelledby` à un `title` seul quand possible. | `components/situation/Status.vue`. | OUVERT : props `titile` mal orthographiée, IDs `profile` dupliqués et labels visuels séparés. | `TODO` |
| `SH-05` | § 15.46, p. 49 | 8.9, 11.5 | Majeur | Regrouper les sélecteurs liés dans un `fieldset`/`legend`; ne pas utiliser de titres pour la présentation; garder une phrase intelligible en lecture linéaire. | `components/situation/Status.vue` versions desktop/mobile. | PARTIEL : fieldsets présents, mais labels/IDs, texte intercalé et duplication doivent être corrigés. | `TODO` |
| `SH-06` | § 15.47, p. 50 | 12.8 | Majeur | Après activation de « Donner mon avis », placer le focus dans le panneau/formulaire Tally ou sur un conteneur de remplacement pertinent. | `client/layouts/basic.vue`, `utils.openTally`, intégration Tally. | À LOCALISER ET TESTER SUR MOBILE. | `TODO` |
| `SH-07` | § 15.48, p. 51-52 | 2.2, 10.1 | Majeur / mineur | L’iframe Tally doit avoir un titre français explicite (« VigiEau - retours utilisateurs ») et aucun attribut HTML de présentation obsolète. | Intégration Tally dans utilitaires/scripts/runtime. | À LOCALISER; l’iframe tierce est exemptée pour son contenu, pas pour son titre et son insertion. | `TODO` |

### G. Page d’accueil, carte et données
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `HOME-01` | § 16.1, p. 53 | 12.8 | Majeur | Après activation du bouton de recherche de la combobox, conserver/replacer le focus dans le champ selon le comportement prévu. | `FdrAutoComplete.vue`, `SearchAddress.vue`. | PARTIEL : la sélection refocalise l’input, mais tester tous les chemins. | `TODO` |
| `HOME-02` | § 16.2, p. 54 | 12.8 | Majeur | Après géolocalisation réussie ou échouée, gérer le focus et annoncer le résultat/erreur. | `components/mixins/SearchAddress.vue`. | PARTIEL : succès refocalise l’input; erreur silencieuse et statut non annoncé. | `TODO` |
| `HOME-03` | § 16.3, p. 54 | 12.8 | Majeur | Après soumission « Je consulte les restrictions », gérer le titre et le focus de la route/du résultat; le contrôle reste un bouton de soumission/action pertinent. | `components/mixins/Search.vue`, utilitaire `searchZones`, route `/situation`. | PROBABLEMENT OUVERT. | `TODO` |
| `HOME-04` | § 16.4, p. 55 | 1.2 | Mineur | Les illustrations des types d’eau doivent être décoratives si le texte adjacent porte déjà l’information. | `components/accueil/TypesEau.vue`. | DÉJÀ CORRIGÉ avec `alt-img=""`. | `ALREADY_OK` — DOM hydraté WP0 : les trois images `/type_eau_*.svg` rendent `alt=""`; les intitulés sont portés par les titres de cartes adjacents. |
| `HOME-05` | § 16.5, p. 55 | 8.9 | Mineur | Le sous-titre/date « Arrêtés publiés avant… » doit être un paragraphe. | `components/carte/Wrapper.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — `components/carte/Wrapper.vue` et DOM hydraté WP0 : la date est dans un `<p>` placé après le `h2`. |
| `HOME-06` | § 16.6, p. 56 | 7.1 | Mineur | Chaque onglet doit référencer par `aria-controls` l’ID réel de son panneau. | `components/carte/Wrapper.vue`, rendu `DsfrTabs`. | SEMBLE CONFIGURÉ (`tab-0`/`tab-content-0`), À VÉRIFIER DANS LE DOM. | `TODO` |
| `HOME-07` | § 16.7, p. 56 | 12.8 | Majeur | Les panneaux d’onglets ne doivent pas ajouter d’arrêt de tabulation inutile; supprimer tout `tabindex=0` non justifié. | `DsfrTabContent` rendu. | À VÉRIFIER DANS LE DOM DE LA DÉPENDANCE. | `TODO` |
| `HOME-08` | § 16.8, p. 57 | 7.1, 12.8 | Majeur / amélioration | La carte étant exemptée, fournir une alternative textuelle/données pleinement utilisable. Ne pas laisser des contrôles cartographiques inaccessibles polluer le parcours clavier; ne pas masquer la solution alternative. | `components/carte/Map.vue`, `Wrapper.vue`, `Table.vue`, affichage embarqué sur l’accueil. | À RECONCEVOIR EN FONCTION DU DOM ACTUEL; l’accueil contient désormais une carte interactive avant le formulaire. | `TODO` |
| `HOME-09` | § 16.9, p. 57-58 | 10.3, 8.9 | Majeur / mineur | Chaque niveau et son nombre de départements doivent rester associés sans CSS, idéalement dans le même item de liste/paragraphe. | `components/carte/Table.vue`. | PARTIEL : une liste est utilisée, mais chaque carte contient deux `li` séparés; restructurer en un item cohérent. | `TODO` |
| `HOME-10` | § 16.10, p. 58 | 11.1 | Bloquant | Le champ de filtrage des départements doit avoir une étiquette accessible explicite, pas seulement un placeholder. | `components/carte/Table.vue`, rendu `DsfrSearchBar`. | PARTIEL : `title="Rechercher un département"`; préférer/valider un vrai label. | `TODO` |
| `HOME-11` | § 16.11, p. 58 | 11.9 | Majeur | Le bouton de recherche des départements doit être distingué du bouton d’adresse dans son nom accessible. | `components/carte/Table.vue`, `DsfrSearchBar`. | À VÉRIFIER : `buttonText="Rechercher"` générique malgré le title du champ. | `TODO` |
| `HOME-12` | § 16.12, p. 59 | 7.5 | Majeur | Après filtrage, annoncer le nombre de départements trouvés dans une zone de statut préexistante. | `components/carte/Table.vue`. | OUVERT : aucune zone live visible dans le composant. | `TODO` |
| `HOME-13` | § 16.13, p. 59 | 5.4 | Majeur | Le tableau doit avoir un `caption`/titre correctement associé. | `components/carte/Table.vue`, rendu `DsfrTable` avec prop `title`. | À VÉRIFIER DANS LE DOM : la prop existe, mais classe `fr-table--no-title` peut masquer ou supprimer le titre. | `TODO` |
| `HOME-14` | § 16.14, p. 60 | 5.1, 5.6, 5.7 | Majeur | La pagination ne doit pas être intégrée comme une ligne fusionnée du tableau. Les en-têtes doivent s’appliquer uniquement aux données et l’ensemble rester un tableau simple. | `DsfrTable` rendu / éventuel composant local de table. | À VÉRIFIER; si la dépendance génère encore cette structure, remplacer/encapsuler localement sans modifier `node_modules`. | `TODO` |
| `HOME-15` | § 16.15, p. 60 | 11.1 | Bloquant | Le sélecteur « Résultats par page » doit avoir un label explicite lié par `for`/`id`. | Pagination générée par `DsfrTable`. | À VÉRIFIER DANS LE DOM. | `TODO` |
| `HOME-16` | § 16.16, p. 61 | 7.4 | Majeur | Si le changement de taille de page est automatique, l’annoncer avant interaction dans le nom/aide; sinon ajouter un bouton de validation. Annoncer ensuite la mise à jour. | Pagination générée par `DsfrTable`. | À VÉRIFIER. | `TODO` |
| `HOME-17` | § 16.17, p. 61-62 | 7.1, 10.2 | Bloquant / majeur | Chaque bouton de pagination doit avoir un nom complet et discriminant (première/précédente/suivante/dernière page du tableau). Une icône CSS seule est insuffisante. | Pagination générée par `DsfrTable`. | À VÉRIFIER; bloquant prioritaire. | `TODO` |
| `HOME-18` | § 16.18, p. 62-63 | 7.5 | Majeur | Annoncer le changement de page et le numéro courant dans une zone de statut. | Pagination générée par `DsfrTable`. | À VÉRIFIER; aucune gestion locale visible. | `TODO` |

### H. Pages institutionnelles et situation
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `ACC-01` | § 17.1, p. 63-64 | 6.1, 10.2 | Majeur | Tous les liens externes de la déclaration d’accessibilité doivent annoncer la nouvelle fenêtre. | `pages/accessibilite/index.vue`. | À AUDITER EXHAUSTIVEMENT. | `TODO` |
| `LEG-01` | § 18.1, p. 64 | 6.1, 10.2 | Majeur | Tous les liens externes des mentions légales doivent annoncer la nouvelle fenêtre. | `pages/mentions-legales/index.vue`. | SEMBLE CORRIGÉ POUR beta.gouv; vérifier tout le fichier et le rendu. | `TODO` |
| `LEG-02` | § 18.2, p. 65 | 8.9 | Mineur | Supprimer tout paragraphe vide utilisé pour espacer les sections; utiliser CSS. | `pages/mentions-legales/index.vue`. | SEMBLE DÉJÀ CORRIGÉ; vérifier le DOM rendu. | `ALREADY_OK` — source et DOM hydraté de `/mentions-legales` WP0 : aucun paragraphe vide dans le contenu de la page. Le paragraphe vide distinct généré par le footer partagé reste suivi comme écart complémentaire WP1. |
| `SIT-01` | § 19.1, p. 66 | 8.9 | Mineur | Les messages de situation sans restriction et le conseil d’éco-gestes doivent être de vrais paragraphes. | `components/situation/Header.vue`. | DÉJÀ CORRIGÉ. | `TODO` |
| `CRISIS-01` | § 20.1, p. 67-68 | 8.9 | Mineur | La description du niveau de crise doit être un paragraphe. | `components/situation/Header.vue`. | DÉJÀ CORRIGÉ. | `TODO` |
| `CRISIS-02` | § 20.2.1.1, p. 69 | 9.1 | Majeur | Chaque restriction doit avoir un vrai titre de niveau 3 cohérent. | `components/situation/RestrictionCard.vue`. | DÉJÀ/PARTIELLEMENT CORRIGÉ avec `<h3>`; vérifier la hiérarchie autour. | `TODO` |
| `CRISIS-03` | § 20.2.1.2, p. 69-70 | 7.1 | Majeur | Les boutons d’information identiques doivent être contextualisés par le titre de la restriction via `aria-describedby` ou un nom unique. | `components/situation/RestrictionCard.vue`. | SEMBLE DÉJÀ CORRIGÉ avec ID + `aria-describedby`; vérifier unicité et nom calculé. | `TODO` |
| `CRISIS-04` | § 20.2.2.1, p. 70 | 7.1 | Majeur | La modale d’information doit être modale au sens accessible et rendre l’arrière-plan inerte/non parcourable. | `RestrictionCard.vue`, rendu `DsfrModal`. | À VÉRIFIER DANS LE DOM ET AU CLAVIER. | `TODO` |
| `CRISIS-05` | § 20.2.2.2, p. 71 | 7.1 | Mineur | Le bouton « Annuler » doit expliciter qu’il ferme la boîte de dialogue. | `RestrictionCard.vue`. | SEMBLE DÉJÀ CORRIGÉ avec `title="Annuler et fermer"`; vérifier nom accessible. | `TODO` |
| `CRISIS-06` | § 20.2.2.3, p. 71 | 8.9 | Mineur | Le texte explicatif de la modale doit être structuré en paragraphe. | `RestrictionCard.vue`. | DÉJÀ CORRIGÉ. | `TODO` |
| `CRISIS-07` | § 20.2.2.4, p. 72 | 8.9, 7.5 | Majeur | Le message de succès « Votre retour… » doit être un paragraphe et être annoncé immédiatement (focus contrôlé ou statut live) sans titre vide. | `RestrictionCard.vue`. | PARTIEL : paragraphe présent, mais modale de succès a `title=" "` et aucune annonce explicite visible. | `TODO` |
| `CRISIS-08` | § 20.2.2.5, p. 73 | 10.7, 12.8 | Note majeure de régression | À fermeture, restaurer le focus sur le déclencheur et garantir un indicateur de focus visible. | `RestrictionCard.vue`, styles DSFR. | PARTIEL : restauration explicite du focus présente; vérifier visibilité réelle. | `TODO` |
| `CRISIS-09` | § 20.2.3, p. 73 | 8.9 | Mineur | Le texte sur l’amende doit être un paragraphe, pas une balise de mise en forme. | `components/situation/Restrictions.vue`. | DÉJÀ CORRIGÉ. | `TODO` |
| `CRISIS-10` | § 20.2.4.1, p. 73-74 | 9.1 | Majeur | « Besoin de précision sur les restrictions ? » doit être un vrai `h3` cohérent. | `components/situation/Restrictions.vue` et fallback dans `Status.vue`. | PARTIEL : `Restrictions.vue` utilise `<h3>`, mais `Status.vue` utilise encore `<b>` dans `DsfrHighlight`. | `TODO` |
| `CRISIS-11` | § 20.2.4.2, p. 74 | 8.9 | Mineur | Remplacer les doubles `<br>` de mise en forme par des paragraphes séparés. | `components/situation/Status.vue`, `Restrictions.vue`. | OUVERT DANS LE FALLBACK `Status.vue` (`<b>` + `<br>`). | `TODO` |
| `CRISIS-12` | § 20.2.4.3, p. 74 | 6.1, 10.2, 13.3 | Majeur / contenu | Les liens vers arrêtés PDF doivent annoncer la nouvelle fenêtre; vérifier l’accessibilité des documents ou fournir une alternative. | `components/situation/Header.vue`, `Restrictions.vue`, documents fournis par API. | PARTIEL : certains liens ont un title, celui de l’arrêté municipal n’en a pas; documents dynamiques à traiter/documenter. | `TODO` |

## 12. Matrice de validation manuelle

Créer des preuves datées pour les routes réellement présentes sur `develop`.

| Parcours / page | 320 px | Zoom 200 % texte | Zoom 400 % | Clavier seul | Lecteur d’écran | Sans CSS / ordre DOM | Contrastes | Résultat |
|---|---|---|---|---|---|---|---|---|
| Accueil - sélection profil/type + adresse | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Accueil - carte et alternative données | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Page données - filtre/tableau/pagination | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Abonnement - tous les cas d’erreur | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Situation sans restriction | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Situation avec restrictions/crise | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Modale « Je ne comprends pas… » | TODO | N/A | N/A | TODO | TODO | N/A | TODO | TODO |
| Menu mobile | TODO | TODO | TODO | TODO | TODO | N/A | TODO | TODO |
| Fil d’Ariane mobile | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| Accessibilité / mentions légales | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

### Scénarios clavier minimaux

#### Combobox adresse

1. Tab atteint le champ.
2. Saisie de trois caractères.
3. Le nombre de suggestions est annoncé.
4. Flèche bas/haut change l’option active sans ajouter toutes les options à l’ordre Tab.
5. Entrée sélectionne et ferme la liste.
6. Échap ferme sans sélectionner.
7. Tab quitte proprement le composant.
8. Une nouvelle saisie réouvre et met à jour les suggestions.
9. Souris et tactile restent fonctionnels.
10. Liste vide et erreur réseau sont annoncées.

#### Modale

1. Déclencheur identifiable.
2. À l’ouverture, focus dans la modale.
3. Tab/Shift+Tab restent dans la modale.
4. Échap ferme si le produit l’autorise.
5. Les boutons ont des noms explicites.
6. Le contenu extérieur n’est ni parcouru ni annoncé.
7. À fermeture, focus sur le déclencheur, visible.

#### Tableau/pagination

1. Caption annoncé avant les en-têtes.
2. Navigation cellule/en-tête cohérente.
3. Recherche nommée « Rechercher un département ».
4. Nombre de résultats annoncé.
5. Sélecteur résultats/page correctement étiqueté.
6. Changement automatique annoncé ou soumis explicitement.
7. Chaque bouton de pagination a un nom unique.
8. Nouvelle page annoncée.
9. Aucun défilement horizontal global à 320 px; un scroll interne justifié d’un tableau reste possible seulement sans perte de contrôles.

## 13. Tests automatisés attendus

Utiliser les outils déjà présents dans le dépôt.

### Unitaires

Créer des tests pour :

- attributs et relations de la combobox;
- absence de `tabindex` positif;
- gestion clavier de la combobox;
- association labels/aides/erreurs;
- annonces de statut;
- noms des boutons de pagination si composant local;
- restauration du focus des modales;
- structure sémantique des composants critiques.

### E2E Cypress

Couvrir au minimum :

- parcours adresse -> situation;
- géolocalisation avec API navigateur simulée;
- erreurs de formulaire d’abonnement;
- ouverture/fermeture des modales;
- changement de profil/type/zone;
- filtre du tableau et pagination;
- menu et fil d’Ariane mobile;
- viewport 320 px sans perte de fonctionnalité.

Ne pas considérer un scan automatisé comme preuve suffisante. Un outil axe peut être ajouté en dépendance de test seulement si cela est justifié, accepté et sans modifier le runtime de production.

## 14. Revue finale

Avant le dernier commit :

```bash
git status --short
git diff --check
npm run lint:public-frontend
npm --prefix apps/frontend run test:unit
npm --prefix apps/frontend run build
npm --prefix apps/frontend run cy:e2e
npm run smoke:public
```

Puis :

```text
/review
/diff
```

Ou en mode non interactif :

```bash
codex review --uncommitted
```

La revue doit spécifiquement chercher :

- régressions clavier;
- focus perdu ou déplacé de façon surprenante;
- nom accessible différent du texte visible;
- ARIA invalide ou redondant;
- IDs dupliqués;
- zones live créées trop tard;
- contenus cachés aux TA;
- modifications admin accidentelles;
- tests absents ou trop couplés à l’implémentation;
- déclaration de conformité non justifiée.

## 15. Extrait `AGENTS.md` recommandé

Ne pas mettre l’intégralité de ce document dans `AGENTS.md`. Conserver le fichier détaillé sous `docs/accessibilite/RGAA_REMEDIATION_CODEX.md` et mettre seulement ceci dans le `AGENTS.md` racine :

```md
## Remédiation RGAA VigiEau grand public

- Avant toute intervention RGAA, lire `docs/accessibilite/RGAA_REMEDIATION_CODEX.md`.
- Périmètre strict : `apps/frontend/**`. Ne pas modifier `apps/frontend-admin/**`, `apps/backend-admin/**` ni l’admin.
- Le rapport date de 2024 : inspecter le DOM et le comportement actuels avant de corriger. Ne pas appliquer aveuglément ses extraits HTML.
- Mettre à jour la matrice et une preuve pour chaque ligne traitée.
- Privilégier HTML natif, aucun `tabindex` positif, ARIA uniquement lorsque nécessaire.
- Exécuter lint, tests unitaires, build et tests e2e publics pertinents.
- Un commit cohérent par lot de travail; ne pas pousser et ne pas créer de MR.
- Ne pas inclure dans les commits les modifications préexistantes de l’utilisateur.
```

## 16. Prompts Codex prêts à l’emploi

### Objectif persistant

```text
/goal Corriger exhaustivement les écarts RGAA 4.1.2 encore applicables au frontend grand public VigiEau, en suivant docs/accessibilite/RGAA_REMEDIATION_CODEX.md, sans toucher aux applications admin, avec preuves, tests verts et un commit cohérent par lot, sans push ni MR.
```

### Plan initial

```text
/plan Lis AGENTS.md et docs/accessibilite/RGAA_REMEDIATION_CODEX.md en entier. Inspecte la branche et le DOM actuel du frontend public avant de proposer une modification. Produis un plan d’exécution fondé sur les WP0 à WP10, signale les tickets déjà corrigés ou devenus non applicables, identifie les dépendances/risques, les tests à ajouter et les commandes de validation. Ne modifie aucun fichier pendant cette phase.
```

### Démarrage du premier lot

```text
Exécute WP0 uniquement. Qualifie la matrice à partir du code actuel, des tests et du DOM rendu. Ne corrige pas encore le code. Ajoute les preuves disponibles, les points à valider manuellement, puis présente le diff documentaire et les commandes exécutées.
```

### Exécution d’un lot

```text
Exécute uniquement WP3 selon le document RGAA. Commence par résumer les écarts actuels démontrés. Implémente la correction minimale, ajoute les tests clavier et sémantiques, lance les validations ciblées, mets à jour la matrice, lance une revue du diff, corrige les findings, puis crée un commit cohérent. Ne touche pas aux autres lots et ne pousse rien.
```

Remplacer `WP3` par le lot voulu.

### Revue avant commit

```text
/review
```

Puis :

```text
/diff
```

Et enfin :

```text
Corrige tous les findings valides de la revue, relance les validations du lot, mets à jour les preuves, puis crée le commit prévu. N’inclus aucune modification hors périmètre.
```

## 17. Règles de décision importantes

- Un ticket « déjà corrigé » exige une preuve de DOM/comportement, pas seulement une lecture du template.
- Un composant supprimé n’est `N/A_CURRENT_UI` qu’après audit de son remplaçant.
- Un PDF externe non accessible reste un problème de contenu; un libellé de lien ne le rend pas accessible.
- Un composant tiers exempté peut encore nécessiter un titre, du focus et une alternative.
- Un passage de « partiellement conforme » à « totalement conforme » ne doit pas être fait sans ré-audit complet.
- Une correction qui casse le comportement métier n’est pas acceptable.
- Une correction ARIA qui ajoute du bruit ou un ordre de tabulation artificiel n’est pas acceptable.
- Ne pas choisir `title` comme solution par défaut lorsqu’un label visible et explicitement associé est possible.
- Toute divergence volontaire par rapport à la proposition du rapport doit être expliquée dans la preuve avec le pattern retenu.
