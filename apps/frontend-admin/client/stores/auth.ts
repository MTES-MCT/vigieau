import { defineStore } from 'pinia';
import type { Ref } from "vue";
import type { User } from "~/dto/user.dto";

export const useAuthStore = defineStore('auth', () => {
  const user: Ref<User | null> = ref(null);
  const api = useApi();

  const isAuthenticated = computed(async () => {
    if (user.value) {
      return true;
    }
    // GET USER
    const { data, error } = await api.user.me();
    if (data.value) {
      user.value = data.value;
      return true;
    }
    return false;
  });

  const isMte = computed(() => {
    if (user.value) {
      return user.value.role === 'mte';
    }
    return false;
  });

  const logout = () => {
    user.value = null;
  };

  return { user, isAuthenticated, isMte, logout };
});
