import { createHash } from 'node:crypto';
import type { DocumentObject } from './document-scan.types';

const DOCUMENT_EXTENSION =
  /\.(?:pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp|txt|eml|msg|jpe?g|png|tiff?|gif|svg|zip)$/i;
const DOCUMENT_FOLDER =
  /^(?:arrete-cadre|arrete-restriction|arrete-municipal)\//;
const GENERATED_FOLDER =
  /^(?:geojson|pmtiles|statistic-cache|statistics|zone-publication|historic-backfill|historic-map-repairs|_antivirus-quarantine)\//;
const GENERATED_ARCHIVE = /^zones_(?:geojson|pmtiles)_\d{4}\.zip$/i;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Keys are opaque S3 strings. In particular /arrete.pdf differs from arrete.pdf. */
export function objectIdentity(object: DocumentObject): string {
  return sha256Text(
    JSON.stringify([
      object.bucket,
      object.key,
      object.versionId ?? null,
      object.etag ?? null,
      object.size,
      object.modifiedAt ?? null,
    ]),
  );
}

export function sameObject(
  left: DocumentObject,
  right: DocumentObject,
): boolean {
  return (
    left.bucket === right.bucket &&
    left.key === right.key &&
    (!left.versionId || left.versionId === right.versionId) &&
    (!left.etag || left.etag === right.etag) &&
    left.size === right.size &&
    (!left.modifiedAt || left.modifiedAt === right.modifiedAt)
  );
}

export function scopedRelativeKey(key: string, prefix: string): string | null {
  if (prefix) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
    if (!prefix.startsWith('/') && key.startsWith('/' + prefix))
      return key.slice(prefix.length + 1);
    return null;
  }
  const relative = key.startsWith('/') ? key.slice(1) : key;
  // Production uses the bucket root; sibling test/dev prefixes belong to other environments.
  if (
    /^(?:test|dev|preprod|preproduction)\//i.test(relative.replace(/^\/+/, ''))
  )
    return null;
  return relative;
}

export function isDocumentKey(
  key: string,
  prefix: string,
  referenced = false,
): boolean {
  const relative = scopedRelativeKey(key, prefix)?.replace(/^\/+/, '');
  if (relative === null || !relative || relative.endsWith('/')) return false;
  if (relative.startsWith('_antivirus-quarantine/')) return false;
  if (referenced || DOCUMENT_FOLDER.test(relative)) return true;
  return (
    !GENERATED_FOLDER.test(relative) &&
    !GENERATED_ARCHIVE.test(relative) &&
    DOCUMENT_EXTENSION.test(relative)
  );
}

export function isDocumentPrefix(key: string, prefix: string): boolean {
  const relative = scopedRelativeKey(key, prefix)?.replace(/^\/+/, '');
  return relative !== undefined && !GENERATED_FOLDER.test(relative);
}

export type ParsedDocumentUrl =
  | { kind: 'key'; key: string }
  | { kind: 'external' }
  | { kind: 'invalid' };

export function documentKeyFromUrl(
  value: string,
  publicBaseUrl: string,
): ParsedDocumentUrl {
  try {
    const base = new URL(publicBaseUrl);
    const url = new URL(value);
    if (
      url.origin !== base.origin ||
      !['https:', 'http:'].includes(url.protocol)
    )
      return { kind: 'external' };
    if (url.username || url.password || url.search || url.hash)
      return { kind: 'invalid' };
    const basePath = base.pathname.endsWith('/')
      ? base.pathname
      : base.pathname + '/';
    if (!url.pathname.startsWith(basePath)) return { kind: 'external' };
    const key = decodeURIComponent(url.pathname.slice(basePath.length));
    if (!key || /[\u0000-\u001f]/.test(key)) return { kind: 'invalid' };
    return { kind: 'key', key };
  } catch {
    return { kind: 'invalid' };
  }
}

export function publicObjectUrl(
  baseUrl: string,
  key: string,
  versionId?: string,
): string {
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid S3_VHOST');
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('S3 key cannot be represented safely as a public URL');
  }
  // Encode segments individually to retain an existing leading slash in a key.
  const path = base.pathname.endsWith('/')
    ? base.pathname
    : base.pathname + '/';
  const url = `${base.origin}${path}${key.split('/').map(encodeURIComponent).join('/')}`;
  return url + (versionId ? `?versionId=${encodeURIComponent(versionId)}` : '');
}
