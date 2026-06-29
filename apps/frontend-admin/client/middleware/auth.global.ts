import { useAuthStore } from '~/stores/auth';

export default defineNuxtRouteMiddleware(async (to) => {
  const authStore = useAuthStore();

  if (to.path === '/connexion') {
    if (authStore.isAuthenticated) {
      return navigateTo({ path: '/', query: to.query });
    }
    return true;
  }

  const isAuthenticated = await authStore.checkAuthentication();
  if (!isAuthenticated) {
    return navigateTo({ path: '/connexion', query: to.query });
  }

  return true;
});
