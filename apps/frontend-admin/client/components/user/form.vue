<script setup lang="ts">
import type { Ref } from 'vue';
import { email, helpers, required, requiredIf } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { User } from '~/dto/user.dto';
import { UserRole } from '~/dto/user.dto';
import { useAuthStore } from '~/stores/auth';
import deburr from 'lodash.deburr';
import { useRefDataStore } from '~/stores/refData';
import type { Departement } from '~/dto/departement.dto';

const props = defineProps<{
  user: User | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  createEdit: any;
}>();

const rolesAvailable = [];
const authStore = useAuthStore();
const refDataStore = useRefDataStore();

const query: Ref<string> = ref('');
const departementsTags: Ref<any> = ref([]);
const departementsFiltered: Ref<any> = ref([]);

for (const ur in UserRole) {
  if (ur === 'commune') {
    continue;
  }
  if (!(ur === 'mte' && authStore.user.role === 'departement')) {
    rolesAvailable.push({
      text: UserRole[ur],
      value: ur,
    });
  }
}

const formData = reactive({
  email: props.user ? props.user.email : null,
  firstName: props.user ? props.user.firstName : null,
  lastName: props.user ? props.user.lastName : null,
  role: props.user ? props.user.role : rolesAvailable.length > 1 ? null : rolesAvailable[0].value,
  roleDepartements: props.user ? props.user.roleDepartements : authStore.user.role === 'departement' ? authStore.user.roleDepartements : [],
  isNewUser: !props.user,
});
const errorMessage: Ref<string> = ref('');

const rules = computed(() => {
  return {
    email: {
      required: helpers.withMessage('L\'email est obligatoire.', required),
      email: helpers.withMessage('L\'email n\'est pas valide.', email),
    },
    firstName: {},
    lastName: {},
    role: {
      required: helpers.withMessage('Le rôle est obligatoire.', required),
    },
    roleDepartements: {
      requiredIf: helpers.withMessage('Le département est obligatoire.', requiredIf(formData.role === 'departement')),
      $each: {
        regex: helpers.withMessage('Le département n\'existe pas', helpers.regex(/^([0|2][1-9]|[1|3-8][0-9]|9[0-5]|97[1-4]|2[AB]|976)$/)),
      },
    },
  };
});

const v$ = useVuelidate(rules, formData);

const computeErrorMessage = () => {
  errorMessage.value = v$.value.$errors.map((e) => e.$message).join(' ');
};

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error && !props.loading) {
    emit('createEdit', formData);
  } else {
    computeErrorMessage();
  }
};

const filterDepartements = () => {
  let tmp = refDataStore.departements
    .filter((d) => !formData.roleDepartements?.includes(d.code))
    .filter(d => authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(d.code));
  if (query.value) {
    tmp = tmp.filter((d) => {
      return (deburr(d.nom)
          .replace(/[\s\-\_]/g, '')
          .toLowerCase()
          .includes(
            deburr(query.value)
              .replace(/[\s\-\_]/g, '')
              .toLowerCase(),
          ) ||
        d.code.toLowerCase().includes(query.value.toLowerCase())
      );
    });
  }
  tmp.map((d: any) => {
    d.display = `${d.code} - ${d.nom}`;
    return d;
  });
  departementsFiltered.value = tmp;
};

const selectDepartement = (departement: Departement) => {
  if (typeof departement === 'string') {
    return;
  }
  query.value = '';
  formData.roleDepartements = [...formData.roleDepartements, departement.code];
  computeDepartementsTags();
};

const deleteDepartement = (departementCode: string) => {
  formData.roleDepartements = formData.roleDepartements.filter((d: string) => d !== departementCode);
  computeDepartementsTags();
};

const computeDepartementsTags = () => {
  departementsTags.value = formData.roleDepartements.map((d) => {
    const departement = refDataStore.departements.find((dep) => dep.code === d);
    return {
      label: `${departement?.code} - ${departement?.nom}`,
      class: authStore.user?.role !== 'mte' && !authStore.user?.roleDepartements.includes(departement.code) ? '' : 'fr-tag--dismiss',
      tagName: 'button',
      onclick: () => {
        if (!departement || (authStore.user?.role !== 'mte' && !authStore.user?.roleDepartements.includes(departement.code))) {
          return;
        }
        deleteDepartement(departement.code);
      },
    };
  });
};

computeDepartementsTags();

watch(
  query,
  useUtils().debounce(async () => {
    filterDepartements();
  }, 300),
  { immediate: true },
);

defineExpose({
  submitForm,
});
</script>

<template>
  <form @submit.prevent="">
    <DsfrInputGroup :error-message="errorMessage" :valid-message="''">
      <DsfrInput
        id="email"
        data-cy="UserFormEmailInput"
        v-model="formData.email"
        hint="Format attendu: nom@domaine.fr"
        label="Email"
        label-visible
        type="text"
        name="email"
        :disabled="loading || !formData.isNewUser"
        :required="true"
      />
      <div class="fr-mt-2w">
        <DsfrInput
          v-if="!formData.isNewUser"
          id="firstName"
          data-cy="UserFormFirstNameInput"
          v-model="formData.firstName"
          label="Prénom"
          label-visible
          type="text"
          name="firstName"
          disabled
        />
      </div>
      <div class="fr-mt-2w">
        <DsfrInput
          v-if="!formData.isNewUser"
          id="lastName"
          data-cy="UserFormLastNameInput"
          v-model="formData.lastName"
          label="Nom"
          label-visible
          type="text"
          name="lastName"
          disabled
        />
      </div>
      <div class="fr-mt-2w">
        <DsfrSelect
          id="role"
          v-model="formData.role"
          :options="rolesAvailable"
          label="Rôle"
          label-visible
          type="text"
          name="role"
          :disabled="loading || authStore.user.role === 'departement'"
          required
        />
      </div>
      <div class="fr-mt-2w">
        <MixinsAutoComplete
          v-if="formData.role === 'departement'"
          label="Ajouter un/des départements"
          data-cy="UserFormRoleDepartementInput"
          class="show-label"
          icon="ri-add-fill"
          :labelVisible="true"
          buttonText="Ajouter"
          display-key="display"
          v-model="query"
          :options="departementsFiltered"
          placeholder="Rechercher un département"
          @update:modelValue="selectDepartement($event)"
          @search="selectDepartement($event)"
          :disabled="loading"
          :required="true"
        />

        <DsfrTags class="fr-mt-2w" :tags="departementsTags" />
      </div>
    </DsfrInputGroup>
  </form>
</template>
