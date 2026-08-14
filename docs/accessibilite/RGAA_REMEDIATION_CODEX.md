# Remédiation RGAA 4.1.2 - VigiEau grand public

> **Document d’exécution pour Codex CLI**  
> Dépôt : `MTES-MCT/vigieau`  
> Branche analysée : `master`
> Instantané de référence : `b0f69c474ecdece92bebdf505d8e151b96fb5a5d` (06/08/2026)  
> Source d’audit : rapport Temesis du 04/07/2024, RGAA 4.1.2  
> Périmètre strict : application grand public uniquement

Ce fichier transforme le rapport PDF en contrat de remédiation exploitable par un agent de code. Il ne doit **pas** être traité comme une suite de remplacements HTML à appliquer aveuglément : l’interface et le dépôt ont évolué entre l’audit de juillet 2024 et la branche `master` actuelle.

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

1. inspecter le **DOM et le comportement actuels** de `master`;
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
- `ALREADY_OK` : déjà conforme sur `master`, preuve obligatoire
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

## 9. Reconnaissance rapide de `master`

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

Référence de départ : ancienne branche `develop`, commit `9aa6472`, worktree
propre. La baseline a été exécutée avec Node `24.16.0` et npm `11.17.0` via `npx`, car le
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

### Résultats WP1 - shell, navigation et focus

Le contrôle du DOM hydraté a invalidé deux hypothèses du baseline : le wrapper
du footer dupliquait l'identifiant `footer`, et les deux cibles des liens
d'évitement n'étaient pas toutes focalisables. Le lot les corrige avec la
gestion globale des changements de route, le menu mobile et un fil d'Ariane
adapté au comportement de Vue-DSFR 7.2.0.

| Contrôle | Résultat WP1 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 45/45 tests réussis, dont cinq sur le focus. |
| ESLint ciblé WP1 | OK | `eslint` sur `app.vue`, `basic.vue`, `AppBreadcrumb.vue`, `focus-management.ts`, `/carte` et les trois fichiers de tests du lot. La dette globale mesurée en WP0 reste distincte. |
| Build public | OK | `npm@11.17.0 --prefix apps/frontend run build` : génération Nuxt réussie, 23 routes pré-rendues. |
| Cypress navigation WP1 | OK STABLE | `rgaa-navigation.cy.js` : 5/5 scénarios réussis sur trois exécutions consécutives à 320 px quand applicable; `breadcrumb.cy.js` : 1/1. |
| Revue du diff | OK | `git diff --check`, contrôle du périmètre public et revue croisée : aucun bloquant restant sur WP1. |

Preuves navigateur datées du 10 août 2026 : activation des liens d'évitement
avec focus effectif sur l'unique `main` puis l'unique `footer`; ouverture du
menu avec focus sur Fermer, bouclage Tab/Maj+Tab, fermeture par Échap et retour
au déclencheur; absence de `nav` imbriqué; navigation SPA sans rechargement avec
titre, focus et statut; fallback `/carte` alors dépourvu de `h1`; ouverture
clavier du fil d'Ariane mobile avec focus sur Accueil. WP10 a ensuite donné à
`/carte` un `main` et un `h1` uniques, puis confirmé leur focus. L'arbre
d'accessibilité Chrome a été contrôlé; NVDA n'étant pas disponible dans
l'environnement, une recette avec lecteur d'écran reste explicitement externe
à ces preuves.

### Résultats WP2 - contrastes, images et nouvelles fenêtres

La couleur portée par un niveau n'est plus utilisée indistinctement comme fond
et comme texte : cinq variables de fond conservent la représentation des
cartes, tandis qu'une palette de texte plus sombre respecte 4,5:1 sur le blanc
et sur les fonds teintés actuels. Les liens `target="_blank"` sont enrichis au
niveau de l'application après hydratation, ce qui couvre aussi le footer
Vue-DSFR, les fragments `v-html` et les liens ajoutés après un appel API.

| Contrôle | Résultat WP2 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 61/61 tests réussis, dont trois de contraste, cinq d'images et huit de nouvelles fenêtres. |
| Contrastes | OK | Ratios minimaux texte/fond par niveau : 4,932:1, 5,714:1, 6,502:1, 5,939:1 et 5,829:1; badges : minimum 5,396:1. L'ancien override `#A18E3A` est supprimé et interdit par test. |
| Alternatives d'images | OK | Test statique sur toutes les images/composants publics; vérification DOM sur huit routes. Les illustrations décoratives ont `alt=""`; cartes et logos informatifs ont une alternative contextualisée sans `title` non vide. |
| Nouvelles fenêtres | OK CÔTÉ CODE | 27 occurrences source plus liens DSFR/dynamiques audités. Tests jsdom sur contenu, `aria-label`, `aria-labelledby`, sécurité et mutations; Cypress : 8/8 routes, dont 22/22 liens sur l'accueil et 11/11 sur `/accessibilite`. |
| ESLint ciblé et diff | OK | Nouveaux utilitaires/tests et `app.vue` sans erreur ni avertissement; `git diff --check` réussi. La dette de formatage des anciens templates reste suivie séparément. |
| Build public | OK | `npm@11.17.0 --prefix apps/frontend run build` : génération Nuxt réussie, 23 routes pré-rendues. |

La règle de nouvelle fenêtre ne constitue pas une preuve d'accessibilité des
PDF liés. Les lignes mixtes sont donc fermées côté code mais restent marquées
`BLOCKED_CONTENT` jusqu'au traitement documentaire de WP9.

### Résultats WP3 - combobox d'adresse et géolocalisation

Le champ d'adresse suit désormais le modèle ARIA combobox avec focus DOM
maintenu sur l'entrée : relations stables vers la liste, option active exposée,
état d'ouverture synchronisé et popup hors de la séquence de tabulation. Le
libellé et l'indication obligatoire restent visibles, tandis que l'exemple est
une description persistante distincte du nom accessible.

| Contrôle | Résultat WP3 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 68/68 tests réussis, dont sept sur les déplacements, statuts, gardes réseau et invariants du composant. |
| Sémantique et clavier | OK | Cypress : relations combobox/listbox/options, `aria-activedescendant`, flèches, Entrée, Échap, Tab réel, clic, focus dans l'entrée et viewport 320 px; 14/14 scénarios réussis. |
| Aide et champ obligatoire | OK | `label[for]` et ID uniques; texte visible « (obligatoire) », attribut natif `required`, aide externe reliée par `aria-describedby` et `autocomplete="street-address"`. |
| États asynchrones | OK | Région `role="status"` présente avant mutation : chargement, singulier/pluriel, zéro résultat, erreur et géolocalisation. Les réponses obsolètes sont ignorées et l'édition invalide aussitôt l'ancien choix. |
| Géolocalisation | OK | Succès, refus, réponse vide et erreur API couverts; focus restitué, délai navigateur borné à 10 s et aucune recherche d'adresse parasite, y compris avec un debounce déjà planifié. |
| Formulaire d'abonnement | OK | Même champ et mêmes relations; Cypress vérifie en plus la requête `type=housenumber` du mode adresse exacte. |
| ESLint, diff et build | OK | ESLint ciblé sans erreur ni avertissement; `git diff --check` réussi; génération Nuxt réussie avec 23 routes pré-rendues. |

### Résultats WP4 - formulaires publics et abonnement

Les deux parcours publics sont désormais de vrais formulaires soumis par le
clavier. Les indications obligatoires sont lisibles avant interaction et les
erreurs apparaissent uniquement après validation, nomment le champ, sont
reliées au contrôle concerné et disparaissent avec `aria-invalid` lors de la
correction. Le premier contrôle invalide reçoit le focus.

| Contrôle | Résultat WP4 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 72/72 tests réussis, dont quatre sur le focus et les contrats du formulaire principal. |
| Sémantique des formulaires | OK | Les parcours accueil et abonnement rendent un `<form novalidate>` et un bouton `type="submit"`; Cypress vérifie la soumission par Entrée et l'absence de double requête. |
| Groupes et obligations | OK | Profil et types d'eau sont des `fieldset` nommés; les mentions « (obligatoire) » sont dans les légendes/libellés et les champs natifs pertinents portent `required`. |
| E-mail et erreurs | OK | `type="email"`, `autocomplete="email"`, exemple persistant hors du libellé et relations `aria-describedby`; erreurs adresse, types d'eau, e-mail et consentement testées avant et après correction. |
| Modale de résultat | OK | La modale de résultat possède un titre réel, rend `dialog` ou `alertdialog`, prend le focus et le restitue au bouton après une erreur. Elle utilise depuis WP8 le composant natif partagé et réellement modal. |
| Cypress formulaires | OK | `rgaa-public-forms.cy.js` : 6/6; régression combobox adaptée : 14/14, soit 20/20 scénarios Chrome headless. |
| ESLint, diff et build | OK | ESLint ciblé sans erreur ni avertissement; `git diff --check` réussi; génération Nuxt réussie avec 23 routes pré-rendues. |

### Résultats WP5 - sélecteurs de situation et formulaire Tally

Les choix de type d'eau, zone d'alerte et profil forment désormais un unique
groupe responsive. Chaque liste possède un libellé explicite associé par
`label[for]` et un identifiant stable, y compris la liste présentée dans la
modale lorsqu'une adresse correspond à plusieurs zones.

Le bouton « Donner mon avis » utilise le contrat `onClick` attendu par
Vue-DSFR. L'intégration locale cible uniquement l'iframe du formulaire VigiEau,
lui donne un titre français, retire les attributs de présentation obsolètes et
gère le focus à l'ouverture comme à la fermeture. Le script Tally restant une
ressource distante non versionnée, WP10 ne requalifie pas son contenu tiers :
l'insertion locale est testée, mais une recette de la ressource distante reste
à réaliser lorsqu'elle est disponible.

