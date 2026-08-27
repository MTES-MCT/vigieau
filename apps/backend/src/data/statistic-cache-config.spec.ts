import {
  isPublicSourceRevisionEnabled,
  statisticSourceRevisionSql,
} from './statistic-cache-config';

describe('statistic cache configuration', () => {
  const original = process.env.PUBLIC_SOURCE_REVISION_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
    } else {
      process.env.PUBLIC_SOURCE_REVISION_ENABLED = original;
    }
  });

  it('keeps the technical revision by default', () => {
    delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;

    expect(isPublicSourceRevisionEnabled()).toBe(false);
    expect(statisticSourceRevisionSql('source_state')).toBe(
      'source_state."revision"',
    );
  });

  it('selects publicRevision only when explicitly enabled', () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';

    expect(isPublicSourceRevisionEnabled()).toBe(true);
    expect(statisticSourceRevisionSql('source_state')).toBe(
      'source_state."publicRevision"',
    );
  });

  it('rejects an ambiguous flag value', () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'yes';

    expect(() => isPublicSourceRevisionEnabled()).toThrow(
      'Unsupported PUBLIC_SOURCE_REVISION_ENABLED',
    );
  });
});
