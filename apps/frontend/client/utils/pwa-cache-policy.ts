export const pwaNetworkOnlyPattern =
  /(?:^https?:\/\/api\.|\/api(?:\/|$)|\/zones\/publication(?:\/|$|\?)|\/manifest\.webmanifest(?:$|\?)|\/historic-backfill-manifest\.json(?:$|\?)|\.pmtiles(?:$|\?))/;

export const pwaNavigationFallbackDenylist = [
  /^\/api(?:\/|$)/,
  /^\/zones\/publication(?:\/|$)/,
  /\/historic-backfill-manifest\.json(?:$|\?)/,
  /\.pmtiles(?:$|\?)/,
  /\.[^/]+$/,
];

export function isPwaNetworkOnlyUrl(url: string | URL): boolean {
  return pwaNetworkOnlyPattern.test(String(url));
}
