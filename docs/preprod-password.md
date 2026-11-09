# Accès à la préproduction publique

Le front et l’API utilisent une authentification **HTTP Basic standard**, avec un identifiant et un mot de passe communs. Le navigateur affiche sa boîte de connexion habituelle. Il n’y a ni passerelle dédiée, ni formulaire applicatif, ni cookie de session d’authentification.

- `preservonsleau-front-preprod` : `auth_basic` Nginx, sur `https://vigieau.beta.ecologie.gouv.fr`.
- `vigieau-api-preprod` : middleware `express-basic-auth`, sur `https://api.vigieau.beta.ecologie.gouv.fr`, y compris Swagger et domaines Scalingo.
- `regleau-front-preprod` : administration sur `https://admin.vigieau.beta.ecologie.gouv.fr`. Seuls les appels `/api-vigieau/` utilisent le même Basic ; l’administration garde sa connexion habituelle.
- `regleau-back-preprod` : API de l’administration sur `https://api.admin.vigieau.beta.ecologie.gouv.fr`, avec son authentification habituelle.

La production est exclue par les gardes sur le nom d’application Scalingo. HTTPS est forcé sur les deux applications publiques.

Les anciens domaines `incubateur.net` restent disponibles pendant la transition. ProConnect ne reconnaît pas encore le nouveau callback admin : la connexion utilise donc toujours `https://api.admin.vigieau.incubateur.net/api/auth/callback` et revient sur `https://admin.vigieau.incubateur.net/`. Les variables de session (`DOMAIN`), de retour (`WEBSITE_URL`) et de callback du backend admin, ainsi que `API_URL` du front admin, restent sur ces anciens domaines jusqu’à l’enregistrement des nouvelles URL dans l’Espace Partenaires ProConnect.

Pour terminer cette bascule, ajouter le callback `https://api.admin.vigieau.beta.ecologie.gouv.fr/api/auth/callback` et le retour de déconnexion `https://admin.vigieau.beta.ecologie.gouv.fr/` au client ProConnect existant, puis adapter ensemble ces quatre variables et reconstruire le front admin. `DOMAIN_NAME` du front admin désigne la carte publique et vaut `vigieau.beta.ecologie.gouv.fr` ; celui du backend admin désigne le site admin.

## Variables Scalingo

Pour les deux applications publiques : `VIGIEAU_PREPROD_AUTH_ENABLED=true`.

Pour l’API : `VIGIEAU_PREPROD_AUTH_USERNAME` et `VIGIEAU_PREPROD_AUTH_PASSWORD` sont des variables privées. Pour les fronts public et admin : `VIGIEAU_PREPROD_HTPASSWD` contient la ligne `identifiant:hash`, produite avec `openssl passwd -6`. Nginx écrit ce fichier hors des fichiers publics au démarrage. Le front admin utilise aussi `VIGIEAU_PREPROD_PUBLIC_API_BRIDGE=true`.

Ne pas publier les identifiants dans Git. Pour les changer, remplacer les valeurs sur les trois applications et redémarrer ; une modification des flags Nuxt nécessite un nouveau build.

## Limites acceptées en préproduction

Basic et les JWT métier utilisent tous deux `Authorization` : la gestion des abonnements nécessitant un Bearer n’est pas utilisable derrière cette protection. Cette limite est acceptée pour la recette ; aucun contournement des contrôles n’est ajouté.

Les quotas habituels restent inchangés. La PWA est désactivée sur le front protégé et son ancien cache est retiré à la prochaine activation du service worker. Seuls le fichier de transition `/sw.js` et `GET /api/health/live` restent accessibles sans identifiants. Les fichiers S3 externes sont hors périmètre.

Pour revenir au comportement public, désactiver les flags concernés et redéployer les fronts. Cela rouvre la préproduction.
