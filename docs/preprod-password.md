# Accès à la préproduction publique

Le front et l’API utilisent une authentification **HTTP Basic standard**, avec un identifiant et un mot de passe communs. Le navigateur affiche sa boîte de connexion habituelle. Il n’y a ni passerelle dédiée, ni formulaire applicatif, ni cookie de session d’authentification.

- `preservonsleau-front-preprod` : `auth_basic` Nginx, sur `https://vigieau.beta.ecologie.gouv.fr`.
- `vigieau-api-preprod` : middleware `express-basic-auth`, sur `https://api.vigieau.beta.ecologie.gouv.fr`, y compris Swagger et domaines Scalingo.
- `regleau-front-preprod` : administration sur `https://admin.vigieau.beta.ecologie.gouv.fr`. Seuls les appels `/api-vigieau/` utilisent le même Basic ; l’administration garde sa connexion habituelle.
- `regleau-back-preprod` : API de l’administration sur `https://api.admin.vigieau.beta.ecologie.gouv.fr`, avec son authentification habituelle.

La production est exclue par les gardes sur le nom d’application Scalingo. HTTPS est forcé sur les deux applications publiques.

Les anciens domaines de préproduction en `incubateur.net` ont été retirés des applications Scalingo le **10 novembre 2026**. Ils ne doivent plus servir les applications ni être utilisés comme destinations de redirection.

La connexion ProConnect de l’administration reste temporairement indisponible : ProConnect refuse encore le nouveau callback avec `invalid_redirect_uri`. Cette indisponibilité a été acceptée pour retirer les anciens domaines sans attendre l’enregistrement des nouvelles URL. Elle ne justifie pas de réactiver les anciennes adresses ou de contourner l’authentification.

La configuration de l’administration utilise désormais :

- Backend : `DOMAIN=vigieau.beta.ecologie.gouv.fr` pour le cookie de session.
- Backend : `WEBSITE_URL=https://admin.vigieau.beta.ecologie.gouv.fr/` pour les retours après connexion et déconnexion.
- Backend : `OAUTH2_CLIENT_REGISTRATION_LOGIN_REDIRECT_URI=https://api.admin.vigieau.beta.ecologie.gouv.fr/api/auth/callback`.
- Front : `API_URL=https://api.admin.vigieau.beta.ecologie.gouv.fr/api` pour l’API et le démarrage de la connexion. Toute modification de cette valeur exige une reconstruction du front admin.

Pour rétablir la connexion, enregistrer le callback `https://api.admin.vigieau.beta.ecologie.gouv.fr/api/auth/callback` et le retour de déconnexion `https://admin.vigieau.beta.ecologie.gouv.fr/` dans le client d’intégration existant, depuis l’[Espace Partenaires ProConnect](https://partenaires.proconnect.gouv.fr/apps), puis vérifier les parcours de connexion et de déconnexion. `DOMAIN_NAME` du front admin désigne la carte publique et vaut `vigieau.beta.ecologie.gouv.fr` ; celui du backend admin désigne le site admin.

Le retrait des domaines conserve les protections HTTP Basic décrites ci-dessus et l’analyse ClamAV des pièces jointes déjà active dans l’administration. Aucun mécanisme d’authentification ni contrôle antivirus n’est désactivé.

## Variables Scalingo

Pour les deux applications publiques : `VIGIEAU_PREPROD_AUTH_ENABLED=true`.

Pour l’API : `VIGIEAU_PREPROD_AUTH_USERNAME` et `VIGIEAU_PREPROD_AUTH_PASSWORD` sont des variables privées. Pour les fronts public et admin : `VIGIEAU_PREPROD_HTPASSWD` contient la ligne `identifiant:hash`, produite avec `openssl passwd -6`. Nginx écrit ce fichier hors des fichiers publics au démarrage. Le front admin utilise aussi `VIGIEAU_PREPROD_PUBLIC_API_BRIDGE=true`.

Ne pas publier les identifiants dans Git. Pour les changer, remplacer les valeurs sur les trois applications et redémarrer ; une modification des flags Nuxt nécessite un nouveau build.

## Limites acceptées en préproduction

Basic et les JWT métier utilisent tous deux `Authorization` : la gestion des abonnements nécessitant un Bearer n’est pas utilisable derrière cette protection. Cette limite est acceptée pour la recette ; aucun contournement des contrôles n’est ajouté.

Les quotas habituels restent inchangés. La PWA est désactivée sur le front protégé et son ancien cache est retiré à la prochaine activation du service worker. Seuls le fichier de transition `/sw.js` et `GET /api/health/live` restent accessibles sans identifiants. Les fichiers S3 externes sont hors périmètre.

Pour revenir au comportement public, désactiver les flags concernés et redéployer les fronts. Cela rouvre la préproduction.
