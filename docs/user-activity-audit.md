# Journal des actions de l’administration

Le journal répond à « qui a fait quoi, quand, sur quelle ressource et avec quel
résultat ». Il est consultable dans **Journal d’activité**, uniquement par les
comptes MTE. Le rôle est relu en base pour chaque consultation ; un ancien cookie
MTE ne conserve pas ce droit après révocation. La consultation du journal est
elle-même tracée. Aucune nouvelle infrastructure n’est nécessaire.

## Périmètre

Le catalogue explicite `src/audit/audit-catalog.ts` couvre les modifications
de l’administration, les connexions/déconnexions, les consultations métier,
les recherches et exports utilisateurs, les accès aux pièces jointes, ainsi que
les commandes de publication et de restauration. Un test confronte le catalogue
aux contrôleurs : une nouvelle route de mutation nécessite une décision explicite.
Les pages publiques, ressources statiques et sondes de santé ne sont pas des
actions d’utilisateurs connectés et ne sont pas journalisées.

Chaque opération possède un UUID, un auteur identifié par un UUID stable, son
identité et son rôle au moment de l’action, une date UTC, un type d’action,
une route normalisée, un résultat et les ressources concernées. L’adresse réseau
enregistrée est celle du pair de la socket API : derrière Scalingo, elle ne prouve
pas l’adresse réelle du navigateur. Les en-têtes de transfert ne sont pas crus
aveuglément. Les paramètres conservés sont limités à une liste autorisée.

Les différences avant/après portent sur une liste explicite de tables et champs
métier, définie dans la migration. Les tables de liaison et suppressions en
cascade sont incluses. Les coordonnées personnelles des contacts d’arrêtés
municipaux sont masquées : le changement reste visible sans recopier la valeur.
Les mots de passe, sessions, jetons ProConnect, cookies, corps HTTP bruts, contenus
des documents et des courriels ne sont jamais copiés dans le journal. Un document
peut être identifié par son nom, sa taille, son type et son empreinte SHA-256.

Les liens PDF de l’administration passent par un contrôle des droits avant
redirection vers le fichier. Cela prouve une demande d’accès autorisée, pas la
lecture intégrale du PDF ; un accès direct à une URL publique déjà connue reste
hors de ce journal. L’export CSV est généré côté API pour tracer l’export et
respecter le périmètre de l’utilisateur.

## Garanties et résultats

Une intention durable précède chaque mutation HTTP. Le contexte serveur est
transmis à la connexion PostgreSQL réelle, uniquement dans sa transaction. Les
triggers écrivent les changements dans la même transaction que les données
métier : un échec de journalisation annule cette transaction, y compris pour du
SQL brut. L’isolation entre requêtes et la réutilisation des connexions sont
testées contre PostgreSQL. Une opération HTTP peut comporter plusieurs
transactions : le journal permet de distinguer un échec sans modification d’une
exécution partielle, mais ne transforme pas toute l’opération en transaction unique.

Les états distinguent démarrage, modification appliquée, réussite, refus, échec,
acceptation d’un traitement différé et résultat non confirmé. Une réponse HTTP
réussie ne prouve pas à elle seule la livraison d’un courriel ; l’acceptation SMTP
est enregistrée séparément. Les écritures S3 et PostgreSQL ne forment pas une
transaction distribuée : l’intention et les étapes connues sont conservées,
sans prétendre connaître le résultat après une interruption indéterminée.

Les lectures restent disponibles si leur trace échoue. L’échec est signalé dans
les logs, Sentry et la sonde d’audit. Les écritures exigent l’enregistrement de
l’intention ; les erreurs de fin de réponse n’effacent jamais les modifications
déjà confirmées par les triggers.

Les recalculs courants et restaurations historiques ont un auteur système et
des liens de causalité vers les demandes initiales (révision départementale ou
identifiant de restauration). Plusieurs demandes fusionnées restent identifiables.
Un traitement automatisé n’est pas attribué artificiellement au dernier humain.
Les scripts ou accès SQL externes sans contexte d’audit ne sont pas couverts.

## Conservation et exploitation

La conservation choisie est de **deux ans**, pour les besoins d’investigation et
de comparaison entre saisons. Il s’agit d’un choix de service à documenter dans
le registre de traitement, pas d’une durée légale universelle. La page de
protection des données de l’administration en informe les utilisateurs.

Le processus `clock` purge quotidiennement à 03:15 Europe/Paris, par lots bornés.
Une opération entière est purgée deux ans après sa dernière trace, avec ses
ressources et liens ; les écritures concurrentes sont protégées. Les traces sont
protégées contre UPDATE, TRUNCATE et suppression prématurée par des triggers.
Cela ne constitue pas un stockage inviolable face à un administrateur PostgreSQL.
Les sauvegardes suivent leur propre cycle de rétention.

`GET /api/health/audit` expose uniquement des indicateurs techniques : activation,
dernière trace, dernière purge, erreurs récentes et opérations non confirmées.
Le suivi de production contrôle cette sonde toutes les quinze minutes avec les
autres contrôles existants. Une purge est elle-même tracée. Surveiller également
la croissance des trois tables et de leurs index dans PostgreSQL.

## Livraison et vérification

1. Déployer la migration, le backend et le frontend d’administration en
   préproduction, en conservant les protections HTTP et domaines existants.
2. Activer `AUDIT_ENABLED=true` dans le backend d’administration et redémarrer
   tous ses processus, notamment `web`, `clock` et les workers.
3. Vérifier la sonde, les droits MTE, une consultation, un export et le cycle
   création/modification/suppression d’un utilisateur de validation dédié.
4. Après validation, livrer la même fonctionnalité en production, puis contrôler
   la migration, les processus, les sondes et les traces produites.

Les événements antérieurs à l’activation ne sont pas reconstruits. Une désactivation
d’urgence par `AUDIT_ENABLED=false` conserve les données existantes mais crée une
lacune explicite de traçabilité et rend la sonde non conforme ; elle ne doit pas
être présentée comme un fonctionnement normal. Un retour au code précédent
conserve les tables et la migration, sans supprimer l’historique.

Les tests PostgreSQL dédiés utilisent `USER_ACTIVITY_AUDIT_POSTGRES_URL` sur une
base isolée. Ils couvrent les transactions, la concurrence, les cascades, la
minimisation, l’immutabilité des identités, les droits, les curseurs et la purge.
La CI vérifie également une base neuve et la migration depuis la version précédente.
