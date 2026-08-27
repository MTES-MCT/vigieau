import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { Departement } from '@shared/entities/departement.entity';
import { ArreteCadreService } from './arrete_cadre.service';

const currentUser = { role: 'mte', role_departements: [] } as any;

function createArrete(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    numero: 'AC_2',
    dateDebut: '2026-08-04',
    dateFin: null,
    dateFinSaisie: null,
    dateFinCalculee: false,
    dateFinSaisieConnue: true,
    statut: 'a_venir',
    fichier: { id: 10, nom: 'arrete.pdf' },
    departements: [{ id: 53, code: '53' }],
    zonesAlerte: [],
    arretesRestriction: [],
    arretesCadre: [],
    arreteCadreAbroge: {
      id: 100,
      dateDebut: '2026-07-01',
      dateFin: '2026-08-03',
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'abroge',
    },
    ...overrides,
  } as unknown as ArreteCadre;
}

function createHarness(
  options: {
    withoutPredecessor?: boolean;
    initialOverrides?: Record<string, unknown>;
    currentOverrides?: Record<string, unknown>;
  } = {},
) {
  const initial = createArrete({
    ...(options.withoutPredecessor ? { arreteCadreAbroge: null } : {}),
    ...options.initialOverrides,
  });
  const currentAfterSave = createArrete({
    dateDebut: '2026-08-05',
    statut: 'a_venir',
    arreteCadreAbroge: options.withoutPredecessor ? null : { id: 100 },
    ...options.currentOverrides,
  });
  let persisted = false;
  const predecessor = createArrete({
    id: 100,
    dateDebut: '2026-07-01',
    dateFin: '2026-08-03',
    dateFinSaisie: null,
    dateFinCalculee: true,
    dateFinSaisieConnue: true,
    statut: 'abroge',
    arreteCadreAbroge: null,
    arretesCadre: [{ id: 200, dateDebut: '2026-08-05', statut: 'a_venir' }],
  });
  const lockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest
      .fn()
      .mockResolvedValue(
        options.withoutPredecessor
          ? [{ id: 200 }, { id: 201 }]
          : [{ id: 100 }, { id: 200 }],
      ),
  };
  const transactionRepository = {
    find: jest
      .fn()
      .mockResolvedValue(
        options.withoutPredecessor
          ? [{ id: 200 }, { id: 201 }]
          : [{ id: 100 }, { id: 200 }],
      ),
    createQueryBuilder: jest.fn(() => lockQuery),
    findOneOrFail: jest.fn(async ({ where: { id } }) =>
      id === 200 ? (persisted ? currentAfterSave : initial) : predecessor,
    ),
    save: jest.fn(async (value) => {
      persisted = true;
      return { ...value };
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const manager = { getRepository: jest.fn(() => transactionRepository) };
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
    recordPublicMutation: jest.fn().mockResolvedValue('43'),
    updateArreteRestrictionStatut: jest.fn().mockResolvedValue(undefined),
    requestCurrentZoneRecompute: jest.fn(),
  };
  const fichierService = {
    createImmutable: jest.fn(),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const restrictionService = {
    deleteZonesByArreteCadreId: jest.fn().mockResolvedValue(undefined),
  };
  const usageService = {
    findByArreteCadre: jest.fn().mockResolvedValue([]),
    updateAllByArreteCadre: jest.fn().mockResolvedValue([]),
    updateUsagesArByArreteCadreId: jest.fn().mockResolvedValue(undefined),
    deleteUsagesArByArreteCadreId: jest.fn().mockResolvedValue(undefined),
  };
  const arreteCadreZoneAlerteCommunesService = {
    updateAllByArreteCadre: jest.fn().mockResolvedValue([]),
  };
  const service = new ArreteCadreService(
    repository as any,
    arreteRestrictionService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    fichierService as any,
    restrictionService as any,
    usageService as any,
    arreteCadreZoneAlerteCommunesService as any,
    { get: jest.fn() } as any,
  );
  jest.spyOn(service, 'canUpdateArreteCadre').mockResolvedValue(true);
  jest.spyOn(service, 'findOne').mockResolvedValue(initial);

  return {
    arreteRestrictionService,
    fichierService,
    initial,
    lockQuery,
    repository,
    restrictionService,
    service,
    transactionRepository,
    usageService,
  };
}

describe('ArreteCadreService.publish', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves a known predecessor and reconciles its restriction orders', async () => {
    const harness = createHarness();

    await harness.service.publish(
      200,
      null,
      { dateDebut: '2026-08-05', dateFin: null },
      currentUser,
    );

    expect(harness.repository.manager.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(harness.lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(
      harness.arreteRestrictionService.lockArreteRestrictionsForArreteCadres
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.transactionRepository.save.mock.invocationCallOrder[0],
    );
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      expect.objectContaining({ dateFin: '2026-08-04', statut: 'publie' }),
    );
    expect(
      harness.arreteRestrictionService
        .reconcileArreteRestrictionsForArreteCadres,
    ).toHaveBeenCalledWith(expect.anything(), [200, 100], '2026-08-04');
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalled();
  });

  it('keeps an arrete active through its inclusive end date', async () => {
    const harness = createHarness();
    const current = createArrete({
      dateDebut: '2026-08-01',
      dateFin: '2026-08-04',
      arreteCadreAbroge: null,
    });
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(current);
    harness.transactionRepository.find.mockResolvedValue([{ id: 200 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 200 }]);
    harness.transactionRepository.findOneOrFail.mockResolvedValue({
      ...current,
      arretesCadre: [],
    } as ArreteCadre);

    await harness.service.publish(
      200,
      null,
      { dateDebut: '2026-08-01', dateFin: '2026-08-04' },
      currentUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ statut: 'publie' }),
    );
  });

  it('keeps calculated provenance and avoids historic invalidation on an identical republication', async () => {
    const unchanged = {
      dateDebut: '2026-08-05',
      dateFin: '2026-08-10',
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'a_venir',
      arretesCadre: [
        {
          id: 201,
          dateDebut: '2026-08-11',
          statut: 'a_venir',
          departements: [{ id: 53 }],
        },
      ],
    };
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: unchanged,
      currentOverrides: unchanged,
    });

    await harness.service.publish(
      200,
      null,
      { dateDebut: '2026-08-05', dateFin: '2026-08-10' },
      currentUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      }),
    );
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.recordPublicMutation,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.requestCurrentZoneRecompute,
    ).not.toHaveBeenCalled();
  });

  it('records a changed legal end without invalidating an unchanged effective period', async () => {
    const successor = {
      id: 201,
      dateDebut: '2026-08-11',
      statut: 'a_venir',
      departements: [{ id: 53 }],
    };
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: {
        dateDebut: '2026-08-05',
        dateFin: '2026-08-10',
        dateFinSaisie: '2026-08-20',
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        statut: 'a_venir',
        arretesCadre: [successor],
      },
      currentOverrides: {
        dateDebut: '2026-08-05',
        dateFin: '2026-08-31',
        dateFinSaisie: null,
        dateFinCalculee: false,
        dateFinSaisieConnue: true,
        statut: 'a_venir',
        arretesCadre: [successor],
      },
    });

    await harness.service.publish(
      200,
      null,
      { dateDebut: '2026-08-05', dateFin: '2026-08-31' },
      currentUser,
    );

    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.recordPublicMutation,
    ).toHaveBeenCalledWith(expect.anything(), [53], 'PUBLICATION AC');
    expect(
      harness.arreteRestrictionService.requestCurrentZoneRecompute,
    ).toHaveBeenCalledWith(harness.initial.departements, 'PUBLICATION AC');
  });

  it('ignores a no-op PATCH on a published framework order', async () => {
    const unchanged = {
      dateDebut: '2026-08-05',
      statut: 'a_venir',
      arreteCadreAbroge: null,
      usages: [],
    };
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: unchanged,
      currentOverrides: unchanged,
    });
    harness.transactionRepository.find.mockResolvedValue([{ id: 200 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 200 }]);

    await harness.service.update(
      200,
      {
        numero: 'AC_2',
        departements: [{ id: 53 }],
        zonesAlerte: [],
        usages: [],
        arreteCadreAbroge: null,
      } as any,
      currentUser,
    );

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.recordPublicMutation,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.requestCurrentZoneRecompute,
    ).not.toHaveBeenCalled();
  });

  it('records and invalidates a real PATCH on a published framework order', async () => {
    const unchanged = {
      dateDebut: '2026-08-05',
      statut: 'a_venir',
      arreteCadreAbroge: null,
      usages: [],
    };
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: unchanged,
      currentOverrides: unchanged,
    });
    harness.transactionRepository.find.mockResolvedValue([{ id: 200 }]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 200 }]);

    await harness.service.update(
      200,
      {
        numero: 'AC_2-modifie',
        departements: [{ id: 53 }],
        zonesAlerte: [],
        usages: [],
        arreteCadreAbroge: null,
      } as any,
      currentUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalledWith(expect.anything(), '2026-08-05');
    expect(
      harness.arreteRestrictionService.recordPublicMutation,
    ).toHaveBeenCalledWith(expect.anything(), [53, 53], 'MODIFICATION AC');
    expect(
      harness.arreteRestrictionService.requestCurrentZoneRecompute,
    ).toHaveBeenCalledWith(
      [{ id: 53, code: '53' }, { id: 53 }],
      'MODIFICATION AC',
    );
  });

  it('keeps the previous PDF object available to existing publication snapshots', async () => {
    const harness = createHarness();
    harness.fichierService.createImmutable.mockResolvedValue({
      id: 20,
      nom: 'arrete.pdf',
    });

    await harness.service.publish(
      200,
      { originalname: 'arrete.pdf' } as any,
      { dateDebut: '2026-08-05', dateFin: null },
      currentUser,
    );

    expect(harness.fichierService.createImmutable).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'arrete.pdf' }),
      'arrete-cadre/200/',
    );
    expect(harness.fichierService.deleteById).not.toHaveBeenCalledWith(10);
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).toHaveBeenCalled();
  });

  it('rejects a republication that would overtake an existing successor', async () => {
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: {
        arretesCadre: [
          {
            id: 201,
            dateDebut: '2026-08-06',
            statut: 'a_venir',
            departements: [{ id: 53 }],
          },
        ],
      },
    });

    await expect(
      harness.service.publish(
        200,
        null,
        { dateDebut: '2026-08-07', dateFin: null },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
  });

  it('rejects moving a framework outside its existing successor scope', async () => {
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: {
        arretesCadre: [
          {
            id: 201,
            dateDebut: '2026-08-11',
            statut: 'a_venir',
            departements: [{ id: 53 }],
          },
        ],
      },
    });

    await expect(
      harness.service.update(
        200,
        {
          departements: [{ id: 65 }],
          zonesAlerte: [],
          usages: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(
      harness.arreteRestrictionService.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
  });
});

