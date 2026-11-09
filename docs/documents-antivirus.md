# Antivirus des documents administratifs

Le backend d'administration utilise le [buildpack ClamAV officiel de Scalingo](https://github.com/Scalingo/clamav-buildpack), fixé au commit `661a265ae1898e44f140c5765788cae26533bc74`. Il s'exécute dans les conteneurs `web` existants de `regleau-back-preprod` et `regleau-back-prod`, sur un socket Unix local. Aucun port antivirus n'est exposé sur Internet et aucun service permanent supplémentaire n'est nécessaire.

Les fichiers soumis sont analysés avant leur stockage public. Un fichier malveillant, chiffré, dépassant les limites d'analyse, un moteur indisponible ou une analyse interrompue ne sont jamais acceptés comme un résultat sain. Le contrôle est obligatoire en préproduction et en production ; son désarmement n'est pas une procédure de reprise.

## Configuration et déploiement

Ordre de `.buildpacks` : APT, ClamAV, puis Node. Le buildpack ClamAV installe le moteur et les signatures. `scalingo-postbuild` appelle `build:antivirus` avant la compilation métier pour compléter `clamav/conf/clamd.conf` dans le répertoire du build. La configuration n'est pas réécrite au démarrage du conteneur.

Variables à définir **avant la construction**, sur les deux applications admin :

```dotenv
ANTIVIRUS_ENABLED=true
ANTIVIRUS_TIMEOUT_MS=15000
ANTIVIRUS_MAX_DATABASE_AGE_HOURS=72
CLAMDSCAN_PATH=clamdscan
CLAMD_CONFIG_FILE=/app/clamav/conf/clamd.conf
CLAMAV_VERSION=1.4.6
CLAMAV_DISABLE_PROCESS_TYPES=clock,currentzoneworker,historicbackfillworker,historicartifactworker,postdeploy,one-off
```

Laisser `CLAMD_DISABLE_DAEMON` et `FRESHCLAM_DISABLE_DAEMON` absentes. Le réglage `CLAMD_DISABLE_CONCURRENT_RELOAD` du buildpack n'est pas utilisé : le postbuild fixe explicitement `ConcurrentDatabaseReload yes`. Toute modification du moteur, du buildpack ou de la configuration d'analyse nécessite une nouvelle construction.

Les processus `clock`, `currentzoneworker`, `historicbackfillworker`, `historicartifactworker`, `postdeploy` et `one-off` ne démarrent pas automatiquement l'antivirus. Ajouter tout nouveau processus non web à cette liste. Attention : une valeur vide de `CLAMAV_DISABLE_PROCESS_TYPES` remet les exclusions par défaut du buildpack, elle ne les supprime pas.

La configuration d'analyse comporte :

- `StreamMaxLength 32M`, `MaxFileSize 32M` et `MaxScanSize 128M` pour borner les données reçues et décompressées ; cela ne relève pas la limite métier d'upload de 10 000 000 octets.
- `AlertExceedsMax yes` et `AlertEncrypted yes` pour refuser les analyses incomplètes et les documents protégés.
- `MaxThreads 1`, `MaxQueue 2` et `MaxScanTime 10000`. Le délai absolu de 15 secondes côté application reste nécessaire : la limite interne du moteur ne couvre pas uniformément tous les formats.
- `ConcurrentDatabaseReload yes` pour continuer les analyses pendant le chargement de nouvelles signatures.

Déployer d'abord en préproduction et vérifier : document sain accepté ; fichier de test EICAR refusé ; document chiffré ou analyse interrompue refusés ; indisponibilité du moteur refusée ; aucun objet public créé après un refus. Vérifier la mémoire pendant les uploads et un rechargement de signatures, avec une cible de pic inférieure à 80 % des 4 Go alloués. La production ne suit qu'après ces contrôles.

La vérification isolée du moteur réel se lance avec :

```sh
scalingo --region osc-fr1 --app regleau-back-preprod run --size 2XL 'npm run antivirus:verify'
```

Elle n'accède ni à S3 ni à la base métier : elle génère ses propres fichiers sains, EICAR, ZIP avec EICAR et ZIP chiffré, teste les limites client, le timeout et un socket absent, puis demande `RELOAD` à son propre daemon et attend la confirmation du moteur. Elle échantillonne la mémoire du cgroup toutes les 100 ms et émet un bilan JSON. Une erreur, un contrôle négatif ou un pic de rechargement atteignant 80 % fait échouer la commande.

Le bilan comporte `includesApplicationWebProcess: false` : ce pic comprend l'antivirus et le client de vérification, **pas le processus NestJS web**. Ajouter la marge observée du web pour apprécier la capacité totale avant promotion ; ne pas présenter cette mesure isolée comme un test de charge complet de l'application.

## Analyse des documents déjà stockés

Le batch est distinct des requêtes HTTP et utilise un conteneur temporaire 2XL. La migration de journal d'analyse doit être appliquée avant son lancement. La commande reprend les résultats déjà journalisés ; utiliser `--rescan` uniquement pour demander leur réanalyse. `--dry-run`, également le mode par défaut, fait seulement l'inventaire : aucun scan, aucune quarantaine et aucune écriture en base.

