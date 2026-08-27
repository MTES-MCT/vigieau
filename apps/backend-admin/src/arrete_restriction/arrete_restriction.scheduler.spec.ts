import { ArreteRestrictionService } from './arrete_restriction.service';

jest.mock('moment', () => {
  const moment = () => ({
    format: () => '2026-08-01T00:00:00.000Z',
    isBefore: () => false,
    startOf() {
      return this;
    },
  });
  return { __esModule: true, default: moment };
});

const createDeferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
};

const createService = (askCompute: jest.Mock) => {
  let queuedDepartementIds: number[] = [];
  const lockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const transactionRepository = {
    query: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => lockQuery),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const manager = {
    getRepository: jest.fn(() => transactionRepository),
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock_shared')) {
        return [];
      }
      if (sql.includes('SELECT id FROM departement')) {
        return [{ id: 65 }];
      }
      if (
        sql.includes('SELECT "publicRevision"') &&
        sql.includes('zone_publication_source_state')
      ) {
        return [{ publicRevision: '42' }];
      }
      if (
        sql.includes('UPDATE "zone_publication_source_state"') &&
        sql.includes('RETURNING "publicRevision"')
      ) {
        return [{ publicRevision: '43' }];
      }
      if (sql.includes('zone_type_availability')) {
        return [];
      }
      if (sql.includes('historic_backfill_department_revision')) {
        return [];
      }
      if (sql.includes('current_zone_recompute_request')) {
        queuedDepartementIds = [
          ...((parameters?.[0] as number[] | undefined) ?? []),
        ];
        return [];
      }
      if (sql.includes('information_schema.columns')) {
        return [{ exists: true }];
      }
      if (sql.includes('UPDATE "config"')) {
        return [{ id: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  const repository = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    manager: {
      transaction: jest.fn(async (_isolation, callback) => callback(manager)),
    },
  };
  const statisticDepartementService = {
    computeDepartementStatistics: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    repository as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { askCompute } as never,
    statisticDepartementService as never,
    undefined as never,
    { setConfig: jest.fn() } as never,
    undefined as never,
  );
  const processPendingCurrentZoneRecomputes = jest
    .spyOn(service, 'processPendingCurrentZoneRecomputes')
    .mockImplementation(async () => {
      await askCompute(queuedDepartementIds, false, false);
      await statisticDepartementService.computeDepartementStatistics();
      return 'processed';
    });
  return {
    lockQuery,
    manager,
    repository,
    service,
    processPendingCurrentZoneRecomputes,
    statisticDepartementService,
    transactionRepository,
  };
};

describe('ArreteRestrictionService scheduled status update', () => {
  it('does not complete before the zone computation does', async () => {
    const computation = createDeferred();
    const askCompute = jest.fn().mockReturnValue(computation.promise);
    const { service } = createService(askCompute);
    let completed = false;

    const update = service
      .updateArreteRestrictionStatut([{ id: 65 }] as never, true)
      .then(() => {
        completed = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(askCompute).toHaveBeenCalledWith([65], false, false);
    expect(completed).toBe(false);

    computation.resolve();
    await update;
    expect(completed).toBe(true);
  });

  it('does not select unknown legacy boundaries for date reconciliation', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const { service, transactionRepository } = createService(
      jest.fn().mockResolvedValue(undefined),
    );

    await service.updateArreteRestrictionStatut();

    const candidateQuery = transactionRepository.query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('expected_end.resolved_end'));
    expect(candidateQuery).toContain(
      'restriction_order."dateFinSaisieConnue" = true',
    );
  });

  it('reactivates a repealed restriction when its calculated boundary moves forward', async () => {
    const harness = createService(jest.fn().mockResolvedValue(undefined));
    const candidate = {
      id: 37577,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      statut: 'abroge',
    };
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...candidate,
      dateFinSaisie: '2026-08-31',
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      arreteRestrictionAbroge: null,
      arretesRestriction: [
        { id: 37578, dateDebut: '2026-08-10', statut: 'a_venir' },
      ],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await harness.service.updateArreteRestrictionStatut(undefined, false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({
        dateFin: '2026-08-09',
        dateFinSaisie: '2026-08-31',
        dateFinCalculee: true,
        statut: 'publie',
      }),
    );
  });

  it('reactivates a restriction after its framework order is reactivated', async () => {
    const harness = createService(jest.fn().mockResolvedValue(undefined));
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      id: 37577,
      dateDebut: '2011-06-07',
      dateFin: null,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      statut: 'abroge',
      arreteRestrictionAbroge: null,
      arretesRestriction: [],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await expect(
      harness.service.reconcileArreteRestrictionsForArreteCadres(
        harness.manager as never,
        [30697],
        '2026-08-05',
        false,
      ),
    ).resolves.toEqual([]);

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({ statut: 'publie' }),
    );
  });

  it('propagates a zone computation failure to the scheduled caller', async () => {
    const expectedError = new Error('zone computation failed');
    const askCompute = jest.fn().mockRejectedValue(expectedError);
    const { service } = createService(askCompute);

    await expect(service.updateArreteRestrictionStatut()).rejects.toBe(
      expectedError,
    );
  });

  it('does not issue status updates when no restriction changes status', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const { service, repository, transactionRepository } =
      createService(askCompute);

    await service.updateArreteRestrictionStatut();

    expect(repository.update).not.toHaveBeenCalled();
    expect(transactionRepository.update).not.toHaveBeenCalled();
  });

  it('persists the legacy recompute request before consuming it', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const { manager, processPendingCurrentZoneRecomputes, service } =
      createService(askCompute);

    await service.updateArreteRestrictionStatut([{ id: 65 }] as never, false);

    const enqueueCall = manager.query.mock.calls.find(([sql]) =>
      sql.includes('current_zone_recompute_request'),
    );
    const fenceCallIndex = manager.query.mock.calls.findIndex(([sql]) =>
      sql.includes('pg_advisory_xact_lock_shared'),
    );
    const enqueueCallIndex = manager.query.mock.calls.findIndex(([sql]) =>
      sql.includes('current_zone_recompute_request'),
    );
    const enqueueParameters = enqueueCall?.[1];
    expect(fenceCallIndex).toBeGreaterThanOrEqual(0);
    expect(manager.query.mock.calls[fenceCallIndex][1]).toEqual([
      'historic-map-publication-fence',
    ]);
    expect(fenceCallIndex).toBeLessThan(enqueueCallIndex);
    expect(enqueueParameters?.[0]).toEqual([65]);
    expect(enqueueParameters?.[1]).toBe('42');
    expect(enqueueParameters?.[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(enqueueParameters?.[2]).toBe(
      `CALCUL QUOTIDIEN ${enqueueParameters?.[3]}`,
    );
    expect(processPendingCurrentZoneRecomputes).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      processPendingCurrentZoneRecomputes.mock.invocationCallOrder[0],
    );
  });

  it('uses and forwards the scheduled legacy business date', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const {
      processPendingCurrentZoneRecomputes,
      service,
      transactionRepository,
    } = createService(askCompute);

    await service.updateArreteRestrictionStatut(
      undefined,
      false,
      undefined,
      '2026-08-01',
    );

    expect(transactionRepository.query.mock.calls[0][1]).toEqual([
      '2026-08-01',
      null,
    ]);
    expect(processPendingCurrentZoneRecomputes).toHaveBeenCalledWith(
      '2026-08-01',
    );
  });

  it('passes the daily publication reuse context only to the scheduled compute', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const { manager, processPendingCurrentZoneRecomputes, service } =
      createService(askCompute);
    const reuseContext = {
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
    };

    await service.updateArreteRestrictionStatut(undefined, false, reuseContext);

    expect(askCompute).toHaveBeenCalledWith(
      [],
      false,
      false,
      false,
      reuseContext,
    );
    expect(processPendingCurrentZoneRecomputes).not.toHaveBeenCalled();
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes('current_zone_recompute_request'),
      ),
    ).toBe(false);
  });

  it('ignores a framework end before the order start without moving its start', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const harness = createService(askCompute);
    const expiring = {
      id: 37577,
      dateDebut: '2026-08-10',
      dateFin: null,
      arretesCadre: [{ id: 30697, statut: 'abroge', dateFin: '2026-08-04' }],
    };
    harness.transactionRepository.query.mockResolvedValue([expiring]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...expiring,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      statut: 'a_venir',
      arreteRestrictionAbroge: null,
      arretesRestriction: [],
    });
    const reuseContext = {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    };

    await harness.service.updateArreteRestrictionStatut(
      undefined,
      false,
      reuseContext,
    );

    expect(harness.repository.manager.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(harness.lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({
        dateFin: null,
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
        statut: 'abroge',
      }),
    );
    expect(
      harness.transactionRepository.update.mock.calls[0][1],
    ).not.toHaveProperty('dateDebut');
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toBe(false);
  });

  it('invalidates history when a stale published order becomes expired', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const harness = createService(askCompute);
    const stale = {
      id: 37577,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      statut: 'publie',
    };
    harness.transactionRepository.query.mockResolvedValue([stale]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...stale,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      arreteRestrictionAbroge: null,
      arretesRestriction: [],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await harness.service.updateArreteRestrictionStatut(undefined, false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({
        dateFin: '2026-08-03',
        statut: 'abroge',
      }),
    );
    expect(
      harness.manager.query.mock.calls.find(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toEqual([expect.stringContaining('UPDATE "config"'), ['2026-07-01']]);
    const publicMutationCalls = harness.manager.query.mock.calls;
    const fenceCallIndexes = publicMutationCalls.flatMap(([sql], index) =>
      sql.includes('pg_advisory_xact_lock_shared') ? [index] : [],
    );
    const sourceRevisionCallIndex = publicMutationCalls.findIndex(([sql]) =>
      sql.includes('UPDATE "zone_publication_source_state"'),
    );
    const enqueueCallIndex = publicMutationCalls.findIndex(([sql]) =>
      sql.includes('current_zone_recompute_request'),
    );
    expect(fenceCallIndexes).toHaveLength(2);
    expect(
      fenceCallIndexes.map((index) => publicMutationCalls[index][1]),
    ).toEqual([
      ['historic-map-publication-fence'],
      ['historic-map-publication-fence'],
    ]);
    expect(fenceCallIndexes[0]).toBeLessThan(sourceRevisionCallIndex);
    expect(sourceRevisionCallIndex).toBeLessThan(fenceCallIndexes[1]);
    expect(fenceCallIndexes[1]).toBeLessThan(enqueueCallIndex);
  });

  it('reconciles a stale status without extending an unknown legacy end', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const harness = createService(askCompute);
    const stale = {
      id: 37577,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      statut: 'publie',
    };
    harness.transactionRepository.query.mockResolvedValue([stale]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...stale,
      dateFinSaisie: '2026-08-03',
      dateFinCalculee: true,
      dateFinSaisieConnue: false,
      arreteRestrictionAbroge: null,
      arretesRestriction: [
        { id: 37578, dateDebut: '2026-08-10', statut: 'a_venir' },
      ],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await harness.service.updateArreteRestrictionStatut(undefined, false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({
        dateFin: '2026-08-03',
        dateFinSaisie: '2026-08-03',
        dateFinCalculee: true,
        dateFinSaisieConnue: false,
        statut: 'abroge',
      }),
    );
  });

  it('does not invalidate history for a normal start-of-day publication', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const harness = createService(askCompute);
    const starting = {
      id: 37577,
      dateDebut: '2026-08-05',
      dateFin: null,
      statut: 'a_venir',
    };
    harness.transactionRepository.query.mockResolvedValue([starting]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...starting,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      arreteRestrictionAbroge: null,
      arretesRestriction: [],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await harness.service.updateArreteRestrictionStatut(undefined, false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({ statut: 'publie' }),
    );
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toBe(false);
  });

  it('does not invalidate history for a normal end-of-day expiration', async () => {
    const askCompute = jest.fn().mockResolvedValue({ success: true });
    const harness = createService(askCompute);
    const expiring = {
      id: 37577,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-04',
      statut: 'publie',
    };
    harness.transactionRepository.query.mockResolvedValue([expiring]);
    harness.transactionRepository.find.mockResolvedValue([{ id: 37577 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...expiring,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      arreteRestrictionAbroge: null,
      arretesRestriction: [],
      arretesCadre: [{ id: 30697, statut: 'publie', dateFin: null }],
    });

    await harness.service.updateArreteRestrictionStatut(undefined, false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37577 },
      expect.objectContaining({ statut: 'abroge' }),
    );
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toBe(false);
  });
});
