import { defineStore } from 'pinia';
import type { Ref } from 'vue';
import type { User } from '~/dto/user.dto';

export const useAuthStore = defineStore('auth', () => {
  const user: Ref<User | null> = ref(null);
  const api = useApi();
  const authenticationChecked = ref(false);
  const authenticationLoading = ref(false);
  let authenticationPromise: Promise<boolean> | null = null;

  const isAuthenticated = computed(() => !!user.value);

  const checkAuthentication = async () => {
    if (user.value) {
      authenticationChecked.value = true;
      return true;
    }

    if (authenticationPromise) {
      return authenticationPromise;
    }

    authenticationLoading.value = true;
    authenticationPromise = (async () => {
      try {
        const { data } = await api.user.me(false);
        if (data.value) {
          user.value = data.value;
          return true;
        }
      } catch (e) {
        return false;
      }
      return false;
    })().finally(() => {
      authenticationChecked.value = true;
      authenticationLoading.value = false;
      authenticationPromise = null;
    });

    return authenticationPromise;
  };

  const isMte = computed(() => {
    if (user.value) {
      return user.value.role === 'mte';
    }
    return false;
  });

  const logout = () => {
    user.value = null;
    authenticationChecked.value = false;
  };

  return {
    user,
    isAuthenticated,
    authenticationChecked,
    authenticationLoading,
    checkAuthentication,
    isMte,
    logout,
  };
});
