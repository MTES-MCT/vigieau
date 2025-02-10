import { useAuthStore } from '~/stores/auth';

export default defineNuxtRouteMiddleware(async (to) => {
  const authStore = useAuthStore();

  const isAuthenticated = await authStore.isAuthenticated;
  if (to.path !== '/connexion' && !isAuthenticated) {
    return navigateTo({ path: '/connexion', query: to.query });
  } else if (to.path === '/connexion' && isAuthenticated) {
    return navigateTo({ path: '/', query: to.query });
  }

  return true;
});