Depuis la CLI Scalingo authentifiée, commencer par l'inventaire en préproduction :

```sh
scalingo --region osc-fr1 --app regleau-back-preprod run --size 2XL 'npm run documents:scan -- --dry-run'
```

Puis un lot limité avant l'analyse complète :

```sh
scalingo --region osc-fr1 --app regleau-back-preprod run --size 2XL 'npm run documents:scan -- --execute --limit 10'
scalingo --region osc-fr1 --app regleau-back-preprod run --size 2XL 'npm run documents:scan -- --execute'
```

Après validation du bilan et de la quarantaine en préproduction, appliquer la même séquence à `regleau-back-prod`. Pour une commande longue, utiliser le mode détaché de `scalingo run` et conserver l'identifiant du conteneur pour suivre les logs. Ne jamais lancer le batch dans le processus `web` ou un worker métier.

`documents:scan` lance `scripts/run-document-scan.mjs`. En mode inventaire, ce lanceur exécute directement la commande métier, sans démarrer ClamAV. Avec `--execute`, il :

1. Vérifie qu'il n'est pas exécuté dans un conteneur métier et refuse un one-off ayant déjà démarré automatiquement ClamAV.
2. Crée une configuration et un socket temporaires propres au batch, sans changer la configuration web.
3. Actualise immédiatement les signatures avec `freshclam`. Un échec arrête la commande avant l'analyse.
4. Démarre `clamd`, attend son `PONG`, puis exécute `dist/apps/backend-admin/src/scripts/scan-documents.js` avec les arguments reçus.
5. Applique `MaxScanTime 60000` au moteur et un délai client de 75 secondes, avec une seule analyse à la fois.
6. Arrête le moteur et supprime sa configuration temporaire à la fin ou à l'interruption de la commande.

Les limites de taille et les alertes restent les mêmes que sur le web. Le journal distingue fichiers sains, malveillants, non analysables, erreurs et objets manquants. `document_scan_run` conserve le bilan et les points de reprise, `document_scan_result` les résultats associés aux versions d'objets. Le batch produit un bilan JSON ; en exécution il émet aussi une ligne JSON de progression par objet. Les logs exposent des identifiants et empreintes de clés, pas les secrets ni les noms de fichiers. Les détails d'identité restent dans le journal en base, accessible aux opérateurs autorisés.

Une exécution interrompue ou comportant des erreurs ne constitue pas une analyse complète du stock. Les fichiers identifiés comme dangereux sont mis en quarantaine privée, et leur ancienne URL doit devenir inaccessible ; aucune suppression définitive de leur contenu n'est nécessaire pour la quarantaine.

## Exploitation

Le buildpack inclut les signatures dans l'image et `freshclam` les vérifie douze fois par jour. Au démarrage normal, sa première vérification est décalée aléatoirement jusqu'à une heure pour éviter les téléchargements simultanés. Le lanceur historique effectue sa propre actualisation immédiate.

Surveiller les erreurs d'upload liées à l'antivirus, la date de la base réellement chargée, les mises à jour `freshclam` et la mémoire des processus web. Une base âgée de plus de 72 heures doit provoquer un refus d'analyse. Les écritures sur le disque Scalingo disparaissent aux redémarrages ; les rapports et décisions de quarantaine doivent rester dans les stockages durables, pas uniquement dans `/tmp`.

Maintenir la version du moteur explicitement : le commit de buildpack fixé utilise encore `1.4.2` par défaut. Pour une mise à jour, vérifier la [version ClamAV maintenue](https://docs.clamav.net/faq/faq-eol.html), modifier `CLAMAV_VERSION`, reconstruire et répéter les contrôles en préproduction. Les mises à jour de signatures ne remplacent pas les correctifs du moteur.

En cas d'incident, conserver le refus des nouveaux fichiers et rétablir un daemon opérationnel ou la dernière version **incluant la protection antivirus**. Ne pas revenir à une version antérieure dépourvue d'analyse, ne pas passer `ANTIVIRUS_ENABLED` à `false` en préproduction ou production et ne pas rendre publics les fichiers en quarantaine pour contourner un blocage. Ne pas restaurer publiquement un document avant examen de la détection et nouvelle analyse favorable.

## Coût et vérifications locales

Les conteneurs web 4 Go étant déjà provisionnés, cette intégration n'ajoute aucun coût permanent tant que leur taille reste inchangée. Un one-off 2XL en région standard coûte environ **0,16 € HT par heure**, facturé à la minute, d'après le [tarif Scalingo](https://scalingo.com/pricing) de 115,20 € HT pour 30 jours. La durée d'analyse réelle détermine le coût du rattrapage ; les éventuels coûts de stockage ou de transfert restent distincts.

```sh
node --test scripts/clamav-buildpack.test.mjs
```

Ces tests vérifient les limites, l'absence d'écoute TCP, l'idempotence du postbuild, l'actualisation préalable, le passage des arguments et l'arrêt du daemon du batch. Ils utilisent des exécutables simulés et ne prouvent pas à eux seuls la bonne détection par ClamAV : les essais avec le moteur réel en préproduction restent nécessaires.
