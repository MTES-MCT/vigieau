import {
  publishHistoricCommunesResource,
  resolveHistoricCommunesScheduledFor,
} from './publish-datagouv-historique-communes';

describe('publish-datagouv-historique-communes safeguards', () => {
  const scheduledFor = '2026-08-31';
  const identity = {
    publicationMode: 'versioned' as const,
    publicationId: 'zone-publication-1',
    sourceRevision: '168693',
    materializationVersion: 4,
    statisticCachePublicationId: 'statistic-publication-1',
    statisticRevision: '120',
    statisticPublishedDate: scheduledFor,
    statisticFingerprint: 'a'.repeat(64),
    historicFirstDate: '2013-01-01',
    historicLatestDate: scheduledFor,
    historicDateCount: 4_991,
    historicComputeEpoch: '785',
    historicReadinessMode: 'certified-repair' as const,
    certifiedHistoryRepairId: 'repair-1',
    certifiedHistoryRepairAttestationId: 'attestation-1',
  };

  function createReadiness() {
    return {
      evaluate: jest.fn().mockResolvedValue({
        status: 'ready',
        scheduledFor,
        identity,
      }),
      assertReady: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('uses the previous Paris civil date before the 06:00 boundary', () => {
    expect(
      resolveHistoricCommunesScheduledFor(new Date('2026-08-31T03:59:00.000Z')),
    ).toBe('2026-08-30');
    expect(
      resolveHistoricCommunesScheduledFor(new Date('2026-08-31T04:00:00.000Z')),
    ).toBe('2026-08-31');
  });

  it('does not publish when historic export readiness is blocked', async () => {
    const publisher = { updateHistoriqueCommunes: jest.fn() };
    const readiness = {
      evaluate: jest.fn().mockResolvedValue({
        status: 'blocked',
        scheduledFor,
        blocker: 'sparse_statistic_cache',
      }),
      assertReady: jest.fn(),
    };

    await expect(
      publishHistoricCommunesResource(publisher, readiness, scheduledFor),
    ).rejects.toThrow(
      'Publication data.gouv historique bloquée pour 2026-08-31: sparse_statistic_cache',
    );

    expect(publisher.updateHistoriqueCommunes).not.toHaveBeenCalled();
    expect(readiness.assertReady).not.toHaveBeenCalled();
  });

  it('publishes only the pinned certified historic identity', async () => {
    const publisher = {
      updateHistoriqueCommunes: jest.fn().mockResolvedValue(undefined),
    };
    const readiness = createReadiness();

    await expect(
      publishHistoricCommunesResource(publisher, readiness, scheduledFor),
    ).resolves.toBeUndefined();

    expect(readiness.evaluate).toHaveBeenCalledWith(scheduledFor);
    expect(readiness.assertReady).toHaveBeenNthCalledWith(1, identity);
    expect(publisher.updateHistoriqueCommunes).toHaveBeenCalledWith(
      identity.statisticPublishedDate,
      identity.sourceRevision,
      identity.historicFirstDate,
    );
    expect(readiness.assertReady).toHaveBeenNthCalledWith(2, identity);
    expect(readiness.assertReady.mock.invocationCallOrder[0]).toBeLessThan(
      publisher.updateHistoriqueCommunes.mock.invocationCallOrder[0],
    );
    expect(
      publisher.updateHistoriqueCommunes.mock.invocationCallOrder[0],
    ).toBeLessThan(readiness.assertReady.mock.invocationCallOrder[1]);
  });

  it('fails when the certified boundary changes after publication', async () => {
    const publisher = {
      updateHistoriqueCommunes: jest.fn().mockResolvedValue(undefined),
    };
    const readiness = createReadiness();
    readiness.assertReady
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Historic export boundary changed'));

    await expect(
      publishHistoricCommunesResource(publisher, readiness, scheduledFor),
    ).rejects.toThrow('Historic export boundary changed');

    expect(publisher.updateHistoriqueCommunes).toHaveBeenCalledTimes(1);
    expect(readiness.assertReady).toHaveBeenCalledTimes(2);
  });
});
