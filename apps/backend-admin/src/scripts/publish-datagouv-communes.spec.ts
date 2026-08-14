import {
  publishAnnualCommunesResource,
  resolveAnnualCommunesPublicationOptions,
  resolveExpectedSourceDate,
} from './publish-datagouv-communes';

describe('publish-datagouv-communes safeguards', () => {
  it('uses the scheduled Europe/Paris source date and passes it to the service', async () => {
    const options = resolveAnnualCommunesPublicationOptions(
      '2026',
      undefined,
      new Date('2026-08-05T03:30:00.000Z'),
    );
    const publisher = {
      createOrUpdateCommunesResource: jest
        .fn()
        .mockResolvedValue('resource-2026'),
    };

    await expect(
      publishAnnualCommunesResource(publisher, options),
    ).resolves.toBe('resource-2026');

    expect(options).toEqual({
      year: 2026,
      expectedSourceDate: '2026-08-04',
    });
    expect(publisher.createOrUpdateCommunesResource).toHaveBeenCalledWith(
      2026,
      '2026-08-04',
    );
  });

  it('defaults to the year of the scheduled civil date around New Year', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        undefined,
        undefined,
        new Date('2027-01-01T04:30:00.000Z'),
      ),
    ).toEqual({ year: 2026, expectedSourceDate: '2026-12-31' });
  });

  it('uses the current Paris civil date from the 6:00 publication cutoff', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2026',
        undefined,
        new Date('2026-08-05T04:00:00.000Z'),
      ),
    ).toEqual({ year: 2026, expectedSourceDate: '2026-08-05' });
  });

  it('requires complete coverage through 31 December for a past year', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2025',
        undefined,
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({ year: 2025, expectedSourceDate: '2025-12-31' });
  });

  it('accepts only the explicit authoritative source date', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2026',
        '2026-08-05',
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({ year: 2026, expectedSourceDate: '2026-08-05' });
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2025',
        '2025-12-31',
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({ year: 2025, expectedSourceDate: '2025-12-31' });
  });

  it('rejects invalid, stale, cross-year and future explicit source dates', () => {
    expect(() =>
      resolveExpectedSourceDate('2026-02-30', 2026, '2026-08-05'),
    ).toThrow('Invalid civil date');
    expect(() =>
      resolveExpectedSourceDate('2026-06-22', 2026, '2026-08-05'),
    ).toThrow(
      'EXPECTED_SOURCE_DATE 2026-06-22 must equal authoritative source date 2026-08-05',
    );
    expect(() =>
      resolveExpectedSourceDate('2025-12-31', 2026, '2026-08-05'),
    ).toThrow('must equal authoritative source date 2026-08-05');
    expect(() =>
      resolveExpectedSourceDate('2026-08-06', 2026, '2026-08-05'),
    ).toThrow('must equal authoritative source date 2026-08-05');
    expect(() =>
      resolveExpectedSourceDate('2025-12-30', 2025, '2026-08-05'),
    ).toThrow('must equal authoritative source date 2025-12-31');
  });

  it('rejects future annual publications even without an explicit source date', () => {
    expect(() =>
      resolveAnnualCommunesPublicationOptions(
        '2027',
        undefined,
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toThrow('Cannot publish communes for future year 2027');
  });
});
