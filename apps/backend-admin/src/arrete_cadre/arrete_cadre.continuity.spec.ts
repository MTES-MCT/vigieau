import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ArreteCadreService } from './arrete_cadre.service';

const currentUser = { role: 'mte', role_departements: [] } as any;

function createArrete(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    numero: 'AC_200',
    dateDebut: '2026-07-01',
    dateFin: null,
    dateFinSaisie: null,
    dateFinCalculee: false,
    dateFinSaisieConnue: true,
    statut: 'publie',
    fichier: { id: 10, nom: 'arrete.pdf' },
    departements: [{ id: 65, code: '65' }],
    zonesAlerte: [],
    usages: [],
    arretesRestriction: [],
    arreteCadreAbroge: null,
    arretesCadre: [],
    ...overrides,
  } as unknown as ArreteCadre;
}

function createHarness() {
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
    save: jest.fn(async (value) => ({ ...value })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const manager = {
    getRepository: jest.fn(() => transactionRepository),
    query: jest.fn().mockResolvedValue([{ id: 65 }]),
  };
  const repository = {
    manager: {
      transaction: jest.fn(async (_isolation, callback) => callback(manager)),
    },
  };
  const arreteRestrictionService = {
    lockArreteRestrictionsForArreteCadres: jest.fn().mockResolvedValue([]),
    reconcileArreteRestrictionsForArreteCadres: jest.fn().mockResolvedValue([]),
    invalidateComputationsFromWithManager: jest
      .fn()
      .mockResolvedValue(undefined),
    enqueueCurrentZoneRecomputeWithManager: jest
      .fn()
      .mockResolvedValue(undefined),
    updateArreteRestrictionStatut: jest.fn().mockResolvedValue(undefined),
    requestCurrentZoneRecompute: jest.fn(),
    deleteByArreteCadreId: jest.fn().mockResolvedValue([]),
  };
  const usageService = {
    findByArreteCadre: jest.fn().mockResolvedValue([]),
    updateAllByArreteCadre: jest.fn().mockResolvedValue([]),
  };
  const arreteCadreZoneAlerteCommunesService = {
    updateAllByArreteCadre: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteCadreService(
    repository as any,
    arreteRestrictionService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { createImmutable: jest.fn(), deleteById: jest.fn() } as any,
    {} as any,
    usageService as any,
    arreteCadreZoneAlerteCommunesService as any,
    { get: jest.fn() } as any,
  );
  jest.spyOn(service, 'repercussionOnAr').mockResolvedValue(undefined);

  const lockIds = (ids: number[]) => {
    transactionRepository.find.mockResolvedValue(ids.map((id) => ({ id })));
    lockQuery.getMany.mockResolvedValue(ids.map((id) => ({ id })));
  };

  return {
    arreteCadreZoneAlerteCommunesService,
    arreteRestrictionService,
    lockIds,
    lockQuery,
    manager,
    repository,
    service,
    transactionRepository,
    usageService,
  };
}

describe('ArreteCadreService continuity entry points', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reactivates an expired framework when its calculated boundary moves forward', async () => {
    const harness = createHarness();
    const candidate = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      statut: 'abroge',
    });
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.lockIds([100]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(
      createArrete({
        ...candidate,
        dateFinSaisie: '2026-08-31',
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        arretesCadre: [{ id: 200, dateDebut: '2026-08-10', statut: 'a_venir' }],
      }),
    );

    await harness.service.updateArreteCadreStatut(false, {
      scheduledFor: '2026-08-04',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({
        dateFin: '2026-08-09',
        dateFinSaisie: '2026-08-31',
        dateFinCalculee: true,
        statut: 'publie',
      }),
    );
    expect(
      harness.arreteRestrictionService
        .reconcileArreteRestrictionsForArreteCadres,
    ).toHaveBeenCalledWith(harness.manager, [100], '2026-08-04', false);
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalledWith(harness.manager, '2026-07-01');
  });

  it('persists affected departments before continuing the legacy scheduled run', async () => {
    const harness = createHarness();
    const candidate = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      statut: 'abroge',
    });
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.lockIds([100]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(
      createArrete({
        ...candidate,
        dateFinSaisie: '2026-08-31',
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        arretesCadre: [{ id: 200, dateDebut: '2026-08-10', statut: 'a_venir' }],
      }),
    );

    await harness.service.updateArreteCadreStatut(false);

    expect(harness.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('arrete_cadre_departement'),
      [[100]],
    );
    expect(
      harness.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager,
    ).toHaveBeenCalledWith(harness.manager, [65]);
    expect(
      harness.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.arreteRestrictionService.updateArreteRestrictionStatut.mock
        .invocationCallOrder[0],
    );
  });

  it('keeps the framework published through its inclusive end date', async () => {
    const harness = createHarness();
    const candidate = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-04',
      statut: 'abroge',
    });
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.lockIds([100]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(candidate);

    await harness.service.updateArreteCadreStatut(false, {
      scheduledFor: '2026-08-04',
      sourceRevision: '42',
    });

    const statusSelectionSql =
      harness.transactionRepository.query.mock.calls[0][0];
    expect(statusSelectionSql).toContain(
      'framework_order."dateFin" < $1::date',
    );
    expect(statusSelectionSql).not.toContain(
      'framework_order."dateFin" <= $1::date',
    );
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({ dateFin: '2026-08-04', statut: 'publie' }),
    );
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
  });

  it('does not invalidate history for a normal start-of-day publication', async () => {
    const harness = createHarness();
    const candidate = createArrete({
      id: 100,
      dateDebut: '2026-08-04',
      dateFin: null,
      statut: 'a_venir',
    });
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.lockIds([100]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(candidate);

    await harness.service.updateArreteCadreStatut(false, {
      scheduledFor: '2026-08-04',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({ statut: 'publie' }),
    );
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
  });

  it('does not invalidate history for a normal end-of-day expiration', async () => {
    const harness = createHarness();
    const candidate = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-04',
      statut: 'publie',
    });
    harness.transactionRepository.query.mockResolvedValue([candidate]);
    harness.lockIds([100]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(candidate);

    await harness.service.updateArreteCadreStatut(false, {
      scheduledFor: '2026-08-05',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({ statut: 'abroge' }),
    );
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
  });

  it('does not write or reconcile frameworks when the scheduler has no candidate', async () => {
    const harness = createHarness();

    await harness.service.updateArreteCadreStatut(false, {
      scheduledFor: '2026-08-04',
      sourceRevision: '42',
    });

    expect(harness.transactionRepository.update).not.toHaveBeenCalled();
    expect(harness.transactionRepository.findOneOrFail).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService
        .reconcileArreteRestrictionsForArreteCadres,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.updateArreteRestrictionStatut,
    ).toHaveBeenCalledWith(null, false, {
      scheduledFor: '2026-08-04',
      sourceRevision: '42',
    });
  });

  it('reconciles the current, old and new predecessors when an active framework is updated', async () => {
    const harness = createHarness();
    const oldPredecessor = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-09',
      dateFinSaisie: '2026-12-31',
      dateFinCalculee: true,
      arretesCadre: [{ id: 200, dateDebut: '2026-08-10', statut: 'a_venir' }],
    });
    const current = createArrete({
      id: 200,
      dateDebut: '2026-08-10',
      statut: 'a_venir',
      arreteCadreAbroge: { id: 100 },
    });
    const newPredecessor = createArrete({
      id: 300,
      dateDebut: '2026-06-01',
    });
    let relinked = false;
    harness.lockIds([100, 200, 300]);
    harness.transactionRepository.save.mockImplementation(async (value) => {
      relinked = true;
      return { ...current, ...value };
    });
    harness.transactionRepository.findOneOrFail.mockImplementation(
      async ({ where: { id } }) => {
        if (id === 100) {
          return createArrete({
            ...oldPredecessor,
            arretesCadre: relinked ? [] : oldPredecessor.arretesCadre,
          });
        }
        if (id === 200) {
          return createArrete({
            ...current,
            arreteCadreAbroge: { id: relinked ? 300 : 100 },
          });
        }
        return createArrete({
          ...newPredecessor,
          arretesCadre: relinked
            ? [{ id: 200, dateDebut: '2026-08-10', statut: 'a_venir' }]
            : [],
        });
      },
    );
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(current);
    jest.spyOn(harness.service, 'canUpdateArreteCadre').mockResolvedValue(true);

    await harness.service.update(
      200,
      {
        numero: 'AC_200',
        departements: [{ id: 65 }],
        zonesAlerte: [],
        usages: [],
        arreteCadreAbroge: { id: 300 },
      },
      currentUser,
    );

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({
        dateFin: '2026-12-31',
        dateFinSaisie: null,
        dateFinCalculee: false,
        statut: 'publie',
      }),
    );
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 300 },
      expect.objectContaining({
        dateFin: '2026-08-09',
        dateFinCalculee: true,
        statut: 'publie',
      }),
    );
    expect(
      harness.arreteRestrictionService
        .reconcileArreteRestrictionsForArreteCadres,
    ).toHaveBeenCalledWith(harness.manager, [100, 200, 300], '2026-08-04');
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalledWith(harness.manager, '2026-06-01');
  });

  it('stores a manual inclusive end and reconciles restrictions when repealing', async () => {
    const harness = createHarness();
    const current = createArrete({ id: 200, statut: 'publie' });
    let repealed = false;
    harness.lockIds([200]);
    harness.transactionRepository.save.mockImplementation(async (value) => {
      repealed = true;
      return { ...current, ...value };
    });
    harness.transactionRepository.findOneOrFail.mockImplementation(async () =>
      createArrete({
        ...current,
        ...(repealed
          ? {
              dateFin: '2026-08-04',
              dateFinSaisie: null,
              dateFinCalculee: false,
              dateFinSaisieConnue: true,
              statut: 'publie',
            }
          : {}),
      }),
    );
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(current);
    jest.spyOn(harness.service, 'canRepealArreteCadre').mockResolvedValue(true);

    await harness.service.repeal(200, { dateFin: '2026-08-04' }, currentUser);

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 200,
        dateFin: '2026-08-04',
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
        statut: 'publie',
      }),
    );
    expect(harness.transactionRepository.update).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService
        .reconcileArreteRestrictionsForArreteCadres,
    ).toHaveBeenCalledWith(harness.manager, [200], '2026-08-04');
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalledWith(harness.manager, '2026-07-01');
  });

  it('restores and reactivates the predecessor after removing its successor', async () => {
    const harness = createHarness();
    const current = createArrete({
      id: 200,
      dateDebut: '2026-08-05',
      statut: 'a_venir',
      arreteCadreAbroge: { id: 100 },
    });
    const predecessor = createArrete({
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-04',
      dateFinSaisie: '2026-08-31',
      dateFinCalculee: true,
      statut: 'publie',
      arretesCadre: [{ id: 200, dateDebut: '2026-08-05', statut: 'a_venir' }],
    });
    let deleted = false;
    harness.lockIds([100, 200]);
    harness.transactionRepository.delete.mockImplementation(async () => {
      deleted = true;
      return { affected: 1 };
    });
    harness.transactionRepository.findOneOrFail.mockImplementation(
      async ({ where: { id } }) =>
        id === 200
          ? current
          : createArrete({
              ...predecessor,
              arretesCadre: deleted ? [] : predecessor.arretesCadre,
            }),
    );
    harness.arreteRestrictionService.deleteByArreteCadreId.mockResolvedValue([
      '2026-07-15',
    ]);
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(current);
    jest.spyOn(harness.service, 'canRemoveArreteCadre').mockResolvedValue(true);

    await harness.service.remove(200, currentUser);

    expect(harness.transactionRepository.delete).toHaveBeenCalledWith(200);
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({
        dateFin: '2026-08-31',
        dateFinSaisie: null,
        dateFinCalculee: false,
        statut: 'publie',
      }),
    );
    expect(
      harness.arreteRestrictionService.deleteByArreteCadreId,
    ).toHaveBeenCalledWith(200, harness.manager, '2026-08-04');
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalledWith(harness.manager, '2026-07-01');
  });

  it('deletes an undated draft without invalidating historical computations', async () => {
    const harness = createHarness();
    const draft = createArrete({
      id: 200,
      dateDebut: null,
      statut: 'a_valider',
    });
    harness.lockIds([200]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue(draft);
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(draft);
    jest.spyOn(harness.service, 'canRemoveArreteCadre').mockResolvedValue(true);

    await harness.service.remove(200, currentUser);

    expect(harness.transactionRepository.delete).toHaveBeenCalledWith(200);
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.updateArreteRestrictionStatut,
    ).not.toHaveBeenCalled();
  });
});
