# Abonnements et liens des mails

## Parcours de gestion

`/abonnements` affiche les abonnements avec un jeton valide. Sans jeton, ou avec
un jeton expiré ou invalide, la page propose de recevoir un nouveau lien. Une
panne API affiche une erreur et un bouton de réessai. Après suppression du
dernier abonnement, la confirmation et l'état vide restent visibles.

Les anciens liens restent compatibles et expirent toujours après sept jours.
Un jeton doit contenir un email valide ; ni un paramètre de requête ni le corps
d'une requête ne peuvent changer l'email utilisé pour lire ou supprimer les
abonnements.

| Requête API | Comportement |
| --- | --- |
| `POST /api/subscriptions` | Crée ou met à jour l'abonnement puis envoie la confirmation, y compris lors d'un réessai. |
| `GET /api/subscriptions` | Retourne les abonnements de l'email signé. |
| `DELETE /api/subscriptions/:id` | Supprime cet identifiant pour l'email signé ; refuse les identifiants hors de `1..2147483647`. |
| `DELETE /api/subscriptions` | Supprime tous les abonnements de l'email signé. L'alias `/all` reste accepté pour les anciens clients. |
| `POST /api/subscriptions/management-link` | Accepte `{ "email": "…" }` et renvoie `202` avec un message générique, que l'email existe ou non. Envoie un lien seulement pour un email déjà abonné. |

L'identité d'un abonnement inclut toujours l'email. Une adresse est identifiée
par son `idAdresse`, un point par ses coordonnées sans `idAdresse`, et une
commune seule par son code avec adresse et coordonnées nulles. Les coordonnées
égales à zéro sont conservées. Les emails gardent leur casse historique ; cette
correction ne migre ni ne fusionne les données existantes.

Si la confirmation échoue après l'enregistrement, l'API renvoie
`503 SUBSCRIPTION_CONFIRMATION_UNAVAILABLE`. L'abonnement reste enregistré ;
réessayer le même formulaire renvoie la confirmation. Une panne de récupération
renvoie `503 SUBSCRIPTION_MANAGEMENT_LINK_UNAVAILABLE` et permet un nouvel essai.
Aucun réessai automatique des mutations n'est effectué par le frontend.

## Envoi et protection contre les demandes répétées

La récupération utilise `BREVO_API_KEY`, `JWT_SECRET` et `WEBSITE_URL` existants,
avec l'expéditeur et le `replyTo` du modèle Brevo 29. Son contenu dédié explique
la validité du lien et l'absence de changement des abonnements. Elle ne crée pas
de contact et ne modifie pas les modèles Brevo.

La création est limitée à dix requêtes par quinze minutes et la récupération
à trois. Sur Scalingo, le tracker utilise `X-Real-IP` uniquement lorsque
`SCALINGO_APPLICATION_ID` est présent ; en dehors de cette plateforme il utilise
l'IP de la connexion. Voir les [en-têtes du routeur Scalingo](https://doc.scalingo.com/platform/networking/public/routing#headers).

Les récupérations simultanées d'un même email partagent le résultat de l'envoi.
Après réussite, un délai de soixante secondes empêche un nouvel envoi. Ces
protections sont en mémoire, par processus ; elles ne constituent pas une limite
globale entre plusieurs conteneurs. La création ne dispose toujours pas d'une
contrainte d'unicité en base : deux créations simultanées peuvent produire des
doublons. Aucune migration de base n'est incluse.

## Liens des notifications

Le lien de situation encode les paramètres avec `URLSearchParams`, pour
préserver notamment les caractères `&`, `+` et `#` des adresses. Un abonnement
à un point ou à une adresse précise transmet aussi ses coordonnées : le
frontend ouvre cette position sans rechercher le libellé auprès du géocodeur.
Les anciens liens contenant seulement `adresse` restent pris en charge.

Les boutons « J'ajoute une nouvelle adresse » des modèles Brevo doivent pointer
vers `https://vigieau.gouv.fr/abonnements/nouveau` : modèle 29 déjà correct,
modèle 32 avec un bouton standard et un bouton Outlook, modèle 65 avec un bouton.
Ces contenus distants ne sont pas modifiés par le déploiement de ce code.

Le 3 novembre 2026, les trois liens des modèles actifs 32 et 65 ont été corrigés
par l'API, après sauvegarde et contrôle du contenu précédent. La relecture
confirme les URL attendues, les métadonnées inchangées et l'absence d'autre
modification du HTML, hormis un saut de ligne final supprimé par Brevo. Le
modèle 29 et les liens `{{params.unsubscribeUrl}}` sont restés inchangés.

| Modèle | SHA-256 du HTML relu après correction |
| --- | --- |
| 32 | `f207178c3f5e53417b407f19f4e92bbd88740158e88b4f32b78fafd5f643d1ae` |
| 65 | `3a95430846bb08c07ccb3fac6e90565a3b6a39347160af12970a33f64b69ebfa` |

Une mise à jour de `htmlContent` par l'API fait perdre l'accès à l'éditeur Drag & Drop selon la
[documentation Brevo](https://developers.brevo.com/reference/update-smtp-template).
Les modèles 32 et 65 sont donc maintenus en HTML. Sauvegarder le contenu avant
toute nouvelle modification et préserver les liens de gestion personnels.

## Vérification

Les tests backend couvrent le routage HTTP réel, la vérification des JWT,
l'identité des localisations, les erreurs d'envoi et les demandes concurrentes.
Les tests frontend et Cypress couvrent notamment la récupération, les erreurs,
les confirmations visibles et la conservation du formulaire.

```sh
npm --prefix apps/backend test -- --runInBand
npm --prefix apps/backend run build
npm --prefix apps/frontend run test:unit
npm --prefix apps/frontend run build
```

Les scénarios Cypress de `subscriptions.cy.js` et `rgaa-public-forms.cy.js`
simulent les réponses d'abonnement : ils ne doivent pas envoyer de mails réels
ni modifier des abonnements de production.
