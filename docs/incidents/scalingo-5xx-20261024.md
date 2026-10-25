# Alertes 5xx de l'API publique — 24 octobre 2026

Diagnostic en lecture seule effectué le 25 octobre 2026. Les horaires de ce
document sont en UTC. Les journaux Scalingo exportés affichent également une
heure locale : le 24 octobre, le décalage CEST est de deux heures.

## Résultat et limites

Une cause applicative récurrente est reproduite : la recherche par coordonnées
refuse plusieurs zones non influencées de même type, même lorsque leurs
prescriptions sont strictement identiques. Deux rafales de dix recherches dans
l'Hérault précèdent deux alertes de valeur dix. La correspondance est forte,
mais les archives applicatives ne contiennent pas le statut de chaque réponse ;
elles ne remplacent pas une mesure exhaustive des statuts au routeur.

Un incident PostgreSQL distinct explique une autre fenêtre d'erreurs. Aucune
modification de données, de capacité ou de configuration de production n'a été
effectuée pendant l'enquête.

## Cas Hérault reproduit

L'application Scalingo `preservonsleau-api-prod` sert
`https://api.vigieau.beta.gouv.fr`. Les lectures publiques du 25 octobre à
04:09 UTC donnent la publication `2f73efe7-dc87-488b-9581-a134fbc72319`, révision
`480`, révision source `169148`, et 32 zones publiées pour le département 34.

Avant le correctif, les deux lectures suivantes renvoient HTTP 500 avec le
message « Un problème avec les données ne permet pas de répondre à votre
demande. » :

```text
GET /api/zones?lon=3.16&lat=43.6154&commune=34028&profil=particulier&zoneType=SUP
GET /api/zones/v2?lon=3.16&lat=43.6154&commune=34028&profil=particulier&zoneType=SUP
```

Le même échec a été reproduit pour `lon=3.1015`, `lat=43.7576`, commune `34019`,
type `SOU`. Ne pas répéter massivement ces appels sur la production : ils
contribuent eux-mêmes à la métrique d'alerte.

Les données cartographiques de la publication montrent les paires suivantes
au point `3.16, 43.6154`. Les tuiles PMTiles sont simplifiées : elles localisent
le chevauchement, sans constituer une comparaison géométrique exacte des
données source. Le rejeu HTTP confirme le rejet par le moteur réel.

| Type | Zone publiée | Identifiant SANDRE | Code local |
| --- | --- | --- | --- |
| SUP | 7260843 | 2110 | 76_34_0008 |
| SUP | 7260839 | 2111 | 76_34_0009 |
| SOU | 7260849 | 3480 | 76_34_0008 |
| SOU | 7260836 | 3483 | 76_34_0009 |

Les codes `0008` et `0009` désignent respectivement l'Orb amont hors axe soutenu
et l'axe Orb soutenu. Pour ces quatre zones, l'API publie
`ressourceInfluencee=false`, le niveau `vigilance` et l'arrêté `38231`.
La comparaison de `/api/zones/departement/34`, effectuée avant tout filtrage de
profil, confirme :

- SUP : mêmes 28 usages, hors identifiant technique de chaque usage ;
- SOU : mêmes 26 usages, hors identifiant technique de chaque usage ;
- dans chaque paire : même objet arrêté complet, avec ses dates et les liens
  des documents d'arrêté et d'arrêté cadre ;
- les noms, descriptions, thématiques et quatre indicateurs de profils des
  usages sont comparés sans normalisation des textes.

L'ordre des usages est ignoré pour la comparaison, leur multiplicité est
conservée. L'identifiant SANDRE n'est pas une clé unique des zones calculées :
une zone AEP dérivée peut partager l'identifiant SANDRE d'une zone SUP. La
comparaison ci-dessus utilise les identifiants des zones publiées.

## Corrélation avec les alertes

