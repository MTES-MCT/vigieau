<script setup lang="ts">
import {Ref} from 'vue';

definePageMeta({
  layout: 'basic',
});

const appName = useRuntimeConfig().public.appName;
const email = useRuntimeConfig().public.email;
const telephone = useRuntimeConfig().public.telephone;
useHead({
  title: `Accessibilité - ${useRuntimeConfig().public.appName}`,
});

const domainName = useRuntimeConfig().public.domainName;
const links: Ref<any[]> = ref([{'to': '/', 'text': 'Accueil'}, {'text': 'Accessibilité'}]);
</script>

<template>
  <div class="fr-container">
    <DsfrBreadcrumb :links='links'/>
    <div>
      <h1>Déclaration d’accessibilité</h1>
      <p>Établie le <span>22 mai 2024</span>.</p>
      <p>Le <span>Ministère de la Transition écologique et de la Cohésion des territoires</span> s’engage à rendre son
        service accessible, conformément à l’article 47 de la loi n° 2005-102 du 11 février 2005.</p>
      <p>À cette fin, nous mettons en œuvre la stratégie et les actions suivantes&nbsp;:
        <ul>
          <li>Schéma pluriannuel&nbsp;: <a href="https://beta.gouv.fr/accessibilite/schema-pluriannuel"
                                           title="https://beta.gouv.fr/accessibilite/schema-pluriannuel (nouvelle fenêtre)"
                                           target="_blank"
                                           rel="external">https://beta.gouv.fr/accessibilite/schema-pluriannuel</a>.
          </li>
          <li>Plan d'action&nbsp;: <a href="https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2024"
                                      title="https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2024 (nouvelle fenêtre)"
                                      target="_blank"
                                      rel="external">https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2024</a>.
          </li>
        </ul>
      </p>
      <p>Cette déclaration d’accessibilité s’applique à <strong>{{ appName }}</strong><span> (<span>{{
          domainName
        }}</span>)</span>.</p>
      <h2>État de conformité</h2>
      <p>
        <strong>{{ appName }}</strong> est
        <strong><span data-printfilter="lowercase">partiellement conforme</span></strong> avec le <abbr
          title="Référentiel général d’amélioration de l’accessibilité">RGAA</abbr>.<br/>
      </p>
      <h2>Résultats des tests</h2>
      <p>
        L’audit de conformité au RGAA version 4.1.2 réalisé en janvier 2025 par la société <a
          href="https://www.temesis.com/"
          title="https://www.temesis.com/ (nouvelle fenêtre)"
          target="_blank"
          rel="external">Temesis</a> révèle que sur l’échantillon :
      </p>
      <ul>
        <li>
          Le taux de conformité global est de 65,38%. Ce taux est obtenu en divisant le nombre de critères conformes par
          le nombre de critères applicables.
        </li>
        <li>
          Le taux de conformité moyen est de 80,12%. Ce taux est obtenu en faisant la moyenne des taux de conformité de
          chaque page.
        </li>
      </ul>
      <h2>Contenus non accessibles</h2>
      <h3>Non-conformité</h3>
      <p>Parmis les points bloquants</p>
      <ul>
        <li>Présence des documents PDF non conforme aux normes d'accessibilité</li>
        <li>La valeur de l’option en cours de sélection n’est pas exposée aux aides techniques</li>
      </ul>
      <p>Parmis les points majeurs</p>
      <ul>
        <li>Lien d'accès rapide est présent, mais n'est pas visible à la prise de focus clavier</li>
        <li>Présence d’un contenu visible porteur d’information généré avec CSS</li>
        <li>Le focus n’est pas capturé au sein de la modale</li>
        <li>Absence de rôle sur l'élément</li>
        <li>Absence d’indication de champ obligatoire</li>
        <li>La mise à jour du nombre de suggestions n’est pas exposée aux aides techniques</li>
      </ul>
      <p>Parmis les points mineurs</p>
      <ul>
        <li>Présence de contenu qui n'est pas signalé par un élément sémantique</li>
        <li>Présence de paragraphes vides &lt;p&gt;&lt;/p&gt;</li>
        <li>Présence d’une image décorative non ignorée par les aides techniques</li>
      </ul>
      <h3>Contenus non soumis à l’obligation d’accessibilité</h3>
      <ul>
        <li>Carte géolocalisation</li>
      </ul>
      <h2>Amélioration et contact</h2>
      <p>
        Si vous n’arrivez pas à accéder à un contenu ou à un service, vous pouvez contacter le
        responsable de Potentiel pour être orienté vers une alternative accessible ou obtenir le
        contenu sous une autre forme.
      </p>
      <ul>
        <li>E-mail : {{ email }}</li>
        <li>Téléphone : {{ telephone }}</li>
      </ul>
      <h2>Voie de recours</h2>
      <p>Cette procédure est à utiliser dans le cas suivant&nbsp;: vous avez signalé au responsable du site internet un
        défaut d’accessibilité qui vous empêche d’accéder à un contenu ou à un des services du portail et vous n’avez
        pas obtenu de réponse satisfaisante.</p>
      <p>Vous pouvez&nbsp;:</p>
      <ul>
        <li>Écrire un message au <a href="https://formulaire.defenseurdesdroits.fr/"
                                    title="https://formulaire.defenseurdesdroits.fr/ (nouvelle fenêtre)"
                                    target="_blank"
                                    rel="external">
          Défenseur des droits</a>
        </li>
        <li>Contacter <a href="https://www.defenseurdesdroits.fr/saisir/delegues"
                         title="https://www.defenseurdesdroits.fr/saisir/delegues (nouvelle fenêtre)"
                         target="_blank"
                         rel="external">
          le délégué du Défenseur des droits dans votre région
        </a>
        </li>
        <li>Envoyer un courrier par la poste (gratuit, ne pas mettre de timbre)&nbsp;:<br>
          Défenseur des droits<br>
          Libre réponse 71120 75342 Paris CEDEX 07
        </li>
      </ul>
      <hr>
      <p>
        Cette déclaration d’accessibilité a été créé le <span>10 mai 2023</span> grâce au <a
          href="https://betagouv.github.io/a11y-generateur-declaration/"
          title="https://betagouv.github.io/a11y-generateur-declaration/ (nouvelle fenêtre)"
          target="_blank"
          rel="external">
        Générateur de Déclaration d’Accessibilité de BetaGouv
      </a>.
      </p>
    </div>
  </div>
</template>