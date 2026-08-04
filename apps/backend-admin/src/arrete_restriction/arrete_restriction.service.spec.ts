import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ArreteRestrictionService } from './arrete_restriction.service';

const currentUser = {
  email: 'mte@example.test',
  role: 'mte',
  role_departements: [],
} as any;

function createArrete(overrides: Record<string, unknown> = {}) {
  return {
    id: 37577,
    numero: 'AP_7',
    dateDebut: '2026-08-04',
    dateFin: null,
    dateFinSaisie: null,
    dateFinCalculee: false,
    dateFinSaisieConnue: true,
    statut: 'a_venir',
    fichier: { id: 10, nom: 'arrete.pdf' },
    departement: { id: 53, code: '53' },
    restrictions: [],
    arretesCadre: [{ id: 30697, dateFin: null, statut: 'publie' }],
    arretesRestriction: [],
    arreteRestrictionAbroge: {
      id: 37487,
      numero: 'AP_6',
      dateDebut: '2026-07-28',
      dateFin: '2026-08-03',
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'abroge',
      arretesCadre: [{ id: 30697, dateFin: null, statut: 'publie' }],
      arretesRestriction: [],
    },
    ...overrides,
  } as unknown as ArreteRestriction;
}

function createHarness(
  options: {
    unknownPredecessor?: boolean;
    withoutPredecessor?: boolean;
    predecessorFrameworkEnd?: string;
    initialOverrides?: Record<string, unknown>;
    currentOverrides?: Record<string, unknown>;
  } = {},
) {
  const initial = createArrete({
    ...(options.withoutPredecessor ? { arreteRestrictionAbroge: null } : {}),
    ...options.initialOverrides,
  });
  const currentAfterSave = createArrete({
    dateDebut: '2026-08-05',
    statut: 'a_venir',
    arreteRestrictionAbroge: options.withoutPredecessor ? null : { id: 37487 },
    ...options.currentOverrides,
  });
  let persisted = false;
  const predecessor = createArrete({
    id: 37487,
    dateDebut: '2026-07-28',
    dateFin: '2026-08-03',
    dateFinSaisie: options.unknownPredecessor ? '2026-08-03' : null,
    dateFinCalculee: true,
    dateFinSaisieConnue: !options.unknownPredecessor,
    statut: 'abroge',
    arretesCadre: [
      {
        id: 30697,
        dateFin: options.predecessorFrameworkEnd ?? null,
        statut: options.predecessorFrameworkEnd ? 'abroge' : 'publie',
      },
    ],
    arreteRestrictionAbroge: null,
    arretesRestriction: [
      { id: 37577, dateDebut: '2026-08-05', statut: 'a_venir' },
    ],
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
          ? [{ id: 37577 }]
          : [{ id: 37487 }, { id: 37577 }],
      ),
  };
  const transactionRepository = {
    createQueryBuilder: jest.fn(() => lockQuery),
    find: jest
      .fn()
      .mockResolvedValue(
        options.withoutPredecessor
          ? [{ id: 37577 }]
          : [{ id: 37487 }, { id: 37577 }],
      ),
    findOneOrFail: jest.fn(async ({ where: { id } }) => {
      if (id === 37577) {
        return persisted ? currentAfterSave : initial;
      }
      if (id === 37487) {
        return predecessor;
      }
      throw new Error(`unexpected id ${id}`);
    }),
    save: jest.fn(async (value) => {
      persisted = true;
      return { ...value };
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const arreteCadreLockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([{ id: 30697 }]),
  };
  const arreteCadreRepository = {
    find: jest.fn().mockResolvedValue([
      {
        id: 30697,
        numero: 'AC-30697',
        dateDebut: '2026-01-01',
        dateFin: null,
        statut: 'publie',
        zonesAlerte: [],
      },
    ]),
    createQueryBuilder: jest.fn(() => arreteCadreLockQuery),
  };
  const manager = {
    getRepository: jest.fn((entity) =>
      entity === ArreteCadre ? arreteCadreRepository : transactionRepository,
    ),
    query: jest
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ id: 1 }]),
  };
  const repository = {
    manager: {
      transaction: jest.fn(async (_isolation, callback) => callback(manager)),
    },
  };
  const fichierService = {
    create: jest.fn(),
    createImmutable: jest.fn(),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    repository as any,
    {} as any,
    {} as any,
    {} as any,
    fichierService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { setConfig: jest.fn() } as any,
    { get: jest.fn() } as any,
  );
  const requestCurrentZoneRecompute = jest
    .spyOn(service, 'requestCurrentZoneRecompute')
    .mockImplementation(() => undefined);
  jest
    .spyOn(service, 'enqueueCurrentZoneRecomputeWithManager')
    .mockResolvedValue(undefined);
  jest.spyOn(service as any, 'checkModifications').mockResolvedValue(undefined);
  jest.spyOn(service, 'canUpdateArreteRestriction').mockResolvedValue(true);
  const checkBeforePublish = jest
    .spyOn(service, 'checkBeforePublish')
    .mockResolvedValue({ errors: [], warnings: [] });
  jest.spyOn(service, 'findOne').mockResolvedValue(initial);

  return {
    fichierService,
    checkBeforePublish,
    initial,
    lockQuery,
    manager,
    repository,
    requestCurrentZoneRecompute,
    service,
    transactionRepository,
  };
}