| Événement du 24 octobre | Observation préalable | Interprétation |
| --- | --- | --- |
| Alerte 17:19:48, valeur 10 | Dix recherches à 17:13, cinq communes × SUP/SOU | Même motif Hérault |
| Alerte 23:21:48, valeur 10 ; fin 23:23:01 | Dix recherches à 23:15:38, cinq communes × SUP/SOU | Même motif Hérault |
| Alerte 16:06:48, valeur 6 | Connexions PostgreSQL interrompues vers 16:01 | Incident infrastructure distinct |
| Alerte 19:24:48, valeur 12 | Dix-neuf `request.aborted` vers 19:18 | Corrélation seulement ; statuts HTTP inconnus |

Les cinq communes des deux rafales Hérault sont `34019`, `34028`, `34038`,
`34211` et `34312`. L'absence de log `RESPONSE` ne prouve pas un 500 : les
exceptions attendues 4xx, notamment les conflits communaux 409, produisent
aussi cette absence dans l'ancien intercepteur.

Les contrôles GitHub de santé publique autour de ces épisodes sont verts,
notamment les runs [21:08](https://github.com/MTES-MCT/vigieau/actions/runs/40132892574)
et [23:23](https://github.com/MTES-MCT/vigieau/actions/runs/40142537619).
Leur échantillonnage ne permet pas d'exclure les erreurs de routes métier entre
deux passages. Les incidents historiques/statistiques/SANDRE déjà ouverts ne
sont pas, à eux seuls, une explication des alertes 5xx publiques.

## Audit des références SANDRE : aucune correction de données démontrée

Le WFS utilisé par le code est
`https://services.sandre.eaufrance.fr/geo/zas`, avec une requête WFS 2.0.0
`GetFeature`, `typename=ZAS`, `SRSNAME=EPSG:4326`, `OUTPUTFORMAT=GeoJSON`, et un
filtre d'égalité sur `CdDepartement=34`. Le contrôle a été limité au département,
sans téléchargement national.

Au moment de l'audit, la connexion HTTPS stricte échoue avec
`CERTIFICATE_VERIFY_FAILED: certificate has expired`. Le certificat présenté
pour `*.sandre.eaufrance.fr` a les dates suivantes :

```text
notBefore=Apr 9 00:00:00 2026 GMT
notAfter=Oct 24 23:59:59 2026 GMT
issuer=Trust Provider B.V. TLS RSA CA G1
```

Ce défaut apparaît après les alertes applicatives du 24 octobre ; il ne doit
pas leur être attribué rétroactivement. Le point MDM
`https://mdm.sandre.eaufrance.fr/id/zonealertesechresse/2111/json` répond HTTP 503.

Une lecture informative du seul WFS départemental, réalisée en mémoire sans
validation TLS, retourne 59 références. Les quatre références `2110`, `2111`,
`3480`, `3483` y ont `RessInfluenceeZAS=0`, `StZAS=Validé`, et
`DateMajZAS=2025-04-29`. **Cette réponse n'est pas une preuve authentifiée et
n'autorise aucune correction de production.** Aucune comparaison géométrique
exacte contre une source officielle authentifiée n'a pu être terminée pour
les cinq communes. Aucun changement de géométrie ou de qualification de
ressource n'est donc proposé sur la base de cet audit.

Le [communiqué officiel SANDRE du 26 février 2025](https://www.sandre.eaufrance.fr/v2/news/mise-a-jour-des-documents-de-specification-des-zones-d-alerte-secheresse),
accessible en HTTPS valide, rappelle que ses zones décrivent les bassins
naturels. VigiEau applique ensuite les règles de gestion des arrêtés, qui
peuvent modifier les périmètres de restriction. Une différence géométrique
avec SANDRE ne démontre donc pas, à elle seule, une erreur de publication.
Le nom « axe soutenu » ne suffit pas non plus à modifier automatiquement
`ressourceInfluencee`.

Pour reprendre la vérification des données : attendre un accès authentifié,
relire les quatre références et les règles de l'arrêté cadre, puis produire
un rapport limité aux écarts démontrés avant toute republication. Le correctif
applicatif d'équivalence stricte ne requiert aucune mutation de ces données.

## Incident PostgreSQL séparé

Les archives de l'add-on PostgreSQL de `regleau-back-prod` montrent :

- 16:01:02 : arrêt du processus de réception WAL à la demande de
  l'administrateur ;
- 16:01:03 : fin de récupération, puis disponibilité de la base pour les
  connexions ;
- 16:10:50–51 : démarrage d'une instance, récupération depuis la timeline 6,
  réplication depuis un primaire en timeline 7, puis disponibilité en lecture
  seule.

Cette séquence est compatible avec une promotion du primaire, puis une
reconstruction du réplica. Elle ne démontre pas deux crashs successifs du
primaire. Les logs applicatifs de la fenêtre contiennent de nombreuses erreurs
`Connection terminated unexpectedly`, dans plusieurs composants. Le conteneur
admin `clock-1` a également redémarré après un échec inattendu à 16:07:18.

Aucun motif OOM ni opération de maintenance datée du 24 octobre n'a été trouvé
dans les éléments inspectés. La cause ayant déclenché la bascule reste
indéterminée. Ne pas modifier les calculs métier, les seuils d'alerte ou la
capacité de la base sur cette seule corrélation.

## Observation locale après livraison

`scripts/observe-scaling-5xx.mjs` réalise une observation unique en lecture seule.
Le planificateur externe doit fixer une échéance UTC au lancement du suivi de
72 heures, puis réutiliser cette même échéance à chaque passage horaire :

```sh
node scripts/observe-scaling-5xx.mjs \
  --output-dir /home/samy/.local/state/vigieau/scalingo-5xx \
  --until "$OBSERVATION_UNTIL"
```

`OBSERVATION_UNTIL` doit contenir un horodatage UTC ISO complet, par exemple
`2026-10-28T04:00:00Z` ; cette valeur est un exemple, pas une programmation.
Le script requiert Node et une CLI `scalingo` déjà authentifiée dans le `PATH`.
Il n'installe ni service ni timer et n'envoie aucune notification.

Chaque passage lit les quatre sondes publiques `live`, `ready`, `cache`,
`statistics`, puis le cas Hérault V2 épinglé sur la publication relevée par les
sondes lorsque son identifiant est disponible. Les commandes Scalingo sont
limitées à `timeline --per-page 30` et `alerts`, pour l'application fixe
`preservonsleau-api-prod`. Chaque lecture HTTP est bornée à 15 secondes et
chaque commande CLI à 20 secondes, sans dépasser l'échéance du suivi.

Sur cette fenêtre de 72 heures, le cas Hérault attend au moins une zone SUP et
une zone SOU, avec une disponibilité `available` pour chacune. Un HTTP 200 avec
des zones absentes ou indisponibles reste un état `degraded`. Un seul résultat
par type est accepté si la publication évolue ; l'état AEP peut prendre toute
valeur prévue par le contrat. Une disponibilité inconnue rend la collecte
`incomplete`, avec un état `unknown` en l'absence d'autre dégradation prouvée.

Le répertoire contient un JSON horodaté par passage, `latest.json` et
`latest.txt`. Les fichiers sont écrits par remplacement atomique, avec des
droits `0600`. Seuls les statuts, nombres, identifiants de publication/zones et
événements d'alerte normalisés sont conservés. Aucun corps de réponse brut,
ligne CLI brute, email, adresse IP, URL signée ou message d'erreur libre n'est
écrit dans les résultats.

- Code de sortie `0`, statut `complete` : collecte terminée ; consulter
  séparément `state`, qui peut être `degraded`.
- Code de sortie `1`, statut `incomplete` : au moins une lecture ou un décodage
  n'a pas abouti ; ne pas assimiler ce passage à un rétablissement.
- Code de sortie `0`, statut `expired` : aucune lecture réseau n'a lieu ; le
  planificateur externe peut arrêter le suivi.

La timeline est limitée aux 30 dernières entrées et le résultat signale une
troncature possible. Les mêmes événements peuvent apparaître dans plusieurs
observations ; leur nombre ne doit pas être additionné comme un nombre de
nouvelles alertes. Ce suivi horaire constitue un échantillonnage et ne prouve
pas l'absence de tout incident entre deux lectures.

Validation locale du collecteur :

```sh
node --test scripts/observe-scaling-5xx.test.mjs
```
