# Surveillance et incidents de production

## Deux resultats distincts

Le workflow `production-incidents.yml` collecte depuis les runners GitHub, donc
hors de Scalingo. Il ne deploie rien, n'utilise aucune base de donnees et ne
modifie aucun metier. Son jeton ephemere autorise seulement la lecture du code,
les issues et les checks du depot.

- Toutes les 15 minutes : sites public/admin, API publique, base admin, caches,
  horloge metier, publication des zones, completude historique et publications externes.
- Toutes les six heures et sur demande : les six smokes stricts existants,
  y compris le navigateur, SANDRE, les historiques certifies et les archives.
- Les checks `Production / ...` sont rouges si un contrat est en echec.
- Le workflow de **collecte** est vert seulement si les observations ont ete
  collectees, les checks publies et les etats/notifications persistes. Son succes
  ne signifie jamais que la production est saine. Toute erreur GitHub ou
  execution incomplete fait echouer le collecteur.

Les tests unitaires du collecteur et du transport sont obligatoires dans la CI
du code (`scripts/*.test.mjs`), pas dans la collecte planifiee : un test local
ne doit pas empecher l'observation reelle de la production.

Le workflow historique `production-smoke.yml` reste la verification manuelle
stricte. Son ancienne planification est retiree apres validation du relais et
de la notification reelle le 7 septembre 2026 ; `production-incidents.yml` est
l'unique proprietaire des controles planifies. Voir les preuves dans
[le compte rendu de bascule](production-alerts-20260907.md#delivery-verification).

## Cycle d'incident

Une issue portant le label `production-incident` conserve chaque cause stable.
Le corps contient un etat JSON versionne, accepte uniquement depuis les auteurs
de confiance `github-actions[bot]` et `sghribi`. La recherche utilise la liste
paginee des issues, jamais l'index de recherche. Un groupe de concurrence unique
serialise les collecteurs, y compris les executions manuelles.

L'issue est assignee a `sghribi`. L'ouverture, l'aggravation, le retablissement,
un nouvel episode et au plus un rappel quotidien produisent une notification.
Un echec persistant de meme severite ne produit aucune ecriture sur l'issue avant
le rappel quotidien : ni commentaire, ni modification de corps, titre ou etat.
Les modifications de corps peuvent elles aussi reactiver les notifications GitHub.
Les diagnostics courants restent dans les checks et les runs, accessibles par le
lien permanent de l'issue. La date de derniere observation persistee reste donc
figee entre deux changements significatifs. Les succes d'une issue deja retablie
ne la modifient pas non plus.

La premiere observation de retablissement et toute interruption de confirmation
sont persistees pour garantir deux succes consecutifs ; ces changements de corps
peuvent reactiver le fil, mais aucun commentaire de retablissement n'est envoye
avant la seconde confirmation. Les retours
reseau ambigus apres creation sont reconcilies par marqueur avant toute reprise.
Les transitions de commentaire sont persistees avant l'envoi puis acquittees.

Le retablissement exige deux observations completes consecutives de la cause.
Une observation inconnue, une publication en cours ou une dependance indisponible
n'est jamais une preuve de retablissement et interrompt cette sequence.
L'absence d'un controle profond dans une collecte legere ne change pas son etat.
Un overlay certifie actif couvrant integralement la plage historique laisse la
decision aux canaries profonds ; une plage mutable encore dirty n'est pas, a elle
seule, une erreur lorsque ce profil certifie est explicitement actif.
Une publication en cours n'est toleree que si elle reste servie et progresse
recemment selon la politique existante. Une date metier ancienne apres 07:00
Europe/Paris, soit une heure apres l'echeance quotidienne, reste un echec.
Fermer manuellement une issue persistante ne transforme pas un incident en succes.

La severite est critique pour une indisponibilite, une horloge arretee ou un cache
inexploitable ; les retards/coherences sont des avertissements. Les echecs
historiques explicitement identifies des statistiques et des exports partagent
une cause, mais leur retablissement exige les deux smokes reussis. Les autres
echecs d'export et les controles admin restent independants. Aucune reponse brute
ni secret n'est publie dans une issue ou un check.

## Validation et bascule

```sh
node --test scripts/production-incidents.test.mjs scripts/smoke-http.test.mjs
node scripts/production-incidents.mjs --dry-run
node scripts/production-incidents.mjs --dry-run --deep
gh workflow run production-incidents.yml --ref master -f deep=true
```

`--dry-run` observe les services sans aucun appel d'ecriture GitHub. Sans ce
drapeau, les ecritures sont refusees hors d'un workflow planifie/manuel sur
`master`. Les assertions metier et les echeances Europe/Paris demeurent celles
des scripts existants ; aucune date certifiee n'est ignoree. Chaque smoke profond
est borne a cinq minutes : un timeout est une collecte incomplete, jamais un succes.

Avant suppression de l'ancienne planification : verifier un run complet, les
checks rouges/verts, les tests du cycle ouverture/retablissement avec API simulee,
la notification GitHub du veritable incident et l'absence de doublon au second
passage. La livraison par
email depend des preferences personnelles GitHub et doit etre verifiee separement.
Ne pas modifier les abonnements aux autres workflows ou les commentaires de PR.

## Limites et surveillance du collecteur

GitHub peut retarder ou abandonner une execution planifiee et desactiver les
plannings d'un depot public inactif pendant 60 jours. Il ne fournit donc pas une
garantie de detection a quinze minutes. Les alertes natives Scalingo (5xx soutenus,
memoire et evenements de plateforme) constituent le canal independant complementaire,
pas une preuve que les controles metier continuent de tourner. Verifier l'age
du dernier run dans Actions apres toute modification de configuration.

Sources :
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications

Ne pas annoncer une supervision a garantie stricte sans un watchdog externe
independant de GitHub. Ce relais ne supprime aucune alerte d'infrastructure.