describe('ArreteRestrictionService.publish', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves the Mayenne predecessor within one serializable transaction', async () => {
    const harness = createHarness();

    await harness.service.publish(
      37577,
      null,
      { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
      currentUser,
    );

    expect(harness.repository.manager.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(harness.lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(harness.lockQuery.getMany).toHaveBeenCalledTimes(1);
    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 37577,
        dateDebut: '2026-08-05',
        dateFinSaisie: null,
        dateFinCalculee: false,
        statut: 'a_venir',
      }),
    );
    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37487 },
      expect.objectContaining({
        dateFin: '2026-08-04',
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        statut: 'publie',
      }),
    );
    expect(harness.manager.query).toHaveBeenCalledTimes(2);
    expect(harness.requestCurrentZoneRecompute).toHaveBeenCalledWith(
      [harness.initial.departement],
      'PUBLICATION AR',
    );
  });

  it('rejects a legacy extension whose original end is unknown', async () => {
    const harness = createHarness({ unknownPredecessor: true });

    await expect(
      harness.service.publish(
        37577,
        null,
        { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });

  it('ignores an AC end that predates the predecessor AR', async () => {
    const harness = createHarness({
      predecessorFrameworkEnd: '2026-07-01',
    });

    await harness.service.publish(
      37577,
      null,
      { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
      currentUser,
    );

    expect(harness.transactionRepository.update).toHaveBeenCalledWith(
      { id: 37487 },
      expect.objectContaining({
        dateFin: '2026-08-04',
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      }),
    );
  });

  it('keeps the old PDF when the database transaction fails', async () => {
    const harness = createHarness({ unknownPredecessor: true });
    harness.fichierService.createImmutable.mockResolvedValue({
      id: 20,
      nom: 'new.pdf',
    });

    await expect(
      harness.service.publish(
        37577,
        { originalname: 'new.pdf' } as any,
        { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.fichierService.deleteById).toHaveBeenCalledWith(20);
    expect(harness.fichierService.deleteById).not.toHaveBeenCalledWith(10);
  });

  it('normalizes accepted ISO timestamps before persistence', async () => {
    const harness = createHarness();

    await harness.service.publish(
      37577,
      null,
      {
        dateDebut: '2026-08-05T12:30:00.000Z',
        dateFin: null,
        dateSignature: null,
      },
      currentUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ dateDebut: '2026-08-05' }),
    );
  });

  it('keeps calculated provenance and does not invalidate history on an identical republication', async () => {
    const unchanged = {
      dateDebut: '2026-08-05',
      dateFin: '2026-08-10',
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'a_venir',
      arretesCadre: [{ id: 30697, dateFin: '2026-08-10', statut: 'publie' }],
    };
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: unchanged,
      currentOverrides: unchanged,
    });

    await harness.service.publish(
      37577,
      null,
      {
        dateDebut: '2026-08-05',
        dateFin: '2026-08-10',
        dateSignature: null,
      },
      currentUser,
    );

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFinSaisie: null,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
      }),
    );
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('replaces a PDF through an immutable key without breaking old snapshots', async () => {
    const harness = createHarness();
    harness.fichierService.createImmutable.mockResolvedValue({
      id: 20,
      nom: 'arrete.pdf',
    });

    await harness.service.publish(
      37577,
      { originalname: 'arrete.pdf' } as any,
      { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
      currentUser,
    );

    expect(harness.fichierService.createImmutable).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'arrete.pdf' }),
      'arrete-restriction/37577/',
    );
    expect(harness.fichierService.deleteById).not.toHaveBeenCalledWith(10);
  });

  it('rolls back when the business graph changes before the transactional recheck', async () => {
    const harness = createHarness();
    harness.checkBeforePublish
      .mockResolvedValueOnce({ errors: [], warnings: [] })
      .mockResolvedValueOnce({
        errors: ['linked framework changed'],
        warnings: [],
      });

    await expect(
      harness.service.publish(
        37577,
        null,
        { dateDebut: '2026-08-05', dateFin: null, dateSignature: null },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('rejects a republication that would overtake an existing successor', async () => {
    const harness = createHarness({
      withoutPredecessor: true,
      initialOverrides: {
        arretesRestriction: [
          {
            id: 37578,
            dateDebut: '2026-08-06',
            statut: 'a_venir',
            departement: { id: 53 },
          },
        ],
      },
    });
    harness.transactionRepository.find.mockResolvedValue([
      { id: 37577 },
      { id: 37578 },
    ]);
    harness.lockQuery.getMany.mockResolvedValue([{ id: 37577 }, { id: 37578 }]);

    await expect(
      harness.service.publish(
        37577,
        null,
        { dateDebut: '2026-08-07', dateFin: null, dateSignature: null },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });
});
