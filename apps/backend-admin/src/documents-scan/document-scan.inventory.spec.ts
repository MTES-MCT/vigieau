import {
  documentKeyFromUrl,
  isDocumentKey,
  isDocumentPrefix,
  objectIdentity,
  publicObjectUrl,
} from './document-scan.inventory';
import { DocumentObject } from './document-scan.types';

describe('document inventory scope and opaque S3 keys', () => {
  const vhost = 'https://documents.example.test/';
  it('preserves legacy leading slash and reserved characters in round trips', () => {
    const key = '/arrete-cadre/arrêté #1%20.pdf';
    const url = publicObjectUrl(vhost, key);
    expect(url).toContain('//arrete-cadre/');
    expect(documentKeyFromUrl(url, vhost)).toEqual({ kind: 'key', key });
    expect(documentKeyFromUrl(vhost + 'arrete-cadre%2Ff.pdf', vhost)).toEqual({
      kind: 'key',
      key: 'arrete-cadre/f.pdf',
    });
  });
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://documents.example.test.evil.test/f.pdf',
    'https://other.test/f.pdf',
  ])('never downloads an external DB reference: %s', (url) => {
    expect(documentKeyFromUrl(url, vhost).kind).toBe('external');
  });
  it.each([
    'https://user:pass@documents.example.test/f.pdf',
    vhost + 'f.pdf?token=secret',
    vhost + '%00.pdf',
  ])('rejects credentials, query strings and invalid keys', (url) => {
    expect(documentKeyFromUrl(url, vhost).kind).toBe('invalid');
  });
  it('does not permit URL-normalized dot segments for quarantine checks', () => {
    expect(() => publicObjectUrl(vhost, 'a/../b.pdf')).toThrow();
  });
  it('isolates preproduction and retains both historic key layouts', () => {
    expect(isDocumentKey('test/arrete-cadre/f.pdf', 'test/')).toBe(true);
    expect(isDocumentKey('/test/arrete-cadre/f.pdf', 'test/')).toBe(true);
    expect(isDocumentKey('arrete-cadre/f.pdf', 'test/')).toBe(false);
    expect(isDocumentKey('test/arrete-cadre/f.pdf', '')).toBe(false);
    expect(isDocumentKey('/arrete-cadre/f.pdf', '')).toBe(true);
  });
  it('includes orphan documents but excludes generated archives and folders', () => {
    for (const key of [
      'other/letter.docx',
      'archive.eml',
      'file.msg',
      'arrete-cadre/no-extension',
    ])
      expect(isDocumentKey(key, '')).toBe(true);
    for (const key of [
      'zones_pmtiles_2024.zip',
      'zones_geojson_2013.zip',
      'geojson/doc.pdf',
      'historic-map-repairs/doc.pdf',
      '_antivirus-quarantine/doc.pdf',
    ])
      expect(isDocumentKey(key, '')).toBe(false);
    expect(isDocumentPrefix('archive/', '')).toBe(true);
    expect(isDocumentPrefix('historic-map-repairs/', '')).toBe(false);
  });
  it('changes identity for every S3 version and does not normalize keys', () => {
    const object: DocumentObject = {
      bucket: 'b',
      key: 'a.pdf',
      size: 1,
      etag: 'a',
      latest: true,
      fichierIds: [],
    };
    expect(objectIdentity(object)).not.toBe(
      objectIdentity({ ...object, key: '/a.pdf' }),
    );
    expect(objectIdentity(object)).not.toBe(
      objectIdentity({ ...object, versionId: 'v2' }),
    );
    expect(objectIdentity(object)).not.toBe(
      objectIdentity({ ...object, etag: 'b' }),
    );
  });
});
