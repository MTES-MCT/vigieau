# Protection de la préproduction publique

Un identifiant et un mot de passe communs protègent le front public et l’API publique de préproduction. La connexion est locale, sans ProConnect, fournisseur OAuth, add-on ni base de comptes supplémentaire.

## Applications concernées

| Application Scalingo (`osc-fr1`) | Adresse | Protection |
| --- | --- | --- |
| `preservonsleau-front-preprod` | `https://vigieau.incubateur.net` | Connexion et session obligatoires |
| `vigieau-api-preprod` | `https://api.vigieau.incubateur.net` | Même session, y compris accès direct et Swagger |
| `regleau-front-preprod` | `https://admin.vigieau.incubateur.net` | Relais `/api-vigieau/` pour ses appels à l’API publique |

La production et le backend d’administration sont exclus. Les flags sont désactivés par défaut et refusés sur toute autre application. L’administration conserve sa connexion habituelle ; seule sa vérification auprès de l’API publique peut demander la connexion à la préproduction publique.

## Connexion et fonctionnement

Ouvrir `https://vigieau.incubateur.net` et saisir les accès communs. La session vaut huit heures sur le front, l’API et le relais admin. Les mots de passe ne sont ni publiés dans le dépôt, ni inclus dans les assets du navigateur.

Le programme Node `scripts/preprod-auth/gateway.mjs` écoute sur le port public Scalingo. Il valide la session avant de transmettre au serveur applicatif sur `127.0.0.1:8080`. Le mot de passe est vérifié avec scrypt ; la session est signée avec HMAC-SHA256 et liée à la version des identifiants. Le lanceur supervise les deux processus et arrête l’ensemble si l’un échoue. `statcache` garde son démarrage habituel.

Le formulaire `/_preprod/login` impose un jeton CSRF et une origine autorisée. Les essais de connexion sont limités par IP (10 par 15 minutes, par instance), avec taille de corps et mémoire bornées. Le cookie `__Secure-vigieau_preprod_auth` est Secure, HttpOnly, SameSite=Lax, limité à huit heures. HTTPS doit être forcé sur les deux applications publiques.

Une session séparée du header `Authorization` permet de conserver les JWT métier. Un JWT seul ne donne pas accès à la préproduction. Les quotas d’abonnement gardent une clé liée à l’IP initiale de connexion, transmise dans le cookie signé, pour ne pas regrouper tous les testeurs derrière le relais Nginx. Le compte commun ne permet pas d’identifier individuellement les personnes qui l’utilisent.

Les alias Scalingo renvoient vers le domaine canonique protégé. Exceptions anonymes strictes : `GET /sw.js` sur le front pour retirer l’ancienne PWA et `GET /api/health/live` sur l’API. Les autres routes exigent une session. Une requête API non authentifiée reçoit `401 {"error":"preprod_auth_required"}` ; une navigation HTML est dirigée vers la connexion.

Le front utilise `/api/` ; l’administration `/api-vigieau/`. Les relais vérifient le certificat TLS de l’API et conservent cookie et JWT. L’administration conserve la saisie et bloque l’enregistrement si sa vérification échoue.

Les réponses protégées ne sont pas mises en cache. La PWA est désactivée dans ce profil ; le worker de transition retire les caches Workbox de son scope à sa prochaine activation. Des données précédemment téléchargées peuvent subsister sur un appareil hors ligne. Les objets S3 (PMTiles et manifestes) restent hors de ce périmètre.

## Configuration

Les deux applications publiques utilisent les mêmes valeurs privées :

```dotenv
VIGIEAU_PREPROD_AUTH_ENABLED=true
VIGIEAU_PREPROD_AUTH_USERNAME=<identifiant commun>
VIGIEAU_PREPROD_AUTH_PASSWORD_HASH='<hash scrypt>'
VIGIEAU_PREPROD_AUTH_SESSION_SECRET=<32 octets aléatoires en base64url>
```

Le hash a le format `scrypt$16384$8$1$<sel de 16 octets en base64url>$<empreinte de 64 octets en base64url>`. Les guillemets simples dans un fichier dotenv préservent les signes `$`.

Le front admin utilise uniquement `VIGIEAU_PREPROD_PUBLIC_API_BRIDGE=true`. Il ne reçoit ni mot de passe, ni hash, ni secret de session. `APP` est fourni par Scalingo.

L’installation via `scalingo-postbuild` copie uniquement les scripts Node nécessaires ; elle ne télécharge aucun proxy et n’ajoute aucune dépendance npm. Les flags publics et admin modifient le build Nuxt : leur activation ou désactivation impose un redéploiement. Le lanceur public refuse un décalage entre le mode du build et celui du runtime.

## Rotation et révocation

Générer les nouveaux fichiers privés dans un répertoire choisi :

```sh
node scripts/preprod-auth/create-access.mjs /chemin/prive/nouvel-acces
```

Le script écrit `credentials.json` pour la transmission du login/mot de passe et `public.env` pour Scalingo, avec permissions privées, sans afficher les secrets. Il refuse d’écraser un fichier existant.

Importer le même `public.env` dans les deux applications publiques avec `scalingo --region osc-fr1 --app <application> env-set --file <fichier>`. Vérifier les valeurs après import sans les afficher. La modification des identifiants ou de la clé de session invalide les cookies précédents après redémarrage des instances. Aucun rebuild n’est nécessaire si le flag reste actif. Transmettre le nouveau mot de passe à l’équipe par un canal approprié.

Pour se déconnecter dans un navigateur, supprimer le cookie de préproduction ; le endpoint POST `/_preprod/logout` permet aussi de l’effacer depuis une page de même origine. Une déconnexion locale n’invalide pas les autres navigateurs : la rotation des identifiants ou de la clé révoque l’ensemble des sessions.

## Déploiement et retour arrière

Conserver au préalable les références des déploiements et les anciennes valeurs d’environnement en privé. Charger les configurations puis déployer le même commit sur les trois applications préprod. La modification d’environnement peut redémarrer les anciens conteneurs avant la fin du nouveau build ; prévoir une courte fenêtre de recette.

Après déploiement, vérifier : accès anonyme refusé sur les domaines canoniques et Scalingo, mauvais mot de passe refusé, connexion commune fonctionnelle, API et relais accessibles avec le cookie, JWT seul insuffisant, HTTPS forcé et santé API disponible. La recette ne doit envoyer aucun email ni modifier de données métier réelles.

Pour revenir au comportement public précédent, désactiver les deux flags publics et le flag du relais admin, puis redéployer un build produit avec les flags désactivés. Un rollback d’image seul ne restaure pas les anciennes variables. Ce retour arrière rouvre la préproduction.

## Validation locale

```sh
npm run test:preprod-auth
RUN_NGINX_INTEGRATION_TESTS=true node --test scripts/preprod-auth/nginx.test.mjs
npm --prefix apps/backend test -- --runInBand
npm --prefix apps/frontend run test:unit
npm --prefix apps/frontend-admin run test:unit
```

Les tests de la passerelle utilisent des identifiants synthétiques et des serveurs locaux. Les tests Nginx vérifient le rendu ERB, la transmission des requêtes et le refus des certificats TLS invalides. Aucun test local ne nécessite d’identifiant ProConnect ni n’envoie de message réel.
