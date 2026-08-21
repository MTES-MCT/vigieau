export const ACCESSIBILITY_COMPLIANCE_STATUS = 'Partiellement conforme';

export function getMandatoryFooterLinks() {
  return [
    {
      label: `Accessibilité : ${ACCESSIBILITY_COMPLIANCE_STATUS}`,
      to: '/accessibilite',
    },
    { label: 'Mentions légales', to: '/mentions-legales' },
    { label: 'Données personnelles', to: '/donnees-personnelles' },
    { label: 'Cookies', to: '/cookies' },
  ];
}
