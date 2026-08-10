export const MAPLIBRE_FRENCH_LOCALE = {
  'AttributionControl.ToggleAttribution': 'Afficher les sources de la carte',
  'AttributionControl.MapFeedback': 'Signaler un problème sur la carte',
  'FullscreenControl.Enter': 'Afficher la carte en plein écran',
  'FullscreenControl.Exit': 'Quitter le plein écran',
  'GeolocateControl.FindMyLocation': 'Afficher ma position',
  'GeolocateControl.LocationNotAvailable': 'Position indisponible',
  'LogoControl.Title': 'Logo MapLibre',
  'Map.Title': 'Carte interactive',
  'Marker.Title': 'Repère sur la carte',
  'NavigationControl.ResetBearing': 'Réorienter la carte vers le nord',
  'NavigationControl.ZoomIn': 'Zoomer sur la carte',
  'NavigationControl.ZoomOut': 'Dézoomer sur la carte',
  'Popup.Close': 'Fermer les informations du point sélectionné',
  'TerrainControl.Enable': 'Afficher le relief',
  'TerrainControl.Disable': 'Masquer le relief',
  'CooperativeGesturesHandler.WindowsHelpText':
    'Utilisez Ctrl et la molette pour zoomer sur la carte',
  'CooperativeGesturesHandler.MacHelpText':
    'Utilisez Commande et la molette pour zoomer sur la carte',
  'CooperativeGesturesHandler.MobileHelpText':
    'Utilisez deux doigts pour déplacer la carte',
};

export const getFrenchMapLocale = (mapTitle: string) => ({
  ...MAPLIBRE_FRENCH_LOCALE,
  'Map.Title': mapTitle,
});
