export default defineNuxtRouteMiddleware((to: any) => {
  if (!to.query.token) {
    return navigateTo({path: '/'});
  }
  return true;
})
