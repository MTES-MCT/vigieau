export function applyLightTheme(
  root: Pick<HTMLElement, 'setAttribute'>,
  getStorage: () => Pick<Storage, 'setItem'> | null | undefined,
): void {
  root.setAttribute('data-fr-theme', 'light');
  try {
    getStorage()?.setItem('vue-dsfr-scheme', 'light');
  } catch {
    // Browser privacy settings may forbid storage without forbidding the page.
  }
}