describe('ArreteCadreService target department authorization', () => {
  const departementUser = {
    role: 'departement',
    role_departements: ['53'],
  } as any;

  function createAuthorizationHarness(
    transactionDepartements: Array<{ id: number; code: string }> = [
      { id: 53, code: '53' },
      { id: 65, code: '65' },
    ],
  ) {
    const departements = new Map([
      [53, { id: 53, code: '53', nom: 'Mayenne' }],
      [65, { id: 65, code: '65', nom: 'Hautes-Pyrénées' }],
    ]);
    const transactionRepository = {
      save: jest.fn(async (value) => ({ id: 200, ...value })),
    };
    const transactionDepartementRepository = {
      find: jest.fn().mockResolvedValue(transactionDepartements),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Departement
          ? transactionDepartementRepository
          : transactionRepository,
      ),
    };
    const repository = {
      manager: {
        transaction: jest.fn(async (_isolation, callback) => callback(manager)),
      },
    };
    const departementService = {
      find: jest.fn(async (id) => departements.get(id)),
    };
    const usageService = {
      updateAllByArreteCadre: jest.fn().mockResolvedValue([]),
    };
    const arreteCadreZoneAlerteCommunesService = {
      updateAllByArreteCadre: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ArreteCadreService(
      repository as any,
      {
        lockArreteRestrictionsForArreteCadres: jest.fn(),
      } as any,
      departementService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      usageService as any,
      arreteCadreZoneAlerteCommunesService as any,
      { get: jest.fn() } as any,
    );
    jest
      .spyOn(service as any, 'sendAciMails')
      .mockImplementation(() => undefined);

    return {
      departementService,
      repository,
      service,
      transactionDepartementRepository,
      transactionRepository,
    };
  }

  it('rejects creating a single-department framework outside the user scope', async () => {
    const harness = createAuthorizationHarness();

    await expect(
      harness.service.create(
        {
          numero: 'AC-65',
          departements: [{ id: 65 }],
          zonesAlerte: [],
          usages: [],
        } as any,
        departementUser,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(harness.repository.manager.transaction).not.toHaveBeenCalled();
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
  });

  it('rejects creating an ACI led by a department outside the user scope', async () => {
    const harness = createAuthorizationHarness();

    await expect(
      harness.service.create(
        {
          numero: 'ACI-65-53',
          departements: [{ id: 65 }, { id: 53 }],
          zonesAlerte: [],
          usages: [],
        } as any,
        departementUser,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(harness.repository.manager.transaction).not.toHaveBeenCalled();
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
  });

  it('rechecks an update target inside the transaction before saving', async () => {
    const harness = createAuthorizationHarness([{ id: 65, code: '65' }]);
    const current = createArrete({
      statut: 'a_valider',
      arreteCadreAbroge: null,
    });
    harness.departementService.find.mockResolvedValue({
      id: 65,
      code: '53',
      nom: 'Preflight value',
    });
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(current);
    jest.spyOn(harness.service, 'canUpdateArreteCadre').mockResolvedValue(true);
    jest
      .spyOn(harness.service as any, 'lockArreteCadreGraph')
      .mockResolvedValue(undefined);
    jest
      .spyOn(harness.service as any, 'findOneForContinuity')
      .mockResolvedValue(current);
    jest
      .spyOn(harness.service as any, 'findOneForMutationAuthorization')
      .mockResolvedValue(current);

    await expect(
      harness.service.update(
        200,
        {
          numero: 'AC-65',
          departements: [{ id: 65 }],
          zonesAlerte: [],
          usages: [],
        } as any,
        departementUser,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(harness.transactionDepartementRepository.find).toHaveBeenCalled();
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
  });

  it('allows an authorized pilot to invite another department to an ACI', async () => {
    const harness = createAuthorizationHarness();

    await harness.service.create(
      {
        numero: 'ACI-53-65',
        departements: [{ id: 53 }, { id: 65 }],
        zonesAlerte: [],
        usages: [],
      } as any,
      departementUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        departementPilote: expect.objectContaining({ id: 53 }),
        departements: [{ id: 53 }, { id: 65 }],
      }),
    );
  });
});
