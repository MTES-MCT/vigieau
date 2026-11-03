<script setup lang="ts">
import {Ref} from 'vue';

definePageMeta({
  layout: 'basic',
});

const appName = useRuntimeConfig().public.appName;
const email = useRuntimeConfig().public.email;
const telephone = useRuntimeConfig().public.telephone;
const telephoneHref = `tel:${String(telephone).replace(/[^+\d]/g, '')}`;
useHead({
  title: `Accessibilité - ${useRuntimeConfig().public.appName}`,
});

const domainName = useRuntimeConfig().public.domainName;
const links: Ref<any[]> = ref([{'to': '/', 'text': 'Accueil'}, {'text': 'Accessibilité'}]);
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <div>
      <h1>Déclaration d’accessibilité</h1>
      <p>Mise à jour le <span>3 novembre 2026</span>.</p>
      <p>
        Le <span>Ministère de la Transition écologique, de la Biodiversité et des Négociations internationales sur le
          climat et la nature</span> s’engage à rendre son service accessible, conformément à l’article 47 de la loi
        n° 2005-102 du 11 février 2005.
      </p>
      <p>À cette fin, nous mettons en œuvre la stratégie et les actions suivantes&nbsp;:</p>
      <ul>
        <li>
          Schéma pluriannuel&nbsp;: <a
            href="https://beta.gouv.fr/accessibilite/schema-pluriannuel"
            title="https://beta.gouv.fr/accessibilite/schema-pluriannuel (nouvelle fenêtre)"
            target="_blank"
            rel="external"
          >https://beta.gouv.fr/accessibilite/schema-pluriannuel</a>.
        </li>
        <li>
          Plan d'action&nbsp;: <a
            href="https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2026"
            title="https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2026 (nouvelle fenêtre)"
            target="_blank"
            rel="external"
          >https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2026</a>.
        </li>
      </ul>
      <p>
        Cette déclaration d’accessibilité s’applique à <strong>{{ appName }}</strong><span> (<span>{{
          domainName
        }}</span>)</span>.
      </p>
      <h2>État de conformité</h2>
      <p>
        <strong>{{ appName }}</strong> est
        <strong><span data-printfilter="lowercase">partiellement conforme</span></strong> avec le <abbr
          title="Référentiel général d’amélioration de l’accessibilité"
        >RGAA</abbr>.<br>
      </p>
      <h2>Résultats des tests</h2>
      <p>
        Le contre-audit de conformité au RGAA version 4.1.2 réalisé du 16 au 23 octobre 2026 par la société <a
          href="https://www.temesis.com/"
          title="https://www.temesis.com/ (nouvelle fenêtre)"
          target="_blank"
          rel="external"
        >Temesis</a> révèle que sur l’échantillon :
      </p>
      <ul>
        <li>
          Le taux de conformité global est de 86,54&nbsp;%. Ce taux est obtenu en divisant le nombre de critères conformes par
          le nombre de critères applicables.
        </li>
        <li>
          Le taux de conformité moyen est de 90,21&nbsp;%. Ce taux est obtenu en faisant la moyenne des taux de conformité de
          chaque page.
        </li>
      </ul>
      <p>45 critères sont conformes, 7 sont non conformes et 54 sont non applicables.</p>
      <p>
        Le contre-audit porte sur les non-conformités relevées lors de l’audit initial. Certains éléments n’ont pas
        été retrouvés et n’ont donc pas pu être réévalués. Ce contrôle ne couvre pas nécessairement les évolutions
        de l’interface.
      </p>
      <h2>Contenus non accessibles</h2>
      <p>Les contenus listés ci-dessous ne sont pas accessibles pour les raisons suivantes.</p>
      <h3>Non-conformité</h3>
      <p>Les non-conformités restantes concernent les critères suivants&nbsp;:</p>
      <ul id="criteres-non-conformes">
        <li>1.1 : certaines images porteuses d’information n’ont pas d’alternative textuelle.</li>
        <li>6.1 : certains liens ne sont pas suffisamment explicites.</li>
        <li>7.1 : certains scripts ne sont pas compatibles avec les technologies d’assistance.</li>
        <li>7.5 : certains messages de statut ne sont pas restitués par les technologies d’assistance.</li>
        <li>8.9 : certaines balises sont utilisées uniquement à des fins de présentation.</li>
        <li>12.8 : l’ordre de tabulation n’est pas toujours cohérent.</li>
        <li>13.3 : certains documents bureautiques, notamment des PDF, ne disposent pas de version accessible.</li>
      </ul>
      <h3>Dérogations pour charge disproportionnée</h3>
      <p>Aucune dérogation pour charge disproportionnée.</p>
      <h3>Contenus non soumis à l’obligation d’accessibilité</h3>
      <ul>
        <li>
          Les fichiers bureautiques publiés avant le 23 septembre 2018, sauf ceux nécessaires à une démarche
          administrative relevant de l’organisme responsable.
        </li>
        <li>
          Les contenus tiers de la carte de géolocalisation qui ne sont ni financés ni développés par l’organisme
          responsable et qui ne sont pas sous son contrôle.
        </li>
      </ul>
      <h2>Établissement de cette déclaration d’accessibilité</h2>
      <p>
        Cette déclaration a été établie le 22 mai 2024. Elle a été mise à jour le 3 novembre 2026 à la suite du
        contre-audit du 23 octobre 2026.
      </p>
      <h3>Technologies utilisées pour la réalisation du site web</h3>
      <ul>
        <li>HTML</li>
        <li>CSS</li>
        <li>JavaScript</li>
      </ul>
      <h3>Environnement de test</h3>
      <p>
        Les tests ont été effectués avec les combinaisons de navigateurs web et de lecteurs d’écran suivants&nbsp;:
      </p>
      <ul>
        <li>NVDA 2026.1.1 et Firefox 158</li>
        <li>Jaws 2025 et Firefox 158</li>
        <li>VoiceOver et Safari</li>
      </ul>
      <h3>Outils utilisés lors de l’évaluation</h3>
      <ul>
        <li>WCAG contrast checker</li>
        <li>HeadingsMap</li>
        <li>Web developer</li>
        <li>Stylus</li>
        <li>PDF Accessibility Checker 2024</li>
        <li>Colour Contrast Analyser</li>
      </ul>
      <h3>Pages du site ayant fait l’objet de la vérification de conformité</h3>
      <ul id="pages-auditees">
        <li><a href="https://vigieau.gouv.fr/">Accueil</a></li>
        <li><a href="https://vigieau.gouv.fr/accessibilite">Déclaration d’accessibilité</a></li>
        <li><a href="https://vigieau.gouv.fr/mentions-legales">Mentions légales</a></li>
        <li>
          <a href="https://vigieau.gouv.fr/situation?profil=particulier&amp;typeEau=AEP&amp;adresse=12+rue+de+la+Mairie+51100+Reims">
            Situation à Reims
          </a>
        </li>
        <li>
          <a href="https://vigieau.gouv.fr/situation?profil=particulier&amp;typeEau=AEP&amp;adresse=10+Rue+des+Aspres+66240+Saint-Est%C3%A8ve">
            Situation de crise à Saint-Estève lors de l’audit
          </a>
        </li>
        <li><a href="https://vigieau.gouv.fr/donnees/">Données</a></li>
        <li><a href="https://vigieau.gouv.fr/donnees/surface/">Évolution surface</a></li>
      </ul>
      <h2 id="amelioration-contact">
        Amélioration et contact
      </h2>
      <p>
        Si vous n’arrivez pas à accéder à un contenu ou à un service, vous pouvez contacter le
        responsable de VigiEau pour être orienté vers une alternative accessible ou obtenir le
        contenu sous une autre forme.
      </p>
      <ul>
        <li>
          E-mail : <a :href="`mailto:${email}`">{{ email }}</a>
        </li>
        <li>
          Téléphone : <a :href="telephoneHref">{{ telephone }}</a>
        </li>
      </ul>
      <h2>Voie de recours</h2>
      <p>
        Cette procédure est à utiliser dans le cas suivant&nbsp;: vous avez signalé au responsable du site internet un
        défaut d’accessibilité qui vous empêche d’accéder à un contenu ou à un des services du portail et vous n’avez
        pas obtenu de réponse satisfaisante.
      </p>
      <p>Vous pouvez&nbsp;:</p>
      <ul>
        <li>
          Écrire un message au <a
            href="https://www.defenseurdesdroits.fr/nous-contacter-355"
            title="https://www.defenseurdesdroits.fr/nous-contacter-355 (nouvelle fenêtre)"
            target="_blank"
            rel="external"
          >
            Défenseur des droits</a>
        </li>
        <li>
          Contacter <a
            href="https://www.defenseurdesdroits.fr/carte-des-delegues"
            title="https://www.defenseurdesdroits.fr/carte-des-delegues (nouvelle fenêtre)"
            target="_blank"
            rel="external"
          >
            le délégué du Défenseur des droits dans votre région
          </a>
        </li>
        <li>
          Envoyer un courrier par la poste (gratuit, ne pas mettre de timbre)&nbsp;:<br>
          Défenseur des droits<br>
          Libre réponse 71120 75342 Paris CEDEX 07
        </li>
      </ul>
      <hr>
      <p>
        Cette déclaration d’accessibilité a été créée le <span>10 mai 2023</span> grâce au <a
          href="https://betagouv.github.io/a11y-generateur-declaration/"
          title="https://betagouv.github.io/a11y-generateur-declaration/ (nouvelle fenêtre)"
          target="_blank"
          rel="external"
        >
          Générateur de Déclaration d’Accessibilité de BetaGouv
        </a>.
      </p>
    </div>
  </div>
</template>