| Contrôle | Résultat WP5 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | `npm@11.17.0 --prefix apps/frontend run test:unit` : 81/81 tests réussis, dont trois sur la structure des sélecteurs et six sur l'intégration Tally. |
| Sélecteurs de situation | OK | `rgaa-situation-selectors.cy.js` : 2/2 scénarios. DOM hydraté à 1400 et 320 px, un seul `fieldset`, quatre associations label/ID uniques, sélection de zone synchronisée et contrôles contenus dans le viewport. |
| Formulaire de retour | OK | `rgaa-tally-feedback.cy.js` : 2/2 scénarios. Le vrai bouton du header est activé sur desktop et au clavier dans le menu mobile; l'iframe prend le focus puis le restitue au déclencheur visible. Deux exécutions consécutives dédiées et une exécution combinée réussies. |
| Iframe tierce | OK CÔTÉ CODE | Le DOM actuellement produit par le script officiel a été reproduit dans les tests : titre remplacé par « VigiEau - retours utilisateurs », retrait de `align`, `frameborder`, `marginheight`, `marginwidth` et `scrolling`, conservation des dimensions valides. L'observer et l'attente du script sont bornés. |
| ESLint et diff | OK | ESLint du composant, du layout, du nouvel utilitaire et des quatre tests sans erreur ni avertissement; `utils/index.ts` conserve sa dette historique hors lignes modifiées. `git diff --check` réussi. |
| Build public | OK | `npm@11.17.0 --prefix apps/frontend run build` : génération Nuxt réussie, 794 modules transformés et 23 routes pré-rendues. |

### Résultats WP6 - carte, tableaux, pagination et responsive

Les onglets de carte et de statistiques utilisent désormais une implémentation
locale : les relations onglet/panneau sont stables, le focus suit la sélection
au clavier et les panneaux ne créent plus d'arrêt de tabulation. La carte est
nommée et décrite en français, partage la même logique de sélection au clic et
avec Entrée/Espace, et expose un accès visible à son alternative sous forme de
tableau.

Les sept tableaux publics paginés reposent sur un composant partagé. Le
`caption` et les en-têtes restent dans le tableau, tandis que le choix de taille,
le statut et les quatre actions de pagination sont extérieurs au `tbody`. Un
changement de filtre, de données ou de taille revient à la première page et une
seule région de statut annonce le résultat, la taille et la page courante.

| Contrôle | Résultat WP6 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | 99/99 tests réussis, dont 18 contrôles sur la pagination partagée, les IDs, les cellules dynamiques, les onglets et la locale cartographique. |
| Tableaux publics | OK | Les sept usages ont des IDs distincts; aucun `DsfrTable` paginé ne subsiste dans le client public. La page historique rend deux instances sans collision et conserve le lien PDF dynamique. |
| Clavier et alternative de carte | OK | Onglets : flèches, Début et Fin déplacent sélection et focus; panneaux à `tabindex="-1"`. Le bouton vers Données focalise son onglet. WP10 injecte une couche GeoJSON rendue dans l'instance MapLibre réelle puis vérifie Entrée/Espace, la boîte d'information nommée, le focus, sa restitution et la navigation vers Situation. Le décodage d'une archive PMTiles distante reste hors de cette preuve déterministe. |
| Pagination | OK | Label associé et automatisme annoncé, quatre boutons nommés et désactivés aux bornes, pagination hors tableau et statut stable. Cypress vérifie notamment dernière page puis taille 25 : retour en page 1 avec lignes 1 à 25. |
| Responsive 320 px | OK AUTOMATISÉ ET CONTRÔLÉ | Chrome 151 vérifie l'absence de débordement global et le confinement du défilement dans les tableaux sur l'accueil, la situation, `/carte`, sept routes `/donnees/**`, `/donnees-personnelles` et `/stats`; contrôles, pagination et export restent dans le viewport. WP10 complète par une simulation de texte à 200 % et une redistribution à 320 px équivalente au contrôle 400 %. |
| Cypress WP6 | OK | Trois specs, 20/20 scénarios Chrome headless : tableau/filtre/pagination, onglets, MapLibre, multi-instance et balayage des routes publiques. |
| ESLint, diff et build | OK SUR LE LOT | ESLint strict des onze nouveaux fichiers sans erreur ni avertissement; `git diff --check` réussi; génération Nuxt réussie avec 798 modules transformés et 23 routes pré-rendues. La dette ESLint des anciens composants reste distincte. |

### Résultats WP7 - contenus éditoriaux, gestes et HTML injecté

Les éco-gestes de l'accueil et les thèmes de restrictions n'utilisent plus un
composant d'onglets sans onglets. Deux groupes de boutons à état pressé
pilotent des régions nommées; le changement des usages remet la sélection dans
une position valide. Chaque éco-geste est désormais un item de liste contenant
un paragraphe cohérent, lisible sans la présentation en cartes.

Le groupe d'accordéons unique de la FAQ est conservé : Vue-DSFR 7.2.0 le rend
comme un `div`, de sorte que les quatre catégories `h3` et les dix-sept
questions `h4` étaient déjà valides. Les causes de sécheresse et les solutions
de substitution ont en revanche été restructurées en vraies listes, et les 17
fragments HTML sont analysés par test.

| Contrôle | Résultat WP7 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | 116/116 tests réussis. Les nouveaux tests couvrent filtres et listes de gestes, 17 réponses FAQ, frontière `v-html`, page Cookies et cinq constructeurs de popup DOM. |
| Gestes et restrictions | OK | Plus aucun `DsfrTabs` sans titres dans les deux composants. Cypress vérifie groupes nommés, `aria-pressed`, `aria-controls`, région reliée et contenu filtré sur l'accueil puis `/situation`. |
| FAQ | OK CÔTÉ CODE | Un groupe `div`, 4 catégories `h3`, 17 questions `h4`, relations/IDs uniques et une seule réponse ouverte. Les trois causes et trois solutions sont des `li`; les quatre niveaux restent ordonnés; les flèches décoratives sont masquées. Les PDF restent suivis séparément en WP9. |
| HTML dynamique | OK | Une seule directive `v-html` subsiste, limitée au JSON FAQ local versionné. Les libellés API d'abonnement et les textes de modales sont interpolés par Vue; Cypress affiche littéralement un payload `<img onerror>` sans créer d'élément ni exécuter de code. |
| Popups cartographiques | OK | Les six `Popup#setHTML` sont remplacés par `setDOMContent`; le helper partagé construit paragraphes, badges, listes et boutons avec `textContent`. Tests jsdom anti-injection : 6/6; aucune entité `&nbsp:` malformée ne subsiste dans le client. |
| Page Cookies | OK STRUCTURE | Les doubles retours de mise en forme deviennent deux paragraphes et la liste de mesure d'audience est sœur des paragraphes. DOM Chrome : aucun paragraphe vide ou contenant une liste. L'absence de bandeau reste qualifiée `N/A_CURRENT_UI`. |
| Cypress WP7 | OK | Cinq specs, 15/15 scénarios Chrome headless : FAQ, gestes, restrictions, sécurité HTML, Cookies et régression des contenus partagés. |
| ESLint, diff et build | OK SUR LE LOT | Nouveaux helpers/tests sans erreur ni avertissement; composants historiques sans nouvelle erreur sur les lignes modifiées; `git diff --check` et génération Nuxt réussis. La dette de formatage antérieure reste distincte. |

### Résultats WP8 - situation, restrictions et boîtes de dialogue

Les sept boîtes de dialogue publiques utilisent désormais un composant local
fondé sur l'élément natif `dialog` et `showModal()`. Il maintient le focus dans
la boîte, rend réellement le fond inerte, verrouille le défilement, traite un
seul Échap et restitue le focus à l'origine exacte. Les identifiants et titres
sont uniques; aucune instance applicative de `DsfrModal` ne subsiste.

Le retour sur une restriction utilise une seule boîte de dialogue avec états
d'envoi, d'erreur et de succès. Une réponse API obsolète ne peut plus rouvrir la
boîte ni afficher un faux succès. La page Situation annonce depuis une région
stable les changements de profil, de type d'eau et de zone; la sélection
initiale multi-zone est obligatoire, décrite et focalisée en cas d'erreur.

| Contrôle | Résultat WP8 | Preuve |
|---|---|---|
| Tests unitaires publics | OK | 127/127 tests réussis, dont inventaire des sept modales, verrou de défilement partagé, focus SPA et sémantique Situation. |
| Modales natives | OK | Cypress `rgaa-modal-dialogs.cy.js` : 4/4. `:modal`, inertie du fond, Tab/Maj+Tab, Échap, titre, IDs, focus initial/restauré, scroll, viewport 320 px et plusieurs cartes sont exercés sur les routes réelles. |
| Retours et erreurs asynchrones | OK | Réponses feedback 200/500 et réponse retardée après fermeture/réouverture testées; Search 409 focalise l'adresse et Search 500 restitue le bouton de soumission. |
| Situation et structure | OK | Les cartes gardent un vrai `h3`, les messages sont des paragraphes et le fallback a un titre cohérent. Les deux scénarios Situation vérifient sélection multi-zone, annonces et responsive. |
| Régression intégrée | OK | Cinq specs, 31/31 scénarios Electron : modales, Situation, navigation SPA, formulaires et combobox. Le focus `/carte` ignore les titres des dialogues fermés; navigation complète réussie trois fois de suite à 5/5. |
| ESLint, diff et build | OK SUR LE LOT | ESLint ciblé sans erreur ni avertissement; `git diff --check` réussi; génération Nuxt réussie avec 802 modules transformés et 23 routes pré-rendues. La dette historique de `Map.vue` et `utils/index.ts` reste distincte des lignes modifiées. |

### Résultats WP9 - pages institutionnelles et documents

