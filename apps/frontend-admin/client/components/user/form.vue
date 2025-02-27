<script setup lang="ts">
import type {Ref} from 'vue';
import {email, helpers, required, requiredIf} from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type {User} from '~/dto/user.dto';
import {UserRole} from '~/dto/user.dto';
import {useAuthStore} from '~/stores/auth';
import deburr from 'lodash.deburr';
import {useRefDataStore} from '~/stores/refData';
import type {Departement} from '~/dto/departement.dto';
import type {Commune} from "~/dto/commune.dto";

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

const queryDep: Ref<string> = ref('');
const queryCom: Ref<string> = ref('');
const departementsTags: Ref<any> = ref([]);
const departementsFiltered: Ref<any> = ref([]);
const communesTags: Ref<any> = ref([]);
const communesFiltered: Ref<any> = ref([]);

for (const ur in UserRole) {
  if (ur !== 'departement' && authStore.user.role === 'departement') {
    continue;
  }
  rolesAvailable.push({
    text: UserRole[ur],
    value: ur,
  });
}

const formData = reactive({
  email: props.user ? props.user.email : null,
  firstName: props.user ? props.user.firstName : null,
  lastName: props.user ? props.user.lastName : null,
  role: props.user ? props.user.role : rolesAvailable.length > 1 ? null : rolesAvailable[0].value,
  roleDepartements: props.user ? props.user.roleDepartements || [] : authStore.user.role === 'departement' ? authStore.user.roleDepartements : [],
  roleCommunes: props.user ? props.user.roleCommunes || [] : [],
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
    roleCommunes: {
      requiredIf: helpers.withMessage('La commune est obligatoire.', requiredIf(formData.role === 'commune')),
      $each: {
        regex: helpers.withMessage('La commune n\'existe pas', helpers.regex(/^([0|2][1-9]|[1|3-8][0-9]|9[0-5]|97[1-4]|2[AB]|976)$/)),
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
  if (queryDep.value) {
    tmp = tmp.filter((d) => {
      return (deburr(d.nom)
          .replace(/[\s\-\_]/g, '')
          .toLowerCase()
          .includes(
            deburr(queryDep.value)
              .replace(/[\s\-\_]/g, '')
              .toLowerCase(),
          ) ||
        d.code.toLowerCase().includes(queryDep.value.toLowerCase())
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
  queryDep.value = '';
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

const filtercommunes = () => {
  let tmp = refDataStore.communes;
  if (queryCom.value) {
    tmp = tmp.filter((c) => {
      return (deburr(c.nom)
          .replace(/[\s\-\_]/g, '')
          .toLowerCase()
          .includes(
            deburr(queryCom.value)
              .replace(/[\s\-\_]/g, '')
              .toLowerCase(),
          ) ||
        c.code.toLowerCase().includes(queryCom.value.toLowerCase())
      );
    });
  }
  tmp = tmp.filter((c) => !formData.roleCommunes?.includes(c.code));
  tmp.map((c: any) => {
    c.display = `${c.code} - ${c.nom}`;
    return c;
  });
  communesFiltered.value = tmp;
};

const selectCommune = (commune: Commune) => {
  if (typeof commune === 'string') {
    return;
  }
  queryCom.value = '';
  formData.roleCommunes = [...formData.roleCommunes, commune.code];
  computeCommunesTags();
};

const deleteCommune = (communeCode: string) => {
  formData.roleCommunes = formData.roleCommunes.filter((c: string) => c !== communeCode);
  computeCommunesTags();
};

const computeCommunesTags = () => {
  communesTags.value = formData.roleCommunes.map((c) => {
    const commune = refDataStore.communes.find((com) => com.code === c);
    return {
      label: `${commune?.code} - ${commune?.nom}`,
      class: authStore.user?.role !== 'mte' && !authStore.user?.roleCommunes.includes(commune.code) ? '' : 'fr-tag--dismiss',
      tagName: 'button',
      onclick: () => {
        if (authStore.user?.role !== 'mte' && !authStore.user?.roleCommunes.includes(commune.code)) {
          return;
        }
        deleteCommune(c);
      },
    };
  });
};

computeCommunesTags();

watch(
  queryDep,
  useUtils().debounce(async () => {
    filterDepartements();
  }, 300),
);

watch(
  queryCom,
  useUtils().debounce(async () => {
    if (queryCom.value.length < 2) {
      return;
    }
    filtercommunes();
  }, 300),
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
      <div class="fr-mt-2w"
           v-if="formData.role === 'departement'">
        <MixinsAutoComplete
          label="Ajouter un/des départements"
          data-cy="UserFormRoleDepartementInput"
          class="show-label"
          icon="ri-add-fill"
          :labelVisible="true"
          buttonText="Ajouter"
          display-key="display"
          v-model="queryDep"
          :options="departementsFiltered"
          placeholder="Rechercher un département"
          @update:modelValue="selectDepartement($event)"
          @search="selectDepartement($event)"
          :disabled="loading"
          :required="true"
        />

        <DsfrTags class="fr-mt-2w" :tags="departementsTags"/>
      </div>
      <div class="fr-mt-2w"
           v-if="formData.role === 'commune'">
        <MixinsAutoComplete
          label="Ajouter une/des communes"
          data-cy="UserFormRoleCommuneInput"
          class="show-label"
          icon="ri-add-fill"
          :labelVisible="true"
          buttonText="Ajouter"
          display-key="display"
          v-model="queryCom"
          :options="communesFiltered"
          placeholder="Rechercher une commune (nom ou code INSEE)"
          @update:modelValue="selectCommune($event)"
          @search="selectCommune($event)"
          :disabled="loading"
          :required="true"
        />

        <DsfrTags class="fr-mt-2w" :tags="communesTags"/>
      </div>
    </DsfrInputGroup>
  </form>
</template>
