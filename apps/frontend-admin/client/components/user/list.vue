<script setup lang="ts">
import type { Ref } from 'vue';
import type { User } from '~/dto/user.dto';
import { UserRole } from '~/dto/user.dto';
import { useAuthStore } from '~/stores/auth';
import { matchesUserSearch, userExportUrl } from '~/utils/audit';

const headers = ['Nom', 'Prénom', 'Email', 'Rôle', '', ''];
const noCaption = false;
const pagination = true;
const users: Ref<User[]> = ref([]);
const rows: Ref<any[]> = ref([]);
const loading: Ref<boolean> = ref(false);
const modalEditOpened: Ref<boolean> = ref(false);
const modalDeleteOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalText: Ref<string> = ref('');
const modalIcon: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);
const userToEdit: Ref<User> = ref(null);
const userFormRef = ref(null);
const componentKey = ref(0);
const exporting = ref(false);

const authStore = useAuthStore();
const utils = useUtils();

const query: Ref<string> = ref('');
const usersFiltered: Ref<User[]> = ref([]);

const generateRows = () => {
  rows.value = [
    ...usersFiltered.value.map((d: User) => {
      return [
        d.lastName || '',
        d.firstName || '',
        d.email,
        `${UserRole[d.role]} ${d.role === 'departement' ? ` (${d.roleDepartements?.join(', ')})` : ''}
        ${d.role === 'commune' ? ` (${d.roleCommunes?.join(', ')})` : ''}`,
        authStore.isMte
          ? {
              component: 'DsfrButton',
              label: 'Modifier',
              'data-cy': 'UserListEditBtn',
              icon: 'ri-ball-pen-line',
              iconOnly: true,
              onclick: () => askEditUser(d),
            }
          : '',
        {
          component: 'DsfrButton',
          label: 'Supprimer',
          'data-cy': 'UserListDeleteBtn',
          icon: 'ri-delete-bin-5-fill',
          iconOnly: true,
          onclick: () => askDeleteUser(d),
        },
      ];
    }),
  ];
  componentKey.value += 1;
};

const api = useApi();
const { data, error: _error } = await api.user.list();
if (data.value) {
  users.value = data.value;
  usersFiltered.value = users.value;
  generateRows();
}

const askEditUser = (user) => {
  utils.closeModal(modalDeleteOpened);
  modalEditOpened.value = true;
  modalTitle.value = "Modification d'un utilisateur";
  modalIcon.value = 'ri-ball-pen-line';
  userToEdit.value = user;
  modalActions.value = [
    {
      label: 'Annuler',
      secondary: true,
      onclick: closeModal,
    },
    {
      label: 'Enregistrer',
      onclick: validateEditUserForm,
      'data-cy': 'UserFormEditBtn',
    },
  ];
};

const askAddUser = () => {
  utils.closeModal(modalDeleteOpened);
  modalEditOpened.value = true;
  modalTitle.value = "Ajout d'un utilisateur";
  modalIcon.value = 'ri-ball-pen-line';
  userToEdit.value = null;
  modalActions.value = [
    {
      label: 'Annuler',
      secondary: true,
      onclick: closeModal,
    },
    {
      label: 'Enregistrer',
      onclick: validateEditUserForm,
      'data-cy': 'UserFormAddBtn',
    },
  ];
};

const askDeleteUser = (user) => {
  utils.closeModal(modalEditOpened);
  modalDeleteOpened.value = true;
  modalTitle.value = "Suppression d'un utilisateur";
  modalIcon.value = 'ri-delete-bin-5-fill';
  modalText.value = `<p>Êtes-vous sûr de vouloir supprimer l'utilisateur ${user.firstName || ''} ${user.lastName || ''} (${
    user.email
  }) ?</p>`;
  userToEdit.value = user;
  modalActions.value = [
    {
      label: 'Annuler',
      secondary: true,
      onclick: closeModal,
    },
    {
      label: 'Supprimer',
      'data-cy': 'UserFormDeleteBtn',
      onclick: deleteUser,
    },
  ];
};
const closeModal = () => {
  utils.closeModal(modalEditOpened);
  utils.closeModal(modalDeleteOpened);
};

const deleteUser = async () => {
  const { data: _data, error } = await api.user.delete(userToEdit.value.email);
  closeModal();
  if (!error.value) {
    users.value = users.value.filter((u: User) => u.email !== userToEdit.value.email);
    filterUsers();
    generateRows();
  } else {
    // TODO DISPLAY ERROR
  }
};

const createEditUser = async (user: any) => {
  loading.value = true;
  const { data, error } = user.isNewUser ? await api.user.create(user) : await api.user.update(user.email, user);
  loading.value = false;
  closeModal();
  if (!error.value) {
    if (user.isNewUser) {
      users.value.push(data.value);
    } else {
      users.value = users.value.map((u: User) => (u.email === user.email ? data.value : u));
    }
    filterUsers();
    generateRows();
  } else {
    // TODO DISPLAY ERROR
  }
};

const validateEditUserForm = () => {
  userFormRef.value.submitForm();
};

const filterUsers = () => {
  usersFiltered.value = users.value.filter((user) => matchesUserSearch(user, query.value));
  generateRows();
};

watch(
  query,
  useUtils().debounce(async () => {
    filterUsers();
  }, 300),
  { immediate: true },
);

const exportToCSV = async () => {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const { data, error } = await useCustomFetch(userExportUrl(query.value), { responseType: 'blob', retry: 0 });
    if (error.value || !data.value) return;
    const url = URL.createObjectURL(data.value);
    const link = document.createElement('a');
    link.href = url;
    link.download = `utilisateurs_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    exporting.value = false;
  }
};
</script>

<template>
  <div class="fr-grid-row fr-grid-row--space-between fr-grid-row--middle fr-mb-2w">
    <h1 class="fr-my-0">Utilisateurs</h1>
    <DsfrButton label="Ajouter un utilisateur" data-cy="UserListAddUserButton" @click="askAddUser()" />
  </div>
  <div class="fr-grid-row">
    <div class="fr-col-12 fr-col-lg-4">
      <DsfrInput v-model="query" placeholder="Rechercher un utilisateur" button-text="Chercher" />
    </div>
  </div>
  <DsfrTable :key="componentKey" :headers="headers" :rows="rows" :no-caption="noCaption" :pagination="pagination" />
  <div class="fr-mt-4w fr-col-12 text-align-right">
    <DsfrButton :label="exporting ? 'Export en cours…' : 'Export CSV'" :disabled="exporting" @click="exportToCSV()" />
  </div>
  <DsfrModal :opened="modalEditOpened" :title="modalTitle" :icon="modalIcon" :actions="modalActions" @close="closeModal">
    <UserForm ref="userFormRef" :user="userToEdit" :loading="loading" @create-edit="createEditUser($event)" />
  </DsfrModal>
  <DsfrModal :opened="modalDeleteOpened" :title="modalTitle" :icon="modalIcon" :actions="modalActions" @close="closeModal">
    <div v-html="modalText" />
  </DsfrModal>
</template>
