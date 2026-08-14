export const pwaNetworkOnlyPattern =
  /(?:^https?:\/\/api\.|\/api(?:\/|$)|\/zones\/publication(?:\/|$|\?)|\/manifest\.webmanifest(?:$|\?)|\.pmtiles(?:$|\?))/;

export const pwaNavigationFallbackDenylist = [
  /^\/api(?:\/|$)/,
  /^\/zones\/publication(?:\/|$)/,
  /\.pmtiles(?:$|\?)/,
  /\.[^/]+$/,
];

export function isPwaNetworkOnlyUrl(url: string | URL): boolean {
  return pwaNetworkOnlyPattern.test(String(url));
}
