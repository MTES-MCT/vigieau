<script setup lang="ts">
definePageMeta({
  layout: 'basic',
});

const runTimeConfig = useRuntimeConfig().public;
const api = useApi();
const userSelected = ref(null);
const userList = ref([]);
const route = useRoute();
const isError = !!route.query.error;
const { data, error } = await api.user.listDev();
if (data.value) {
  userList.value = data.value.map((user: any) => {
    return {
      text: `${user.email} - ${user.role} - ${user.roleDepartements?.join(', ')}`,
      value: user.email,
    };
  });
}

useHead({
  title: `Connexion - ${runTimeConfig.appName}`,
});

const loginAgentConnect = () => {
  navigateTo(`${runTimeConfig.apiUrl}/auth/login`, { external: true });
};

const loginDev = () => {
  navigateTo(`${runTimeConfig.apiUrl}/auth/login/dev/${userSelected.value}`, { external: true });
};
</script>

<template>
  <div class="fr-px-md-0 fr-py-10v fr-py-md-14v">
    <div class="fr-grid-row fr-grid-row-gutters fr-grid-row--center">
      <div class="fr-col-12 fr-col-md-9 fr-col-lg-8">
        <DsfrAlert
          v-if="isError"
          class="fr-mb-2w"
          type="error"
          title="La connexion a échoué"
          description="Il semblerait que vous n'ayez pas les droits pour accéder à cette application. Veuillez contacter le support si vous pensez que c'est une erreur."
          :small="false"
        />
        <h1>Connexion à {{ runTimeConfig.appName }}</h1>
        <div class="fr-mb-6v">
          <h2>Se connecter avec ProConnect</h2>
          <div class="fr-connect-group" data-cy="LoginAgentConnectBtn">
            <button class="fr-connect" @click="loginAgentConnect()">
              <span class="fr-connect__login">S’identifier avec</span>
              <span class="fr-connect__brand">ProConnect</span>
            </button>
            <p>
              <a href="https://agentconnect.gouv.fr/" target="_blank" rel="noopener" title="Qu’est ce qu'ProConnect ? - nouvelle fenêtre"
                >Qu’est ce que ProConnect ?</a
              >
            </p>
          </div>
          <div class="fr-mb-6v" 
               v-if="!+runTimeConfig.isProd">
            <h2>Se connecter (DEV Only)</h2>
            <DsfrSelect v-model="userSelected" :options="userList" />
            <DsfrButton label="Se connecter" data-cy="LoginDevBtn" @click="loginDev()" :disabled="!userSelected" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
:root[data-fr-theme='dark'] button.fr-connect {
  background-color: white;

  &:hover {
    background-color: #f5f5f5;
  }
}
</style>
