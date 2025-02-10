import { useAuthStore } from '~/stores/auth';

export default defineNuxtRouteMiddleware(async (to) => {
  const authStore = useAuthStore();
  const rolesAuthorized: string[] = <any> to.meta.roles;
  
  if(authStore.user && rolesAuthorized.includes(authStore.user.role)) {
    return true;
  }
  if(authStore.user?.role === 'departement' || authStore.user?.role === 'mte') {
    return navigateTo('/');
  } else {
    return navigateTo('/arrete-municipal');
  }
  
})