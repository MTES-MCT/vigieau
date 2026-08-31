import {
  publishAnnualCommunesResource,
  resolveAnnualCommunesPublicationOptions,
  resolveExpectedSourceDate,
} from './publish-datagouv-communes';

describe('publish-datagouv-communes safeguards', () => {
  const readyIdentity = (scheduledFor: string) => ({
    publicationMode: 'versioned' as const,
    publicationId: 'zone-publication-1',
    sourceRevision: '42',
    materializationVersion: 4,
    statisticCachePublicationId: 'statistic-publication-1',
    statisticRevision: '12',
    statisticPublishedDate: scheduledFor,
    statisticFingerprint: 'a'.repeat(64),
    historicFirstDate: '2013-01-01',
    historicLatestDate: scheduledFor,
    historicDateCount: 4_961,
    historicComputeEpoch: '8',
    historicReadinessMode: 'certified-repair' as const,
    certifiedHistoryRepairId: 'repair-1',
    certifiedHistoryRepairAttestationId: 'attestation-1',
  });

  function createReadiness(scheduledFor: string) {
    const identity = readyIdentity(scheduledFor);
    return {
      identity,
      service: {
        evaluate: jest.fn().mockResolvedValue({
          status: 'ready',
          scheduledFor,
          identity,
        }),
        assertReady: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

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
    const readiness = createReadiness(options.scheduledFor);

    await expect(
      publishAnnualCommunesResource(publisher, readiness.service, options),
    ).resolves.toBe('resource-2026');

    expect(options).toEqual({
      year: 2026,
      expectedSourceDate: '2026-08-04',
      scheduledFor: '2026-08-04',
    });
    expect(publisher.createOrUpdateCommunesResource).toHaveBeenCalledWith(
      2026,
      '2026-08-04',
    );
    expect(readiness.service.evaluate).toHaveBeenCalledWith('2026-08-04');
    expect(readiness.service.assertReady).toHaveBeenNthCalledWith(
      1,
      readiness.identity,
    );
    expect(readiness.service.assertReady).toHaveBeenNthCalledWith(
      2,
      readiness.identity,
    );
  });

  it('defaults to the year of the scheduled civil date around New Year', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        undefined,
        undefined,
        new Date('2027-01-01T04:30:00.000Z'),
      ),
    ).toEqual({
      year: 2026,
      expectedSourceDate: '2026-12-31',
      scheduledFor: '2026-12-31',
    });
  });

  it('uses the current Paris civil date from the 6:00 publication cutoff', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2026',
        undefined,
        new Date('2026-08-05T04:00:00.000Z'),
      ),
    ).toEqual({
      year: 2026,
      expectedSourceDate: '2026-08-05',
      scheduledFor: '2026-08-05',
    });
  });

  it('requires complete coverage through 31 December for a past year', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2025',
        undefined,
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({
      year: 2025,
      expectedSourceDate: '2025-12-31',
      scheduledFor: '2026-08-05',
    });
  });

  it('accepts only the explicit authoritative source date', () => {
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2026',
        '2026-08-05',
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({
      year: 2026,
      expectedSourceDate: '2026-08-05',
      scheduledFor: '2026-08-05',
    });
    expect(
      resolveAnnualCommunesPublicationOptions(
        '2025',
        '2025-12-31',
        new Date('2026-08-05T08:00:00.000Z'),
      ),
    ).toEqual({
      year: 2025,
      expectedSourceDate: '2025-12-31',
      scheduledFor: '2026-08-05',
    });
  });

  it('blocks a past-year publication when the current historic boundary is not certified', async () => {
    const options = resolveAnnualCommunesPublicationOptions(
      '2025',
      undefined,
      new Date('2026-08-05T08:00:00.000Z'),
    );
    const publisher = {
      createOrUpdateCommunesResource: jest.fn(),
    };
    const readiness = {
      evaluate: jest.fn().mockResolvedValue({
        status: 'blocked',
        scheduledFor: options.scheduledFor,
        blocker: 'certified_repair_not_active',
      }),
      assertReady: jest.fn(),
    };

    await expect(
      publishAnnualCommunesResource(publisher, readiness, options),
    ).rejects.toThrow(
      'Publication data.gouv historique bloquée pour 2026-08-05: certified_repair_not_active',
    );

    expect(publisher.createOrUpdateCommunesResource).not.toHaveBeenCalled();
    expect(readiness.assertReady).not.toHaveBeenCalled();
  });

  it('rejects a past-year archive outside the pinned certified history', async () => {
    const options = resolveAnnualCommunesPublicationOptions(
      '2025',
      undefined,
      new Date('2026-08-05T08:00:00.000Z'),
    );
    const publisher = {
      createOrUpdateCommunesResource: jest.fn(),
    };
    const readiness = createReadiness(options.scheduledFor);
    readiness.identity.historicFirstDate = '2026-01-01';

    await expect(
      publishAnnualCommunesResource(publisher, readiness.service, options),
    ).rejects.toThrow("ne couvre pas l'archive communes 2025");

    expect(publisher.createOrUpdateCommunesResource).not.toHaveBeenCalled();
    expect(readiness.service.assertReady).toHaveBeenCalledTimes(1);
  });

  it('fails when the certified boundary changes after the annual upload', async () => {
    const options = resolveAnnualCommunesPublicationOptions(
      '2025',
      undefined,
      new Date('2026-08-05T08:00:00.000Z'),
    );
    const publisher = {
      createOrUpdateCommunesResource: jest
        .fn()
        .mockResolvedValue('resource-2025'),
    };
    const readiness = createReadiness(options.scheduledFor);
    readiness.service.assertReady
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Historic export boundary changed'));

    await expect(
      publishAnnualCommunesResource(publisher, readiness.service, options),
    ).rejects.toThrow('Historic export boundary changed');

    expect(publisher.createOrUpdateCommunesResource).toHaveBeenCalledTimes(1);
    expect(readiness.service.assertReady).toHaveBeenCalledTimes(2);
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
