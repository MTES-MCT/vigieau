export interface Thematique {
  id: number;
  nom: string;
}

export enum ThematiqueExamples {
  'Abreuver' = 'Abreuvement du bétail, Abreuvement des animaux domestiques',
  'Alimenter des fontaines et autres usages de loisirs' = 'Alimentation des douches de plage et jeux d\'eau, Brumisateurs et dispositifs de rafraîchissement urbains',
  'Arroser' = 'Arrosage d\'arbres et arbustes, Arrosage des espaces verts et pelouses',
  'ICPE' = 'ICPE ayant ou non un APC relatif à la sécheresse',
  "Installations de production d'électricité" = 'Installations hydroélectriques, Installations thermiques à flamme',
  'Irriguer' = 'Irrigation agricole par système localisé, Irrigation dans le cadre de la gestion collective (OUGC)',
  'Nettoyer' = 'Lavage d’engins nautiques, Lavage des voiries',
  'Prélever' = 'Prélèvements dans le milieu naturel et les fontaines publiques',
  'Remplir ou vidanger' = 'Remplissage et vidange des plans d\'eau,  Remplissage et vidange de piscines ',
  'Travaux et activités en cours d\'eau' = 'Travaux en cours d\'eau, Navigation fluviale, Activités nautiques',
  'Rejeter' = 'Rejets directs en cours d’eau, Rejets des stations d\'épuration et collecteurs pluviaux',
  'Activités économiques' = 'Activités industrielles, commerciales et artisanales',
  'Ouvrages hydrauliques' = 'Manoeuvres des vannes d\'installations hydrauliques, Gestion des barrages',
  'Sécurité incendie' = 'Contrôles des bornes incendies, Test de poteau incendie',
}
