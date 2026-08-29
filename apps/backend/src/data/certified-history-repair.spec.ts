import {
  DataService,
  isCertifiedHistoryOverlayCompatible,
  statisticDeltaMaterializationStrategy,
} from './data.service';

const repairedState = {
  revision: '117',
  activePublicationId: 'active-zone-publication',
  currentPublishedDate: '2026-08-29',
  historicPublishedThrough: '2026-08-27',
  historicDirtyFrom: '2026-07-11',
  historicDirtyThrough: '2026-08-27',
  historicMapCursor: '2026-07-11',
  historicStatsCursor: '2026-07-11',
  sourceRevision: '168691',
  historicComputeEpoch: '784',
  certifiedHistoryRepairId: '08af493a-f250-4d58-a492-c886df244881',
  certifiedHistoryRepairFrom: '2026-07-11',
  certifiedHistoryRepairThrough: '2026-08-27',
  certifiedHistoryRepairSourceRunId: 'certified-backup-source-v1',
  certifiedHistoryRepairActivatedAt: '2026-08-29T04:00:00.000Z',
  certifiedHistoryRepairRevision: '117',
};

describe('certified statistic-only historic repair', () => {
  it('recognizes only a repair matching the complete current dirty window', () => {
    const service = Object.create(DataService.prototype) as any;
    expect(service.hasCertifiedHistoryRepair(repairedState)).toBe(true);
    expect(
      service.hasCertifiedHistoryRepair({
        ...repairedState,
        historicDirtyFrom: '2026-07-10',
      }),
    ).toBe(false);
    expect(
      service.isCertifiedHistoryRepairDate('2026-07-11', repairedState),
    ).toBe(true);
    expect(
      service.isCertifiedHistoryRepairDate('2026-07-10', repairedState),
    ).toBe(false);
  });

  it('builds a complete versioned overlay while leaving dirty metadata intact', async () => {
    const full = jest.fn().mockResolvedValue({ strategy: 'overlay' });
    const sparse = jest.fn();
    const delta = jest.fn();
    const service = {
      getStatisticCacheMode: () => 'versioned',
      hasCertifiedHistoryRepair: () => true,
      createFullArtifactCandidate: full,
      createSparseCurrentArtifactCandidate: sparse,
      createDeltaArtifactCandidate: delta,
    };
    const active = {
      identity: {
        mode: 'versioned',
        latestDate: '2026-08-29',
        historicDirtyFrom: '2026-07-11',
        historicStatsCursor: '2026-07-11',
        materializationStrategy: 'sparse-current',
      },
    };

    await (DataService.prototype as any).createArtifactCandidate.call(
      service,
      repairedState,
      active,
      {},
    );

    expect(full).toHaveBeenCalledWith(
      repairedState,
      'certified-history-overlay',
      {},
    );
    expect(sparse).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
  });

  it('allows repaired dirty months without marking maps complete', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = {
      publicationState: repairedState,
      dataSource: { query },
      getStatisticCacheMode: () => 'versioned',
      hasCertifiedHistoryRepair: () => true,
    };

    await (DataService.prototype as any).findUnavailableSnapshotMonths.call(
      service,
      repairedState,
    );

    expect(query.mock.calls[0][1]).toEqual([true, true]);
    expect(query.mock.calls[0][0]).toContain('AND NOT $2::boolean');
  });

  it('preserves the audited overlay identity across following daily deltas', () => {
    expect(
      statisticDeltaMaterializationStrategy(
        'certified-history-overlay',
        true,
        false,
        true,
      ),
    ).toBe('certified-history-overlay');
    expect(
      statisticDeltaMaterializationStrategy(
        'certified-history-overlay',
        false,
        false,
        true,
      ),
    ).toBe('daily-delta');
  });

  it('rejects overlays older than the active repair revision', () => {
    expect(
      isCertifiedHistoryOverlayCompatible(
        'certified-history-overlay',
        '116',
        true,
        '117',
      ),
    ).toBe(false);
    expect(
      isCertifiedHistoryOverlayCompatible(
        'certified-history-overlay',
        '118',
        true,
        '117',
      ),
    ).toBe(true);
    expect(
      isCertifiedHistoryOverlayCompatible(
        'certified-history-overlay',
        '118',
        false,
        null,
      ),
    ).toBe(false);
  });

  it('drops to sparse current when an overlay loses its exact audit', async () => {
    const sparse = jest.fn().mockResolvedValue({ strategy: 'sparse' });
    const full = jest.fn();
    const delta = jest.fn();
    const service = {
      getStatisticCacheMode: () => 'versioned',
      hasCertifiedHistoryRepair: () => false,
      createSparseCurrentArtifactCandidate: sparse,
      createFullArtifactCandidate: full,
      createDeltaArtifactCandidate: delta,
    };
    const active = {
      identity: { materializationStrategy: 'certified-history-overlay' },
    };

    await (DataService.prototype as any).createArtifactCandidate.call(
      service,
      {
        ...repairedState,
        certifiedHistoryRepairId: null,
      },
      active,
      {},
    );

    expect(sparse).toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
  });

  it('rebuilds the full overlay after a newer repair of the same range', async () => {
    const full = jest.fn().mockResolvedValue({ strategy: 'overlay' });
    const delta = jest.fn();
    const service = {
      getStatisticCacheMode: () => 'versioned',
      hasCertifiedHistoryRepair: () => true,
      createFullArtifactCandidate: full,
      createDeltaArtifactCandidate: delta,
    };
    const active = {
      identity: {
        materializationStrategy: 'certified-history-overlay',
        statisticRevision: '116',
        mode: 'versioned',
        latestDate: '2026-08-29',
        historicDirtyFrom: '2026-07-11',
        historicStatsCursor: '2026-07-11',
      },
    };

    await (DataService.prototype as any).createArtifactCandidate.call(
      service,
      repairedState,
      active,
      {},
    );

    expect(full).toHaveBeenCalledWith(
      repairedState,
      'certified-history-overlay',
      {},
    );
    expect(delta).not.toHaveBeenCalled();
  });

  it('does not reuse an in-memory overlay after repair invalidation', () => {
    const service = {
      isSamePublicationState: () => true,
      isStatisticArtifactCacheEnabled: () => true,
      isDistributedStatisticCacheEnabled: () => false,
      hasCertifiedHistoryRepair: () => false,
      isCertifiedOverlayInvalid: (DataService.prototype as any)
        .isCertifiedOverlayInvalid,
      getCertifiedCacheRepairId: (DataService.prototype as any)
        .getCertifiedCacheRepairId,
    };
    expect(
      (DataService.prototype as any).canReuseCertifiedCache.call(
        service,
        {
          publicationState: repairedState,
          artifactIdentity: {
            materializationStrategy: 'certified-history-overlay',
          },
        },
        { ...repairedState, certifiedHistoryRepairId: null },
      ),
    ).toBe(false);
  });

  it('adds a ledger exception to the direct commune history mask', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ stateAvailable: true, filtered_restrictions: [] }]);
    const service = Object.create(DataService.prototype) as any;
    service.statisticCommuneRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 10,
        commune: { id: 1, code: '77132', nom: 'Coupvray' },
      }),
    };
    service.dataSource = { query };

    await service.commune('77132');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('"certified_history_repair_audit" repair');
    expect(sql).toContain('repair."activationKind" = \'statistics-only\'');
    expect(sql).toContain('repair."historicComputeEpoch" =');
    expect(sql).toContain('repair."publicationRevisionAfter" <=');
    expect(sql).toContain('generate_series(');
    expect(sql).toContain('certified_snapshot."sourceRevision" IS NULL');
    expect(sql).toContain('certified_snapshot."certifiedHistoryRepairId"');
  });
});
