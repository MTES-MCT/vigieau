# Accès à la préproduction publique

Le front et l’API utilisent une authentification **HTTP Basic standard**, avec un identifiant et un mot de passe communs. Le navigateur affiche sa boîte de connexion habituelle. Il n’y a ni passerelle dédiée, ni formulaire applicatif, ni cookie de session d’authentification.

- `preservonsleau-front-preprod` : `auth_basic` Nginx, sur `https://vigieau.incubateur.net`.
- `vigieau-api-preprod` : middleware `express-basic-auth`, sur `https://api.vigieau.incubateur.net`, y compris Swagger et domaines Scalingo.
- `regleau-front-preprod` : seuls les appels `/api-vigieau/` utilisent le même Basic ; l’administration garde sa connexion habituelle.

La production est exclue par les gardes sur le nom d’application Scalingo. HTTPS est forcé sur les deux applications publiques.

## Variables Scalingo

Pour les deux applications publiques : `VIGIEAU_PREPROD_AUTH_ENABLED=true`.

Pour l’API : `VIGIEAU_PREPROD_AUTH_USERNAME` et `VIGIEAU_PREPROD_AUTH_PASSWORD` sont des variables privées. Pour les fronts public et admin : `VIGIEAU_PREPROD_HTPASSWD` contient la ligne `identifiant:hash`, produite avec `openssl passwd -6`. Nginx écrit ce fichier hors des fichiers publics au démarrage. Le front admin utilise aussi `VIGIEAU_PREPROD_PUBLIC_API_BRIDGE=true`.

Ne pas publier les identifiants dans Git. Pour les changer, remplacer les valeurs sur les trois applications et redémarrer ; une modification des flags Nuxt nécessite un nouveau build.

## Limites acceptées en préproduction

Basic et les JWT métier utilisent tous deux `Authorization` : la gestion des abonnements nécessitant un Bearer n’est pas utilisable derrière cette protection. Cette limite est acceptée pour la recette ; aucun contournement des contrôles n’est ajouté.

Les quotas habituels restent inchangés. La PWA est désactivée sur le front protégé et son ancien cache est retiré à la prochaine activation du service worker. Seuls le fichier de transition `/sw.js` et `GET /api/health/live` restent accessibles sans identifiants. Les fichiers S3 externes sont hors périmètre.

Pour revenir au comportement public, désactiver les flags concernés et redéployer les fronts. Cela rouvre la préproduction.
