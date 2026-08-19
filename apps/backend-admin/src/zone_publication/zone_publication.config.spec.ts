import {
  isPublicSourceRevisionEnabled,
  PUBLIC_SOURCE_REVISION_ENABLED_ENV,
  sourceRevisionColumn,
} from './zone_publication.config';

describe('public source revision configuration', () => {
  const previousValue = process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV];

  afterEach(() => {
    if (previousValue === undefined) {
      delete process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV];
    } else {
      process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV] = previousValue;
    }
  });

  it('defaults to the legacy technical revision', () => {
    delete process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV];

    expect(isPublicSourceRevisionEnabled()).toBe(false);
    expect(sourceRevisionColumn('source')).toBe('source."revision"');
  });

  it('selects the public revision only for an explicit true value', () => {
    process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV] = ' TRUE ';

    expect(isPublicSourceRevisionEnabled()).toBe(true);
    expect(sourceRevisionColumn('source')).toBe('source."publicRevision"');
  });

  it('rejects unsupported values instead of silently changing revision', () => {
    process.env[PUBLIC_SOURCE_REVISION_ENABLED_ENV] = 'yes';

    expect(() => isPublicSourceRevisionEnabled()).toThrow(
      `Unsupported ${PUBLIC_SOURCE_REVISION_ENABLED_ENV}: yes`,
    );
  });
});