Les trois PDF statiques obsolètes de la FAQ ne sont plus proposés. La réponse
sur les usages domestiques renvoie vers la page HTML officielle consacrée à
l'[origine et la gestion de la sécheresse](https://www.ecologie.gouv.fr/politiques-publiques/origine-gestion-secheresse).
Les deux réponses relatives à l'eau potable conservent leur explication HTML
et renvoient vers la
[fiche officielle de l'instruction ORSEC sur Légifrance](https://www.legifrance.gouv.fr/circulaire/id/42547),
sans qualifier cette fiche d'équivalent intégral des annexes.

Les arrêtés préfectoraux et municipaux restent fournis dynamiquement par les
services locaux de l'État et les collectivités. Leur modèle API ne transporte
actuellement que le nom, l'URL et la taille du fichier : ni statut
d'accessibilité, ni alternative, ni preuve de contrôle, ni contact émetteur.
VigiEau affiche donc près de chaque surface de téléchargement un avertissement
qui distingue les informations opérationnelles de l'arrêté officiel et oriente
vers le contact accessibilité. La préfecture ou la DDT(M) reste propriétaire
des arrêtés préfectoraux, la commune de l'arrêté municipal et VigiEau/DGALN du
contrat d'ingestion ainsi que du mécanisme de repli. `DOC-01` et `CRISIS-12`
restent explicitement bloqués sur ce contenu externe; aucun attribut de lien
n'est présenté comme une correction du document lui-même.

Les pages institutionnelles ont aussi été réparées sans modifier le taux ni le
statut issus de l'audit de janvier 2025 : paragraphes séparés des listes et
tableaux, légendes des deux tableaux de données personnelles, coordonnées
actionnables, plan d'action 2026, nom du service corrigé et directeur de la
publication actualisé. Une navigation SPA vers le contact focalise désormais
le titre ciblé par le fragment au lieu de laisser le focus hors écran.
Cette correction de la politique de confidentialité est structurelle : le DPO
ou responsable de traitement doit encore valider l'exhaustivité des données
collectées, des droits et des modalités de contact. Ce fond juridique n'est pas
requalifié par les preuves RGAA du présent lot.
La déclaration d'accessibilité attribue désormais explicitement les constats à
l'audit de janvier 2025. Son propriétaire doit encore fournir ou valider la
date de mise à jour, les technologies, l'environnement de test, les outils et
l'échantillon exigés par le modèle officiel; ces éléments ne sont pas inventés
à partir de la seule régression technique.

| Contrôle | Résultat WP9 | Preuve |
|---|---|---|
| FAQ statique | OK | Les anciennes URL et tout lien PDF direct sont absents; les destinations HTML Ecologie et Légifrance, leurs libellés et l'annonce de nouvelle fenêtre sont contrôlés en unitaire et dans le DOM. |
| Arrêtés dynamiques | BLOCAGE DOCUMENTÉ | Les trois familles d'arrêtés affichent le repli vers `/accessibilite#amelioration-contact`. La conformité intrinsèque reste `BLOCKED_CONTENT` jusqu'à fourniture d'un statut, d'une alternative et d'une preuve par l'émetteur. |
| Pages institutionnelles | OK CÔTÉ STRUCTURE | Les templates Vue et le DOM vérifient l'absence de bloc dans un paragraphe, de paragraphe vide et de tableau sans légende; les libellés obsolètes ont disparu. Le fond RGPD reste à valider par le propriétaire juridique. |
| Focus du contact | OK | La cible `#amelioration-contact` reçoit `tabindex="-1"` et le focus après une navigation SPA avec fragment; le comportement des liens d'évitement est conservé. |
| Régression automatisée | OK | 134/134 tests unitaires publics; 12/12 scénarios Cypress sur navigation, FAQ et pages/documents institutionnels; ESLint ciblé et `git diff --check` verts. |
| Génération statique | OK | Nuxt transforme 803 modules et pré-rend 23 routes; aucun avertissement d'imbrication HTML n'est émis. |

### Résultats WP10 - régression finale et preuves

La recette du 11 août 2026 porte sur l'ensemble du frontend public, sans
modification des applications d'administration. Elle a notamment réparé les
derniers écarts découverts pendant le balayage : flux de désabonnement en
erreur, titre et focus de la route `/carte`, popup MapLibre au clavier, titres
d'alertes vides, titres de niveau 6 artificiels, fonds décoratifs débordants et
tableaux de données personnelles. Ces derniers ne deviennent tabulables que
lorsqu'un défilement horizontal est réellement nécessaire.

| Contrôle | Résultat WP10 | Preuve |
|---|---|---|
| Cypress public complet | OK | 20/20 specs, 91/91 scénarios Electron, aucun échec, test ignoré ou en attente. Les quatre anciens specs ont été alignés sur les API et le DOM actuels; aucun serveur de test ne subsiste. |
| Tests unitaires et structure | OK | 137/137 tests. L'analyse AST parcourt tous les SFC publics : aucun bloc dans un paragraphe, aucun `DsfrAlert` sans titre et aucun `h6`. Les 35 SFC modifiés compilent sans erreur. |
| Génération statique | OK | `npm run build` réussit, génère `.output/public`, le service worker et 23 routes pré-rendues. Les avertissements sur l'URL locale et la taille de certains chunks ne bloquent pas la génération. |
| ESLint et diff | OK AVEC DETTE DOCUMENTÉE | `npm run lint` sort avec le code 0 et aucune erreur; 402 avertissements historiques restent visibles. `git diff --check` réussit; aucun `.only`, débogueur ou log d'instrumentation n'est présent et aucun fichier admin n'est modifié. |
| Redistribution et agrandissement | OK SUR LES PARCOURS CONTRÔLÉS | Chrome 151 à 320 px CSS, ainsi qu'une racine à 32 px pour simuler 200 % de texte, ne présente plus de débordement global ni de contrôle rogné. Le contrôle 320 px avec facteur 4 couvre la redistribution équivalente à 400 %; il ne remplace pas une recette de zoom natif sur chaque couple navigateur/système. |
| Clavier et ordre du contenu | OK | Parcours adresse, formulaires, menu, fil d'Ariane, onglets, tableaux, modales, carte et popup sont exercés au clavier. Sans CSS auteur, accueil, carte, abonnement et pages institutionnelles gardent un ordre DOM intelligible, un contenu principal unique et des relations ARIA résolues. |
| Accessibilité calculée et contrastes | OK CIBLÉ | L'arbre Accessibility de Chrome ne contient plus de titre vide sur les parcours contrôlés. Les mesures WP2 et le contrôle WP10 des textes/contrôles actifs respectent les seuils visés; les états désactivés ne sont pas utilisés comme preuve. |
| Limites externes | À CONFIRMER HORS ENVIRONNEMENT | NVDA n'est pas disponible; l'arbre AX Chrome ne vaut pas recette lecteur d'écran. Le test MapLibre emploie une couche rendue déterministe, pas le décodage réussi d'une archive PMTiles distante. Le script Tally distant et les PDF dynamiques restent soumis à leurs propriétaires. `nuxi typecheck` n'est pas exécutable sans `vue-tsc`/checker installé. |

Répartition consolidée après WP10, inchangée sur les qualifications primaires :
88 lignes, dont 62 `FIXED`, 22 `ALREADY_OK`, 2 `N/A_CURRENT_UI`,
2 `BLOCKED_CONTENT` et aucun `TODO`.

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
| `G-01` | § 8.1, p. 12 | 3.2 | Majeur | Corriger les contrastes insuffisants des libellés de niveaux « Alerte » et « Alerte renforcée ». Vérifier tous les usages actuels des couleurs, pas seulement la capture de 2024. Seuils : 4,5:1 pour le texte courant, 3:1 pour le grand texte. | `apps/frontend/client/**` ; rechercher les classes `situation-level-*`, badges et variables de couleurs. | PROBABLEMENT OUVERT : `SituationHeader.vue` contient encore une couleur personnalisée `#A18E3A`; mesurer le rendu réel. | `FIXED` — WP2 : palette fond/texte séparée et override scoped supprimé. `a11y-colors.test.mjs` mesure chaque badge, le blanc et les surfaces teintées réelles; le pire ratio de texte est 4,932:1 et celui des badges 5,396:1. |
| `G-02` | § 8.2, p. 13 | 10.11 | Bloquant | À 320 px de largeur, aucun contenu ni contrôle utile ne doit disparaître et aucun défilement horizontal global ne doit être requis. Couvrir notamment carte/données, tableaux, filtres et pagination. | `components/carte/**`, `components/donnees/**`, pages `/carte` et `/donnees`, styles globaux. | OUVERT À REVALIDER : les composants et l’architecture ont changé depuis 2024. | `FIXED` — WP6 supprime les largeurs `100vw`, contraint cartes et conteneurs, puis sort la pagination des zones défilantes. WP10 corrige les deux fonds décoratifs encore débordants à 200 % de texte et confine les deux tableaux RGPD. Chrome à 320 px couvre accueil, situation, `/carte`, routes de données, `/donnees-personnelles` et `/stats`; seuls les wrappers de tableaux qui débordent restent tabulables et défilent horizontalement. |
| `G-03` | § 9.1, p. 13-14 | 9.2, 12.6 | Majeur / mineur | Une zone principale unique doit être exposée et atteignable/évitable. Vérifier le DOM rendu, le lien d’évitement, l’unicité de `main` et la cible `#main-content`. | `client/layouts/basic.vue`, composants DSFR de layout. | SEMBLE DÉJÀ CORRIGÉ : `<main role="main" id="main-content">` et liens d’évitement présents; ne pas modifier sans échec démontré. | `FIXED` — WP1 : suppression du wrapper qui dupliquait `#footer`, `tabindex="-1"` sur les cibles `main` et `footer`, et région principale ajoutée à `/carte`. Cypress active les deux liens d'évitement et vérifie l'unicité ainsi que le focus effectif des cibles. |
| `G-04` | § 10.1, p. 14-16 | 6.1, 7.1, 8.5, 8.6, 12.8 | Majeur | Pour toute navigation SPA : employer lien ou bouton selon le comportement, mettre à jour le titre de page, annoncer le changement et placer le focus à un emplacement logique sans casser l’historique ni la navigation clavier. | `client/app.vue`, pages, middleware, router-links, utilitaires de navigation. | PROBABLEMENT OUVERT : les pages définissent souvent `useHead`, mais aucun gestionnaire global de focus de route n’est visible. | `FIXED` — WP1 : `app.vue` observe les changements de route hors fragments, attend le rendu, focalise le premier `h1` ou le `main`, et alimente une zone `role="status"`. WP10 ajoute à `/carte` un `main` et un `h1` uniques; Cypress prouve la navigation interne sans rechargement, le titre, le focus et l'annonce sur cette route comme sur les pages de layout. |
| `HDR-01` | § 11.1, p. 16 | 1.3 | Mineur | L’alternative du logo opérateur doit être pertinente et ne pas contenir « logo du produit ». | `client/layouts/basic.vue` et rendu de `DsfrHeader`. | SEMBLE DÉJÀ CORRIGÉ : l’alternative vaut le nom de l’application. | `ALREADY_OK` — DOM hydraté WP0 : l’image opérateur du header expose `alt="VigiEau"`; `layouts/basic.vue` alimente cette valeur depuis `appName`. |
| `HDR-02` | § 11.2, p. 16-17 | 10.2, 7.1 | Majeur | Le bouton du menu mobile doit avoir un nom accessible en contenu réel/masqué, et déclarer correctement qu’il ouvre une boîte de dialogue (`aria-haspopup="dialog"` si nécessaire). | `client/layouts/basic.vue`, `DsfrHeader`, version installée de `@gouvminint/vue-dsfr`. | À VÉRIFIER DANS LE DOM RENDU : ne pas patcher la dépendance si une prop suffit. | `FIXED` — WP1 : la version installée rendait un bouton vide malgré `aria-label`; le layout ajoute idempotemment un vrai texte `Menu` masqué. Cypress vérifie ce contenu, `aria-controls`, `aria-haspopup="dialog"` et le nom du dialogue. |
| `HDR-03` | § 11.3, p. 17 | 7.1 | Majeur | La boîte de dialogue du menu mobile doit avoir un nom pertinent, sans terme technique tel que « modal ». | `client/layouts/basic.vue`, `DsfrHeader`. | SEMBLE PARTIELLEMENT CORRIGÉ : `menuModalLabel="Menu"`; vérifier le rendu. | `ALREADY_OK` — DOM hydraté à 320 px WP0 : `#header-navigation[role="dialog"][aria-modal="true"][aria-label="Menu"]`. Les autres exigences de focus restent dans `HDR-02`/`HDR-04`. |
| `HDR-04` | § 11.4, p. 17-18 | 12.8 | Majeur | À l’ouverture du menu mobile, positionner le focus dans la boîte de dialogue, le contenir jusqu’à fermeture, restaurer le focus sur le déclencheur et supprimer toute imbrication de `nav` inutile. | `DsfrHeader` rendu et éventuels overrides locaux. | À TESTER MANUELLEMENT AU CLAVIER ET SOUS LECTEUR D’ÉCRAN. | `FIXED` — WP1 : focus du bouton Fermer garanti après ouverture, piège Tab/Maj+Tab limité aux éléments visibles, nettoyage des écouteurs et restitution DSFR du focus par Échap. Trois runs Cypress consécutifs vérifient le cycle complet et l'absence de `nav` imbriqué. |
| `FTR-01` | § 12.1, p. 18-19 | 6.1 | Majeur | Les liens de retour à l’accueil et leurs images doivent avoir un intitulé cohérent avec le contenu visible. Éviter deux liens concurrents et conserver une alternative « VigiEau » pertinente. | `client/layouts/basic.vue`, rendu de `DsfrFooter`. | SEMBLE DÉJÀ CORRIGÉ : `homeTitle="Accueil VigiEau"` et alt opérateur; vérifier le DOM. | `ALREADY_OK` — DOM hydraté WP0 : un lien de marque footer `title="Accueil VigiEau"` contient l’unique image opérateur `alt="VigiEau"`. |
| `FTR-02` | § 12.2, p. 19 | 6.1, 10.2 | Majeur | Tout lien ouvrant une nouvelle fenêtre doit l’annoncer de façon accessible. Centraliser la règle si possible; l’icône CSS seule ne suffit pas. Le nom accessible doit conserver le libellé visible. | Tous les `target="_blank"` dans `apps/frontend/client/**`, données HTML/JSON et composants DSFR. | PARTIELLEMENT CORRIGÉ : plusieurs liens ont un `title`, mais des liens dynamiques et ceux de `SituationHeader.vue` restent à vérifier. | `FIXED` — WP2 : `observeNewWindowLinks` ajoute une annonce masquée idempotente en conservant le libellé visible, gère les noms ARIA et les insertions dynamiques, puis normalise `rel`. Le footer DSFR et sa licence sont couverts dans les tests DOM/Cypress. |
| `COOKIE-01` | § 13, p. 19 | À requalifier | À vérifier | Le rapport n’observait aucun bandeau/modale de cookies. Si un mécanisme existe désormais, l’auditer comme toute boîte de dialogue : nom, focus, fermeture, arrière-plan inerte et restitution des choix. | `client/pages/cookies/**`, configuration Matomo/consentement et composants chargés au runtime. | NOUVEAU PÉRIMÈTRE POSSIBLE : ne pas conclure N/A sans inspection. | `N/A_CURRENT_UI` — recherche source WP0 et DOM des routes publiques : aucun bandeau/dialogue de consentement; `matomo.client.ts` déclare `requireConsent: false` et `requireCookieConsent: false`. WP7 corrige en complément les doubles `<br>`, la liste imbriquée dans un paragraphe et les paragraphes vides potentiels de `/cookies`; DOM Cypress vérifié. |

### B. Documents téléchargeables
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `DOC-01` | § 14.1, p. 20-21 | 13.3 | Bloquant | Les PDF cités doivent être accessibles ou disposer d’une alternative accessible équivalente en HTML/DOCX. Documenter précisément toute exemption applicable; ne pas la présumer. | `client/data/faq.json`, liens vers Guide circulaire, synthèse usages, instruction ORSEC et autres PDF; fichiers éventuellement hors dépôt. | BLOCAGE CONTENU POSSIBLE : si le PDF est externe et non maîtrisé, créer une alternative HTML utile ou consigner le propriétaire/la décision. Ne jamais marquer « corrigé » avec un simple changement de `title`. | `BLOCKED_CONTENT` — WP9 supprime les trois PDF statiques de la FAQ au profit de sources HTML officielles. Les arrêtés issus de l'API restent non qualifiables : préfecture/DDT(M) ou commune propriétaire du document, VigiEau/DGALN propriétaire du contrat d'ingestion et du repli. Un avis visible renvoie au contact accessibilité, mais ne prétend pas remplacer juridiquement l'arrêté. Le contrat devra porter statut, URL d'alternative, émetteur, contact public, date et preuve de contrôle. |

### C. Combobox de recherche d’adresse
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `ADR-01` | § 15.2, p. 22 | 11.2, 8.9 | Bloquant / mineur | Le libellé visible « Entrez votre adresse complète » doit être le nom accessible effectif du champ et être associé explicitement. Aucun libellé masqué contradictoire. | `components/FdrAutoComplete.vue`, `components/mixins/SearchAddress.vue`. | PARTIELLEMENT CORRIGÉ : le libellé visible est désormais transmis; vérifier les IDs générés et le nom calculé. | `FIXED` — WP3 : `useId()` produit un ID stable relié par `label[for]`; le nom accessible reprend le libellé visible et « obligatoire », sans absorber l'exemple. DOM et scénario Cypress sur accueil et abonnement. |
| `ADR-02` | § 15.3, p. 23 | 7.1 | Majeur | Exposer un vrai pattern combobox : `role=combobox`, `aria-autocomplete=list`, `aria-expanded` dynamique, `aria-controls` vers la listbox, `aria-haspopup=listbox` si utile et relation active cohérente. | `components/FdrAutoComplete.vue`. | OUVERT : `aria-expanded` est actuellement toujours `true`, `aria-haspopup` reçoit un booléen et aucune relation `aria-controls`/`aria-activedescendant` n’est visible. | `FIXED` — WP3 : rôle combobox, autocomplétion liste, popup `listbox`, ouverture dynamique, relation `aria-controls` et descendant actif synchronisé. Cypress vérifie les états fermé, ouvert et actif. |
| `ADR-03` | § 15.4, p. 24 | 11.10 | Majeur | Indiquer visuellement et programmatiquement le caractère obligatoire; ne pas se contenter de la validation après soumission. | `FdrAutoComplete.vue`, `SearchAddress.vue`, usages dans `Search.vue` et `MailForm.vue`. | PARTIELLEMENT CORRIGÉ : prop `required` présente; vérifier le texte visible généré par DSFR. | `FIXED` — WP3 : « (obligatoire) » est visible dans le libellé avant interaction et le vrai champ porte l'attribut natif `required`; vérifié sur les deux usages. |
| `ADR-04` | § 15.5, p. 25 | 11.10 | Majeur | L’exemple d’adresse doit être un texte d’aide persistant associé au champ par `aria-describedby`, pas seulement un placeholder. | `FdrAutoComplete.vue` (`hint`) et DOM généré par `DsfrInput`. | SEMBLE CORRIGÉ VIA `hint`, À VÉRIFIER DANS LE DOM. | `FIXED` — WP3 : l'exemple est rendu hors du `label`, reste visible et possède son propre ID dans `aria-describedby`; il constitue une description et non une partie du nom. |
| `ADR-05` | § 15.6, p. 26 | 11.13 | Majeur | Utiliser un `autocomplete` pertinent (`street-address` ou valeur RGAA/HTML adaptée au champ complet). Ne pas désactiver arbitrairement le remplissage automatique; justifier tout changement dynamique. | `FdrAutoComplete.vue`. | À RECONCEVOIR : le code bascule actuellement entre `off` et `address-line1` selon le focus. | `FIXED` — WP3 : `autocomplete="street-address"` est constant; la bascule focus entre `off` et `address-line1` est supprimée. |
| `ADR-06` | § 15.7, p. 26-27 | 7.1 | Majeur | La liste doit être une `listbox` nommée; chaque suggestion une `option` avec état sélectionné cohérent et IDs stables. | `FdrAutoComplete.vue`. | PARTIEL : rôles présents, mais vérifier nom non vide, IDs, sélection et DOM. | `FIXED` — WP3 : listbox nommée « Liste d’adresses », options avec ID stable par instance et `aria-selected` porté uniquement par l'option active. Relations testées dans le DOM. |
| `ADR-07` | § 15.8, p. 28 | 7.5 | Majeur | Annoncer le nombre de suggestions au moyen d’une zone de statut existant avant la mise à jour, sans bavardage excessif ni annonces doublées. | `FdrAutoComplete.vue`. | PARTIEL : une zone `aria-live` existe; vérifier son apparition (`v-show`), son comportement et le libellé. | `FIXED` — WP3 : une région `role="status"` polie et atomique existe vide avant les mutations puis annonce chargement, nombre singulier/pluriel, zéro résultat, erreur, sélection ou géolocalisation. |
| `ADR-08` | § 15.9, p. 29 | 7.1, 12.8 | Bloquant | La navigation clavier doit suivre un pattern combobox valide : flèches, Entrée, Échap, Tab, souris; l’option active doit être exposée. Aucun `tabindex` positif; éviter que chaque option ajoute un arrêt de tabulation. | `FdrAutoComplete.vue` et tests. | OUVERT : `ul tabindex="1"`, options `tabindex="0"`, sélection et option active ne sont pas correctement reliées. Corriger sans reproduire aveuglément l’ancien exemple de déplacement de focus. | `FIXED` — WP3 : focus DOM maintenu dans l'entrée; flèches, Entrée, Échap, Tab réel et clic couverts. Popup/options hors séquence, descendant actif exposé, zéro résultat sans exception et liste fermée lors de la sortie. |

### D. Abonnement / « Restez informé »
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `NEWS-01` | § 15.11, p. 30 | 1.2 | Mineur | L’illustration de la newsletter, si décorative, doit avoir `alt=""` et aucun `title` redondant. | `components/mixins/Email.vue`. | PROBABLEMENT OUVERT : alt actuel « Newsletter email ». | `FIXED` — WP2 : `/newsletter_img.png` porte `alt=""` sans `title`; le test exhaustif des images publiques verrouille cette alternative décorative. |
| `NEWS-02` | § 15.12, p. 31 | 7.1 | Majeur | Si l’inscription utilise encore une modale : nom valide, `aria-modal=true`, arrière-plan non exposé et focus géré. Si le flux est désormais une page, classer l’ancien ticket `N/A_CURRENT_UI` et auditer la page équivalente. | `pages/abonnements/**`, `components/mail/MailForm.vue`, anciennes modales éventuelles. | FLUX 2024 SEMBLE REMPLACÉ PAR UNE PAGE : ne pas appliquer une correction de modale inexistante. | `N/A_CURRENT_UI` — le déclencheur ouvre la route `/abonnements/nouveau`, confirmée dans le DOM hydraté WP0; les modales de résultat et le formulaire équivalent restent audités par `NEWS-03` à `NEWS-07`. |
| `NEWS-03` | § 15.13, p. 32 | 7.1, 8.9, 11.5-11.7 | Majeur / mineur | Regrouper les choix de profil sous un `fieldset`/`legend` explicite ou un composant natif équivalent; chaque contrôle doit être compréhensible isolément. | `components/mixins/Profile.vue`, `components/mail/MailForm.vue`. | À VÉRIFIER DANS LE DOM GÉNÉRÉ. | `FIXED` — WP4 : `Profile.vue` rend un `fieldset` avec légende explicite et quatre boutons `type="button"` nommés, dont un seul expose `aria-pressed="true"`; DOM vérifié par Cypress. |
| `NEWS-04` | § 15.14, p. 32-33 | 11.10, 11.11, 11.13 | Majeur | Pour l’e-mail : aide persistante, exemple de format, message de correction utile, `autocomplete=email`, type de champ approprié et association des erreurs. | `components/mail/MailForm.vue`. | PARTIELLEMENT CORRIGÉ : hint et autocomplete présents; le champ est encore `type=text`, et les associations d’erreurs doivent être vérifiées. | `FIXED` — WP4 : entrée native `type="email"`, `autocomplete="email"`, aide « nom@exemple.fr » visible hors du libellé et reliée; le message de format est ajouté à `aria-describedby` puis retiré après correction. |
| `NEWS-05` | § 15.15, p. 33 | 6.1, 10.2 | Majeur | Le lien vers les données personnelles ouvert dans une nouvelle fenêtre doit l’annoncer de manière accessible. | `components/mail/MailForm.vue`. | SEMBLE CORRIGÉ PAR `title`; vérifier nom accessible. | `FIXED` — WP2 : la règle globale conserve « données collectées » dans le nom et y ajoute « nouvelle fenêtre » en contenu masqué; le `title` n'est plus la seule information. Test jsdom et audit exhaustif des `target="_blank"`. |
| `NEWS-06` | § 15.16, p. 34 | 11.10 | Majeur | Tous les champs obligatoires (profil, type d’eau, adresse/point, e-mail, consentement) doivent être annoncés avant interaction et porter les attributs pertinents. | `MailForm.vue`, `Profile.vue`, `SearchAddress.vue`, composants DSFR. | PARTIELLEMENT CORRIGÉ; vérifier le rendu et les groupes. | `FIXED` — WP4 : profil, types d'eau, adresse/point, e-mail et consentement indiquent visiblement « (obligatoire) » dans leur légende ou libellé; adresse, e-mail, consentement et sélecteurs natifs portent aussi `required`. |
| `NEWS-07` | § 15.17, p. 35 | 11.10, 11.11 | Majeur | Chaque erreur doit nommer le champ, être liée au contrôle (`aria-describedby` ou mécanisme équivalent), activer `aria-invalid=true`, être retirée/corrigée ensuite et être annoncée au bon moment. | `MailForm.vue`, utilitaire `showInputError`, `DsfrInputGroup` rendu. | OUVERT À TESTER : les props d’erreur existent, mais la relation DOM n’est pas démontrée. | `FIXED` — WP4 : IDs d'erreur stables, `aria-describedby`, `aria-invalid`, régions d'alerte et focus du premier invalide. Cypress provoque puis corrige les erreurs types d'eau, adresse, e-mail et consentement, et vérifie la disparition des relations obsolètes. |

### E. Consommation, gestes, liens utiles et FAQ
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `CONS-01` | § 15.19, p. 36 | 1.3 | Bloquant | L’alternative du graphique doit restituer toutes les données utiles et inclure « Source : Ademe »; supprimer tout `title` contradictoire. | `components/accueil/Gestes.vue`, ressource `/repartition_consommation.svg`. | SEMBLE DÉJÀ CORRIGÉ : alt détaillé avec source; vérifier le DOM de `DsfrPicture`. | `ALREADY_OK` — DOM hydraté WP0 : `DsfrPicture` rend les neuf parts, leurs pourcentages et « Source : Ademe » dans `alt`, avec `title=""`; la légende visible donne aussi la source. |
| `CONS-02` | § 15.20, p. 37 | 1.2 | Mineur | L’illustration du calculateur, si décorative, doit être ignorée (`alt=""`) et sans `title`. | `components/gestes/Callout.vue` et composants associés. | À VÉRIFIER. | `ALREADY_OK` — DOM hydraté WP0 et `components/gestes/Callout.vue` : `/callout_simulateur.svg` rend `alt=""` sans attribut `title`. |
| `CONS-03` | § 15.21, p. 37 | 6.1, 10.2 | Majeur | Le lien vers le calculateur externe doit annoncer la nouvelle fenêtre. | `components/gestes/Callout.vue`. | À VÉRIFIER. | `FIXED` — WP2 : annonce en contenu masqué et `rel="noopener noreferrer"` appliqués dans le DOM; le scénario Cypress de l'accueil couvre ce lien. |
| `GEST-01` | § 15.23, p. 38 | 8.9 | Mineur | Le texte introductif « En plus des restrictions… » doit être un vrai paragraphe. | `components/accueil/Gestes.vue`. | SEMBLE DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : le texte complet est porté par un élément `<p>`. |
| `GEST-02` | § 15.24, p. 38 | 7.1 | Majeur | Ne pas exposer une tablist vide ni des rôles `tabpanel` sans onglets valides. Si l’interface actuelle utilise des boutons/tags pour filtrer, choisir un pattern unique et conforme; ne pas neutraliser les rôles avec `role=""` sans vérifier le DOM final. | `components/accueil/Gestes.vue`, `components/situation/Restrictions.vue`, `DsfrTabs`. | PROBABLEMENT OUVERT/PARTIEL : `DsfrTabs` est utilisé avec des tags externes et `role=""`. | `FIXED` — WP7 : boutons regroupés et nommés, état `aria-pressed`, relation `aria-controls` et région `aria-labelledby`; aucun `tablist`/`tabpanel` orphelin. L'accueil et `/situation` sont testés dans le DOM, avec réinitialisation d'un index devenu invalide. |
| `GEST-03` | § 15.25, p. 39 | 8.9, 9.3 | Mineur | Structurer chaque éco-geste en paragraphe cohérent ou l’ensemble en liste; le sens doit rester clair sans CSS. | `components/gestes/Card.vue`, `data/gestes.json`. | À VÉRIFIER. | `FIXED` — WP7 : un `<ul role="list">` contient un `<li>` par conseil; titre et description forment un paragraphe unique et l'icône décorative est masquée. Le rôle explicite préserve la sémantique malgré `list-style: none`. |
| `LINK-01` | § 15.27, p. 40 | 8.9 | Mineur | Le texte introductif « Toutes les ressources… » doit être un paragraphe. | `components/accueil/Liens.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : l’introduction est un élément `<p>` précédant la liste de ressources. |
| `LINK-02` | § 15.28, p. 40 | 6.1, 10.2 | Majeur | Tous les liens utiles externes doivent annoncer la nouvelle fenêtre et conserver un intitulé explicite. | `components/accueil/Liens.vue`, `data/liens.json`. | SEMBLE CORRIGÉ PAR `title`; vérifier le DOM et `rel=noopener`/`external`. | `FIXED` — WP2 : tous les liens utiles rendus conservent leur intitulé, annoncent « nouvelle fenêtre » dans leur nom et exposent les tokens `noopener noreferrer`; contrôle exhaustif de l'accueil dans Cypress. |
| `FAQ-01` | § 15.30, p. 41 | 9.3 | Majeur | Les titres de catégories ne doivent pas être enfants directs d’une liste d’accordéons si la structure HTML l’interdit. Vérifier le DOM rendu par `DsfrAccordionsGroup`. | `components/accueil/Faq.vue`. | PARTIELLEMENT CORRIGÉ VISUELLEMENT; le DOM du composant DSFR doit être inspecté. | `ALREADY_OK` — Vue-DSFR 7.2.0 rend le groupe comme un `<div>`, sans rôle de liste. Le DOM hydraté conserve le groupe unique, quatre `h3`, dix-sept sections d'accordéon et aucun enfant de liste invalide. |
| `FAQ-02` | § 15.31, p. 41-42 | 9.1 | Majeur | Les questions doivent avoir le niveau de titre attendu (`h4` dans la hiérarchie actuelle). | `components/accueil/Faq.vue`. | SEMBLE DÉJÀ CORRIGÉ avec `titleTag="h4"`. | `ALREADY_OK` — DOM hydraté WP0 : chaque catégorie est un `h3` et chaque `fr-accordion__title` rendu est un `h4`. |
| `FAQ-03` | § 15.32, p. 42 | 9.3 | Majeur | La liste des causes de sécheresse doit être une vraie liste non ordonnée. | `client/data/faq.json`. | SEMBLE CORRIGÉ, mais corriger le HTML malformé/typos (`&nbps;`) et tester le rendu `v-html`. | `FIXED` — WP7 : trois causes dans un `<ul>`, paragraphes séparés autour de la liste et entité corrigée en `&nbsp;`. Parse5, jsdom et Cypress vérifient le fragment injecté. |
| `FAQ-04` | § 15.33, p. 43 | 9.3 | Majeur | Les quatre niveaux d’alerte doivent être une liste ordonnée. | `client/data/faq.json`. | SEMBLE DÉJÀ CORRIGÉ. | `ALREADY_OK` — contenu et DOM hydraté WP0 : les quatre niveaux sont les quatre items d’un `<ol>`. |
| `FAQ-05` | § 15.34, p. 44 | 9.3 | Majeur | Les axes du plan d’action doivent être une liste; les flèches purement décoratives doivent être masquées aux TA. | `client/data/faq.json`. | SEMBLE DÉJÀ CORRIGÉ, à valider. | `ALREADY_OK` — contenu et DOM hydraté WP0 : trois items dans un `<ul>`; chaque flèche est dans un `<span aria-hidden="true">`. |
| `FAQ-06` | § 15.35, p. 44 | 6.1, 10.2 | Majeur | Les liens externes de la réponse sur le plan d’action doivent annoncer la nouvelle fenêtre. | `client/data/faq.json`. | PARTIELLEMENT CORRIGÉ; vérifier tous les liens injectés par `v-html`. | `FIXED` — WP2 : l'observer traite les ancres de `faq.json` après leur insertion par `v-html`; le nom conserve l'URL/libellé visible et annonce la nouvelle fenêtre. Cypress contrôle les 22 liens externes de l'accueil. |
| `FAQ-07` | § 15.36, p. 45 | 9.3 | Majeur | L’énumération de la réponse sur les pouvoirs du maire doit être structurée en liste. Conserver le type de liste conforme au sens; le rapport proposait `ol`, le contenu actuel utilise `ul`, à arbitrer selon l’ordre sémantique. | `client/data/faq.json`. | À REQUALIFIER : ne pas transformer en `ol` sans justification sémantique. | `ALREADY_OK` — contenu et DOM hydraté WP0 : les trois compétences indépendantes sont dans un `<ul>`; l’ordre n’exprime ni procédure ni classement, donc une liste non ordonnée est sémantiquement correcte. |
| `FAQ-08` | § 15.37, p. 45 | 6.1, 10.2, 13.3 | Majeur / bloquant contenu | Les liens de la réponse sur l’arrosage doivent annoncer la nouvelle fenêtre; traiter aussi l’accessibilité des PDF liés. | `client/data/faq.json`. | PARTIELLEMENT CORRIGÉ POUR LES LIENS, DOCUMENTS ENCORE À TRAITER. | `FIXED` — WP9 remplace les deux PDF 404 par une page HTML officielle détaillant la gestion et les mesures de restriction. Le lien conserve son libellé, est sécurisé et annonce la nouvelle fenêtre; absence des anciennes URL et de tout PDF direct testée. |
| `FAQ-09` | § 15.38, p. 45 | 6.1, 10.2 | Majeur | Le lien vers la qualité de l’eau doit annoncer la nouvelle fenêtre. | `client/data/faq.json`. | SEMBLE CORRIGÉ. | `FIXED` — WP2 : l'ancre injectée « eaupotable.sante.gouv.fr » conserve ce libellé et inclut l'annonce masquée; vérifiée dans le parcours accueil. |
| `FAQ-10` | § 15.39, p. 45 | 6.1, 10.2, 13.3 | Majeur / contenu | Le lien/PDF de la réponse hôpitaux-EHPAD doit annoncer la nouvelle fenêtre et offrir une version accessible si nécessaire. | `client/data/faq.json`. | À VÉRIFIER ET TRAITER CÔTÉ DOCUMENT. | `FIXED` — le contenu utile reste présenté en HTML dans VigiEau et le PDF direct est remplacé par la fiche HTML officielle de l'instruction ORSEC sur Légifrance. Le nom du lien et l'annonce de nouvelle fenêtre sont testés. |
| `FAQ-11` | § 15.40, p. 46 | 6.1, 10.2, 13.3 | Majeur / contenu | Le lien/PDF sur l’approvisionnement en cas de coupure doit annoncer la nouvelle fenêtre et offrir une alternative accessible. | `client/data/faq.json`. | À VÉRIFIER ET TRAITER CÔTÉ DOCUMENT. | `FIXED` — les trois moyens de substitution sont structurés en HTML et le PDF direct est remplacé par la fiche HTML officielle de l'instruction ORSEC sur Légifrance. Le nom du lien et l'annonce de nouvelle fenêtre sont testés. |
| `FAQ-12` | § 15.41, p. 46 | 9.3 | Majeur | Les solutions d’approvisionnement doivent être structurées en liste; masquer les flèches décoratives si présentes. | `client/data/faq.json`. | À VÉRIFIER. | `FIXED` — WP7 : les trois puces textuelles deviennent les trois items d'un `<ul>`, encadré par des paragraphes; le lien ORSEC et son annonce de nouvelle fenêtre sont préservés. |

### F. Composants partagés hors contenu éditorial
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `SH-01` | § 15.42, p. 46 | 8.9 | Mineur | Le texte « Vous souhaitez nous poser… » doit être un paragraphe. | `components/accueil/Faq.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — template et DOM hydraté WP0 : le texte et son lien de contact sont contenus dans un `<p>`. |
| `SH-02` | § 15.43, p. 47 | 7.1, 12.8 | Majeur | Sur mobile, le bouton d’affichage du fil d’Ariane ne doit pas exposer d’état/relations inadaptés; après activation, déplacer le focus vers le fil ou le lien Accueil. | `DsfrBreadcrumb` sur pages accessibilité, mentions légales et situation. | À TESTER DANS LE DOM/COMPORTEMENT DE LA VERSION DSFR INSTALLÉE. | `FIXED` — WP1 : les 13 occurrences publiques passent par `AppBreadcrumb`, qui attend l'expansion DSFR puis focalise le premier lien. Les tests à 320 px activent le bouton au clavier et vérifient la disparition du déclencheur ainsi que le focus sur Accueil. |
| `SH-03` | § 15.44, p. 47-48 | 12.8 | Majeur | Après activation d’un lien interne qui remplace le contenu sans rechargement, appliquer la stratégie SPA de titre et focus. | Footer, header, quick links, FAQ/CTA et router-links. | PROBABLEMENT OUVERT GLOBAL. | `FIXED` — WP1 : stratégie centralisée dans `app.vue`, indépendante de l'origine du `RouterLink`. Cypress suit un lien du footer sans rechargement, puis vérifie le nouveau titre, le focus du `h1` et l'annonce de page. |
| `SH-04` | § 15.45, p. 48 | 11.1 | Bloquant | Chaque `select` du choix de type/profil/zone doit avoir une étiquette accessible unique. Préférer `label`/`aria-labelledby` à un `title` seul quand possible. | `components/situation/Status.vue`. | OUVERT : props `titile` mal orthographiée, IDs `profile` dupliqués et labels visuels séparés. | `FIXED` — WP5 : les quatre listes de la page et de la modale ont un `select-id` stable et distinct ainsi qu'un libellé explicite relié. Cypress vérifie les associations dans le DOM, l'absence de `title`/`titile` et l'unicité des IDs à 1400 et 320 px. |
| `SH-05` | § 15.46, p. 49 | 8.9, 11.5 | Majeur | Regrouper les sélecteurs liés dans un `fieldset`/`legend`; ne pas utiliser de titres pour la présentation; garder une phrase intelligible en lecture linéaire. | `components/situation/Status.vue` versions desktop/mobile. | PARTIEL : fieldsets présents, mais labels/IDs, texte intercalé et duplication doivent être corrigés. | `FIXED` — WP5 : les variantes desktop/mobile dupliquées sont remplacées par un seul `fieldset` responsive nommé « Adapter les restrictions affichées à votre situation ». Les contrôles restent contenus dans le viewport et la zone choisie en modale est synchronisée avec la page. |
| `SH-06` | § 15.47, p. 50 | 12.8 | Majeur | Après activation de « Donner mon avis », placer le focus dans le panneau/formulaire Tally ou sur un conteneur de remplacement pertinent. | `client/layouts/basic.vue`, `utils.openTally`, intégration Tally. | À LOCALISER ET TESTER SUR MOBILE. | `FIXED` — WP5 : le quick-link Vue-DSFR utilise son vrai callback `onClick`; le helper cible et focalise l'iframe du formulaire, puis restitue le focus au bouton desktop ou au déclencheur visible du menu mobile. Cypress couvre les deux parcours, dont l'activation clavier à 320 px. |
| `SH-07` | § 15.48, p. 51-52 | 2.2, 10.1 | Majeur / mineur | L’iframe Tally doit avoir un titre français explicite (« VigiEau - retours utilisateurs ») et aucun attribut HTML de présentation obsolète. | Intégration Tally dans utilitaires/scripts/runtime. | À LOCALISER; l’iframe tierce est exemptée pour son contenu, pas pour son titre et son insertion. | `FIXED` — WP5 côté intégration : l'iframe `.tally-form-w881YY` reçoit le titre français demandé et perd les cinq attributs obsolètes actuellement injectés, sans toucher aux autres iframes ni aux dimensions valides. Tests unitaires et Cypress verrouillent le DOM; le script distant non versionné n'a pas été requalifié par WP10 et reste à contrôler lors d'une recette tierce disponible. |

### G. Page d’accueil, carte et données
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `HOME-01` | § 16.1, p. 53 | 12.8 | Majeur | Après activation du bouton de recherche de la combobox, conserver/replacer le focus dans le champ selon le comportement prévu. | `FdrAutoComplete.vue`, `SearchAddress.vue`. | PARTIEL : la sélection refocalise l’input, mais tester tous les chemins. | `FIXED` — WP3 : le bouton sélectionne l'option active ou la première suggestion puis referme et refocalise l'entrée; sans option, il referme et refocalise aussi. Les deux chemins sont couverts par Cypress. |
| `HOME-02` | § 16.2, p. 54 | 12.8 | Majeur | Après géolocalisation réussie ou échouée, gérer le focus et annoncer le résultat/erreur. | `components/mixins/SearchAddress.vue`. | PARTIEL : succès refocalise l’input; erreur silencieuse et statut non annoncé. | `FIXED` — WP3 : annonce et restitution du focus sur succès, refus, réponse vide et erreur API; délai navigateur borné, réponses obsolètes ignorées et aucune recherche d'adresse déclenchée par la commune localisée. |
| `HOME-03` | § 16.3, p. 54 | 12.8 | Majeur | Après soumission « Je consulte les restrictions », gérer le titre et le focus de la route/du résultat; le contrôle reste un bouton de soumission/action pertinent. | `components/mixins/Search.vue`, utilitaire `searchZones`, route `/situation`. | PROBABLEMENT OUVERT. | `FIXED` — WP1 : le contrôle reste un `DsfrButton`, `searchZones` utilise `router.push`, et la stratégie globale de `app.vue` traite donc le titre, le statut et le focus de `/situation`. Le parcours avec combobox sera rejoué en régression dans WP3 sans réimplémenter cette gestion. |
| `HOME-04` | § 16.4, p. 55 | 1.2 | Mineur | Les illustrations des types d’eau doivent être décoratives si le texte adjacent porte déjà l’information. | `components/accueil/TypesEau.vue`. | DÉJÀ CORRIGÉ avec `alt-img=""`. | `ALREADY_OK` — DOM hydraté WP0 : les trois images `/type_eau_*.svg` rendent `alt=""`; les intitulés sont portés par les titres de cartes adjacents. |
| `HOME-05` | § 16.5, p. 55 | 8.9 | Mineur | Le sous-titre/date « Arrêtés publiés avant… » doit être un paragraphe. | `components/carte/Wrapper.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — `components/carte/Wrapper.vue` et DOM hydraté WP0 : la date est dans un `<p>` placé après le `h2`. |
| `HOME-06` | § 16.6, p. 56 | 7.1 | Mineur | Chaque onglet doit référencer par `aria-controls` l’ID réel de son panneau. | `components/carte/Wrapper.vue`, rendu `DsfrTabs`. | SEMBLE CONFIGURÉ (`tab-0`/`tab-content-0`), À VÉRIFIER DANS LE DOM. | `FIXED` — WP6 : `AccessibleTabs` dérive les IDs de l'instance; chaque `aria-controls` et `aria-labelledby` résout exactement son onglet ou panneau dans le DOM hydraté. |
| `HOME-07` | § 16.7, p. 56 | 12.8 | Majeur | Les panneaux d’onglets ne doivent pas ajouter d’arrêt de tabulation inutile; supprimer tout `tabindex=0` non justifié. | `DsfrTabContent` rendu. | À VÉRIFIER DANS LE DOM DE LA DÉPENDANCE. | `FIXED` — WP6 : panneaux à `tabindex="-1"`, un seul onglet à `tabindex="0"`; flèches, Début et Fin déplacent la sélection et le focus avec rebouclage. Cypress vérifie aussi le panneau masqué. |
| `HOME-08` | § 16.8, p. 57 | 7.1, 12.8 | Majeur / amélioration | La carte étant exemptée, fournir une alternative textuelle/données pleinement utilisable. Ne pas laisser des contrôles cartographiques inaccessibles polluer le parcours clavier; ne pas masquer la solution alternative. | `components/carte/Map.vue`, `Wrapper.vue`, `Table.vue`, affichage embarqué sur l’accueil. | À RECONCEVOIR EN FONCTION DU DOM ACTUEL; l’accueil contient désormais une carte interactive avant le formulaire. | `FIXED` — WP6 fournit instructions, noms français, sélection au point central par Entrée/Espace et accès visible à l'onglet Données. WP10 exerce une couche MapLibre rendue : popup nommé, focus initial et restitué, bouton atteignable puis navigation vers Situation; le tableau reste utilisable sans carte. La réussite du décodage PMTiles distant n'est pas déduite de cette fixture déterministe. |
| `HOME-09` | § 16.9, p. 57-58 | 10.3, 8.9 | Majeur / mineur | Chaque niveau et son nombre de départements doivent rester associés sans CSS, idéalement dans le même item de liste/paragraphe. | `components/carte/Table.vue`. | PARTIEL : une liste est utilisée, mais chaque carte contient deux `li` séparés; restructurer en un item cohérent. | `FIXED` — WP6 : une unique liste contient cinq items; chaque `li` réunit le badge du niveau et son nombre de départements. Structure vérifiée statiquement et dans le DOM. |
| `HOME-10` | § 16.10, p. 58 | 11.1 | Bloquant | Le champ de filtrage des départements doit avoir une étiquette accessible explicite, pas seulement un placeholder. | `components/carte/Table.vue`, rendu `DsfrSearchBar`. | PARTIEL : `title="Rechercher un département"`; préférer/valider un vrai label. | `FIXED` — WP6 : champ natif `type="search"` avec ID stable et libellé visible « Rechercher un département » associé par `for`. |
| `HOME-11` | § 16.11, p. 58 | 11.9 | Majeur | Le bouton de recherche des départements doit être distingué du bouton d’adresse dans son nom accessible. | `components/carte/Table.vue`, `DsfrSearchBar`. | À VÉRIFIER : `buttonText="Rechercher"` générique malgré le title du champ. | `FIXED` — WP6 : le bouton de soumission porte le contenu réel « Rechercher un département », distinct de la recherche d'adresse. Entrée et clic utilisent le même formulaire. |
| `HOME-12` | § 16.12, p. 59 | 7.5 | Majeur | Après filtrage, annoncer le nombre de départements trouvés dans une zone de statut préexistante. | `components/carte/Table.vue`. | OUVERT : aucune zone live visible dans le composant. | `FIXED` — WP6 : une région `role="status"` polie et atomique existe avant la recherche puis annonce 0, 1 ou N départements, la requête, la taille et la page sans région concurrente. |
| `HOME-13` | § 16.13, p. 59 | 5.4 | Majeur | Le tableau doit avoir un `caption`/titre correctement associé. | `components/carte/Table.vue`, rendu `DsfrTable` avec prop `title`. | À VÉRIFIER DANS LE DOM : la prop existe, mais classe `fr-table--no-title` peut masquer ou supprimer le titre. | `FIXED` — WP6 : le composant partagé rend un `caption` visible, non vide et enfant direct de chaque table; les en-têtes portent `scope="col"`. |
| `HOME-14` | § 16.14, p. 60 | 5.1, 5.6, 5.7 | Majeur | La pagination ne doit pas être intégrée comme une ligne fusionnée du tableau. Les en-têtes doivent s’appliquer uniquement aux données et l’ensemble rester un tableau simple. | `DsfrTable` rendu / éventuel composant local de table. | À VÉRIFIER; si la dépendance génère encore cette structure, remplacer/encapsuler localement sans modifier `node_modules`. | `FIXED` — WP6 : `AccessibleDataTable` remplace les sept tables publiques paginées; le `tbody` ne contient que des lignes de données et les contrôles sont placés après la table. Aucun `DsfrTable` paginé public ne subsiste. |
| `HOME-15` | § 16.15, p. 60 | 11.1 | Bloquant | Le sélecteur « Résultats par page » doit avoir un label explicite lié par `for`/`id`. | Pagination générée par `DsfrTable`. | À VÉRIFIER DANS LE DOM. | `FIXED` — WP6 : chaque instance dérive un ID unique de son `tableId`; le libellé visible pointe vers ce sélecteur et `aria-controls` vers la bonne table. Deux instances simultanées testées. |
| `HOME-16` | § 16.16, p. 61 | 7.4 | Majeur | Si le changement de taille de page est automatique, l’annoncer avant interaction dans le nom/aide; sinon ajouter un bouton de validation. Annoncer ensuite la mise à jour. | Pagination générée par `DsfrTable`. | À VÉRIFIER. | `FIXED` — WP6 : le libellé annonce « mise à jour automatique » avant interaction; la région stable annonce ensuite la nouvelle taille et le retour en page 1. Le cas dernière page puis taille 25 est couvert. |
| `HOME-17` | § 16.17, p. 61-62 | 7.1, 10.2 | Bloquant / majeur | Chaque bouton de pagination doit avoir un nom complet et discriminant (première/précédente/suivante/dernière page du tableau). Une icône CSS seule est insuffisante. | Pagination générée par `DsfrTable`. | À VÉRIFIER; bloquant prioritaire. | `FIXED` — WP6 : les quatre boutons contiennent un texte réel et un nom contextualisé par la table; première/précédente et suivante/dernière sont désactivés aux bornes correspondantes. |
| `HOME-18` | § 16.18, p. 62-63 | 7.5 | Majeur | Annoncer le changement de page et le numéro courant dans une zone de statut. | Pagination générée par `DsfrTable`. | À VÉRIFIER; aucune gestion locale visible. | `FIXED` — WP6 : l'unique statut préexistant annonce « Page X sur Y » et la plage de résultats après chaque action; tests page suivante, dernière page et changement de taille. |

### H. Pages institutionnelles et situation
| ID | Rapport | Critère(s) | Sévérité | Exigence | Cibles probables | Pré-analyse | État / preuve |
|---|---:|---|---|---|---|---|---|
| `ACC-01` | § 17.1, p. 63-64 | 6.1, 10.2 | Majeur | Tous les liens externes de la déclaration d’accessibilité doivent annoncer la nouvelle fenêtre. | `pages/accessibilite/index.vue`. | À AUDITER EXHAUSTIVEMENT. | `FIXED` — WP2 : les 11 liens `target="_blank"` rendus sur `/accessibilite` conservent leur texte et annoncent la nouvelle fenêtre; tokens `rel` et unicité du suffixe contrôlés par Cypress. WP9 sépare en complément listes et paragraphes, actualise le plan 2026 et rend le contact e-mail/téléphone actionnable sans modifier les résultats de l'audit 2025. |
| `LEG-01` | § 18.1, p. 64 | 6.1, 10.2 | Majeur | Tous les liens externes des mentions légales doivent annoncer la nouvelle fenêtre. | `pages/mentions-legales/index.vue`. | SEMBLE CORRIGÉ POUR beta.gouv; vérifier tout le fichier et le rendu. | `FIXED` — WP2 : contrôle exhaustif du DOM de `/mentions-legales`; chaque nouvelle fenêtre conserve son libellé, porte l'annonce masquée et un `rel` sécurisé. WP9 retire la mention obsolète « par intérim » du directeur de la publication et corrige les libellés institutionnels adjacents. |
| `LEG-02` | § 18.2, p. 65 | 8.9 | Mineur | Supprimer tout paragraphe vide utilisé pour espacer les sections; utiliser CSS. | `pages/mentions-legales/index.vue`. | SEMBLE DÉJÀ CORRIGÉ; vérifier le DOM rendu. | `ALREADY_OK` — source et DOM hydraté de `/mentions-legales` WP0 : aucun paragraphe vide dans le contenu de la page. WP9 confirme cette structure après actualisation du contenu; le paragraphe vide distinct généré par le footer partagé a été traité en WP1. |
| `SIT-01` | § 19.1, p. 66 | 8.9 | Mineur | Les messages de situation sans restriction et le conseil d’éco-gestes doivent être de vrais paragraphes. | `components/situation/Header.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — WP8 confirme que les deux messages ciblés dans `Header.vue` sont déjà des paragraphes; les branches « Aucune restriction » de `Restrictions.vue` ont aussi été uniformisées en `<p>`. |
| `CRISIS-01` | § 20.1, p. 67-68 | 8.9 | Mineur | La description du niveau de crise doit être un paragraphe. | `components/situation/Header.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — source, test statique et DOM WP8 : la description du niveau est portée par un paragraphe. |
| `CRISIS-02` | § 20.2.1.1, p. 69 | 9.1 | Majeur | Chaque restriction doit avoir un vrai titre de niveau 3 cohérent. | `components/situation/RestrictionCard.vue`. | DÉJÀ/PARTIELLEMENT CORRIGÉ avec `<h3>`; vérifier la hiérarchie autour. | `ALREADY_OK` — chaque carte conserve son vrai `<h3>`; les accordéons mobiles utilisent également un niveau 3 au lieu de créer le saut `h2` vers `h4`. La hiérarchie desktop/mobile est testée. |
| `CRISIS-03` | § 20.2.1.2, p. 69-70 | 7.1 | Majeur | Les boutons d’information identiques doivent être contextualisés par le titre de la restriction via `aria-describedby` ou un nom unique. | `components/situation/RestrictionCard.vue`. | SEMBLE DÉJÀ CORRIGÉ avec ID + `aria-describedby`; vérifier unicité et nom calculé. | `ALREADY_OK` — le bouton était déjà décrit par le titre de sa restriction; WP8 remplace l'ID aléatoire par un ID `useId()` stable et vérifie l'unicité sur plusieurs cartes. |
| `CRISIS-04` | § 20.2.2.1, p. 70 | 7.1 | Majeur | La modale d’information doit être modale au sens accessible et rendre l’arrière-plan inerte/non parcourable. | `RestrictionCard.vue`, rendu `DsfrModal`. | À VÉRIFIER DANS LE DOM ET AU CLAVIER. | `FIXED` — WP8 remplace les modales publiques Vue-DSFR par `AccessibleModal`, fondé sur `dialog.showModal()`. Cypress vérifie `:modal`, l'inertie du fond, le verrouillage du défilement et la boucle Tab/Maj+Tab. |
| `CRISIS-05` | § 20.2.2.2, p. 71 | 7.1 | Mineur | Le bouton « Annuler » doit expliciter qu’il ferme la boîte de dialogue. | `RestrictionCard.vue`. | SEMBLE DÉJÀ CORRIGÉ avec `title="Annuler et fermer"`; vérifier nom accessible. | `FIXED` — le contenu réel du bouton devient « Annuler et fermer »; il ne dépend plus de `title` pour expliciter l'action. |
| `CRISIS-06` | § 20.2.2.3, p. 71 | 8.9 | Mineur | Le texte explicatif de la modale doit être structuré en paragraphe. | `RestrictionCard.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — les explications sont des paragraphes; WP8 sépare en plus les deux idées sans retour de mise en forme. |
| `CRISIS-07` | § 20.2.2.4, p. 72 | 8.9, 7.5 | Majeur | Le message de succès « Votre retour… » doit être un paragraphe et être annoncé immédiatement (focus contrôlé ou statut live) sans titre vide. | `RestrictionCard.vue`. | PARTIEL : paragraphe présent, mais modale de succès a `title=" "` et aucune annonce explicite visible. | `FIXED` — la modale unique passe à un titre non vide « Votre retour a été envoyé », conserve une région de statut et refocalise son contenu lors du passage au succès. Une réponse API en erreur ne produit plus de faux succès. |
| `CRISIS-08` | § 20.2.2.5, p. 73 | 10.7, 12.8 | Note majeure de régression | À fermeture, restaurer le focus sur le déclencheur et garantir un indicateur de focus visible. | `RestrictionCard.vue`, styles DSFR. | PARTIEL : restauration explicite du focus présente; vérifier visibilité réelle. | `FIXED` — fermeture, Annuler et Échap restituent exactement le bouton de la carte d'origine. Cypress multi-cartes vérifie `:focus-visible` et l'indicateur DSFR; les réponses asynchrones obsolètes ne rouvrent pas la modale. |
| `CRISIS-09` | § 20.2.3, p. 73 | 8.9 | Mineur | Le texte sur l’amende doit être un paragraphe, pas une balise de mise en forme. | `components/situation/Restrictions.vue`. | DÉJÀ CORRIGÉ. | `ALREADY_OK` — le texte ciblé est déjà un paragraphe dans la source et le DOM vérifiés en WP8. |
| `CRISIS-10` | § 20.2.4.1, p. 73-74 | 9.1 | Majeur | « Besoin de précision sur les restrictions ? » doit être un vrai `h3` cohérent. | `components/situation/Restrictions.vue` et fallback dans `Status.vue`. | PARTIEL : `Restrictions.vue` utilise `<h3>`, mais `Status.vue` utilise encore `<b>` dans `DsfrHighlight`. | `FIXED` — le fallback de `Status.vue` utilise désormais un vrai `<h3>` comme la branche de `Restrictions.vue`; le test couvre les deux composants. |
| `CRISIS-11` | § 20.2.4.2, p. 74 | 8.9 | Mineur | Remplacer les doubles `<br>` de mise en forme par des paragraphes séparés. | `components/situation/Status.vue`, `Restrictions.vue`. | OUVERT DANS LE FALLBACK `Status.vue` (`<b>` + `<br>`). | `FIXED` — le fallback est restructuré en titre et paragraphe frères, sans `<br>` de mise en forme; les messages « Aucune restriction » sont également des paragraphes. |
| `CRISIS-12` | § 20.2.4.3, p. 74 | 6.1, 10.2, 13.3 | Majeur / contenu | Les liens vers arrêtés PDF doivent annoncer la nouvelle fenêtre; vérifier l’accessibilité des documents ou fournir une alternative. | `components/situation/Header.vue`, `Restrictions.vue`, documents fournis par API. | PARTIEL : certains liens ont un title, celui de l’arrêté municipal n’en a pas; documents dynamiques à traiter/documenter. | `BLOCKED_CONTENT` — WP2 sécurise et annonce les liens d'arrêtés présents ou injectés. WP9 ajoute sur Situation et dans le tableau public un avis visible : les informations HTML sont une aide opérationnelle, l'arrêté signé reste la référence et le contact accessibilité peut orienter vers une autre forme. La conformité des PDF API reste à fournir par la préfecture/DDT(M) ou la commune; le contrat VigiEau ne porte encore ni statut ni alternative vérifiée. |

## 12. Matrice de validation manuelle

Preuves datées du 11 août 2026 sur les routes réellement présentes sur
`master`. « Zoom 400 % » désigne ici le contrôle de redistribution à 320 px
CSS équivalent à un viewport de 1280 px agrandi à 400 %; le zoom natif de
chaque navigateur n'a pas été rejoué. « Lecteur d'écran » reste non exécuté
faute de NVDA dans l'environnement; les contrôles d'arbre AX Chrome ne sont pas
présentés comme un remplacement.

| Parcours / page | 320 px | Zoom 200 % texte | Zoom 400 % | Clavier seul | Lecteur d’écran | Sans CSS / ordre DOM | Contrastes | Résultat |
|---|---|---|---|---|---|---|---|---|
| Accueil - sélection profil/type + adresse | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK combobox, erreurs, soumission | NON EXÉCUTÉ — AX Chrome contrôlé | OK Chrome sans CSS | OK mesures WP2/WP10 | OK technique; recette NVDA externe |
| Accueil - carte et alternative données | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK onglets, carte, popup, alternative | NON EXÉCUTÉ — AX Chrome contrôlé | OK Chrome sans CSS | OK mesures WP2/WP10 | OK technique; PMTiles distant non qualifié |
| Page données - filtre/tableau/pagination | OK Chrome, défilement interne seul | OK racine 32 px | OK redistribution 320 px | OK filtre, taille, pagination, régions défilantes | NON EXÉCUTÉ — AX Chrome contrôlé | OK ordre DOM/tableau | OK contrôle ciblé | OK technique; recette NVDA externe |
| Abonnement - tous les cas d’erreur | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK validation, 409/500, succès, désabonnement | NON EXÉCUTÉ — AX Chrome contrôlé | OK Chrome sans CSS | OK contrôle ciblé | OK technique; recette NVDA externe |
| Situation sans restriction | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK sélecteurs, annonces et navigation | NON EXÉCUTÉ — AX Chrome contrôlé | OK structure/ordre DOM | OK mesures WP2/WP10 | OK technique; recette NVDA externe |
| Situation avec restrictions/crise | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK filtres, cartes, retours et erreurs API | NON EXÉCUTÉ — AX Chrome contrôlé | OK structure/ordre DOM | OK mesures WP2/WP10 | OK technique; PDF dynamiques bloqués |
| Modale « Je ne comprends pas… » | OK à 320 px | OK dans la page agrandie | OK redistribution 320 px | OK Tab/Maj+Tab, Échap, inertie, restitution | NON EXÉCUTÉ — AX Chrome contrôlé | N/A, `dialog` natif contrôlé | OK DSFR/ciblé | OK technique; recette NVDA externe |
| Menu mobile | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK focus, boucle et Échap | NON EXÉCUTÉ — AX Chrome contrôlé | N/A | OK DSFR/ciblé | OK technique; recette NVDA externe |
| Fil d’Ariane mobile | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK expansion et focus Accueil | NON EXÉCUTÉ — AX Chrome contrôlé | OK ordre DOM | OK DSFR/ciblé | OK technique; recette NVDA externe |
| Accessibilité / mentions légales | OK Chrome/Cypress | OK racine 32 px | OK redistribution 320 px | OK liens, fragment et focus ciblé | NON EXÉCUTÉ — AX Chrome contrôlé | OK Chrome sans CSS | OK contrôle ciblé | OK structure; contenu propriétaire à valider |

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
