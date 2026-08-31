import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { Departement } from '@shared/entities/departement.entity';
import { ArreteRestrictionService } from './arrete_restriction.service';

const currentUser = {
  email: 'mte@example.test',
  role: 'mte',
  role_departements: [],
} as any;

const ddt53User = {
  email: 'ddt53@example.test',
  role: 'departement',
  role_departements: ['53'],
} as any;

interface MutableArreteState {
  id: number;
  dateDebut: string | null;
  dateFin: string | null;
  dateFinSaisie: string | null;
  dateFinCalculee: boolean;
  dateFinSaisieConnue: boolean;
  statut: 'a_valider' | 'a_venir' | 'publie' | 'abroge';
  predecessorId?: number;
}

function createState(
  id: number,
  overrides: Partial<MutableArreteState> = {},
): MutableArreteState {
  return {
    id,
    dateDebut: '2026-07-01',
    dateFin: null,
    dateFinSaisie: null,
    dateFinCalculee: false,
    dateFinSaisieConnue: true,
    statut: 'publie',
    ...overrides,
  };
}

function copyStates(states: Map<number, MutableArreteState>) {
  return new Map(
    [...states.entries()].map(([id, state]) => [id, { ...state }]),
  );
}

function restoreStates(
  states: Map<number, MutableArreteState>,
  snapshot: Map<number, MutableArreteState>,
) {
  states.clear();
  for (const [id, state] of snapshot) {
    states.set(id, { ...state });
  }
}

function toEntity(
  state: MutableArreteState,
  states: Map<number, MutableArreteState>,
): ArreteRestriction {
  return {
    ...state,
    numero: `AR-${state.id}`,
    departement: { id: 53, code: '53' },
    fichier: { id: state.id, nom: `${state.id}.pdf` },
    restrictions: [],
    arretesCadre: [{ id: 10, dateFin: null, statut: 'publie' }],
    arreteRestrictionAbroge: state.predecessorId
      ? { id: state.predecessorId }
      : null,
    arretesRestriction: [...states.values()]
      .filter((candidate) => candidate.predecessorId === state.id)
      .map((successor) => ({
        id: successor.id,
        dateDebut: successor.dateDebut,
        statut: successor.statut,
        departement: { id: 53 },
      })),
  } as unknown as ArreteRestriction;
}

function createHarness(initialStates: MutableArreteState[], targetId: number) {
  const states = new Map(
    initialStates.map((state) => [state.id, { ...state }]),
  );
  let transactionRolledBack = false;

  const lockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () =>
      [...states.values()].map(({ id }) => ({ id })),
    ),
  };
  const transactionRepository = {
    createQueryBuilder: jest.fn(() => lockQuery),
    find: jest.fn(async () => [...states.values()].map(({ id }) => ({ id }))),
    findOneOrFail: jest.fn(async ({ where: { id } }) => {
      const state = states.get(id);
      if (!state) {
        throw new Error(`unexpected id ${id}`);
      }
      return toEntity(state, states);
    }),
    save: jest.fn(async (value) => {
      const state = states.get(value.id);
      if (!state) {
        throw new Error(`unexpected id ${value.id}`);
      }
      const hasPredecessor = Object.prototype.hasOwnProperty.call(
        value,
        'arreteRestrictionAbroge',
      );
      Object.assign(state, value);
      if (hasPredecessor) {
        state.predecessorId = value.arreteRestrictionAbroge?.id;
      }
      return toEntity(state, states);
    }),
    update: jest.fn(async (criteria, update) => {
      if (typeof criteria.id === 'number') {
        const state = states.get(criteria.id);
        if (!state) {
          return { affected: 0 };
        }
        Object.assign(state, update);
        return { affected: 1 };
      }
      const predecessorId = criteria.arreteRestrictionAbroge?.id;
      let affected = 0;
      if (typeof predecessorId === 'number') {
        for (const state of states.values()) {
          if (state.predecessorId === predecessorId) {
            state.predecessorId = undefined;
            affected += 1;
          }
        }
      }
      return { affected };
    }),
    delete: jest.fn(async (id) => ({ affected: states.delete(id) ? 1 : 0 })),
  };
  const arreteCadreLockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([{ id: 10 }]),
  };
  const arreteCadreRepository = {
    find: jest.fn().mockResolvedValue([
      {
        id: 10,
        numero: 'AC-10',
        dateDebut: '2026-01-01',
        dateFin: null,
        statut: 'publie',
        zonesAlerte: [],
      },
    ]),
    createQueryBuilder: jest.fn(() => arreteCadreLockQuery),
  };
  const departementRepository = {
    findOne: jest.fn(async ({ where: { id } }) =>
      id ? { id, code: id === 53 ? '53' : '75' } : null,
    ),
  };
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === ArreteCadre) {
        return arreteCadreRepository;
      }
      if (entity === Departement) {
        return departementRepository;
      }
      return transactionRepository;
    }),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('record_historic_compute_invalidation')) {
        return [
          {
            historicComputeEpoch: '8',
            computeMapDate: '2026-07-01',
            computeStatsDate: '2026-07-01',
            changed: true,
          },
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  const repository = {
    manager: {
      transaction: jest.fn(async (_isolation, callback) => {
        const snapshot = copyStates(states);
        try {
          return await callback(manager);
        } catch (error) {
          transactionRolledBack = true;
          restoreStates(states, snapshot);
          throw error;
        }
      }),
    },
  };
  const restrictionService = {
    updateAll: jest.fn().mockResolvedValue([]),
  };
  const mailService = {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  };
  const configService = {
    setConfig: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArreteRestrictionService(
    repository as any,
    {} as any,
    {} as any,
    restrictionService as any,
    {} as any,
    {} as any,
    mailService as any,
    {} as any,
    {} as any,
    {} as any,
    configService as any,
    { get: jest.fn() } as any,
  );
  const requestCurrentZoneRecompute = jest
    .spyOn(service, 'requestCurrentZoneRecompute')
    .mockImplementation(() => undefined);
  jest
    .spyOn(service, 'enqueueCurrentZoneRecomputeWithManager')
    .mockResolvedValue(undefined);
  const invalidateComputationsFromWithManager = jest.spyOn(
    service,
    'invalidateComputationsFromWithManager',
  );
  const recordPublicMutation = jest
    .spyOn(service, 'recordPublicMutation')
    .mockResolvedValue('43');
  const synchronizeArreteRestrictionEndDate = jest.spyOn(
    service as any,
    'synchronizeArreteRestrictionEndDate',
  );
  const checkModifications = jest
    .spyOn(service as any, 'checkModifications')
    .mockResolvedValue(undefined);
  jest.spyOn(service, 'canUpdateArreteRestriction').mockResolvedValue(true);
  jest.spyOn(service, 'canRepealArreteRestriction').mockResolvedValue(true);
  jest.spyOn(service, 'canRemoveArreteRestriction').mockResolvedValue(true);
  jest
    .spyOn(service, 'checkBeforePublish')
    .mockResolvedValue({ errors: [], warnings: [] });
  jest.spyOn(service, 'findOne').mockImplementation(async () => {
    const state = states.get(targetId);
    if (!state) {
      throw new Error(`unexpected id ${targetId}`);
    }
    return toEntity(state, states);
  });

  return {
    checkModifications,
    configService,
    departementRepository,
    get transactionRolledBack() {
      return transactionRolledBack;
    },
    lockQuery,
    manager,
    mailService,
    invalidateComputationsFromWithManager,
    recordPublicMutation,
    repository,
    requestCurrentZoneRecompute,
    restrictionService,
    service,
    states,
    synchronizeArreteRestrictionEndDate,
    transactionRepository,
  };
}

describe('ArreteRestrictionService chain mutations', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('préserve les restrictions sur un PATCH scalaire qui les omet', async () => {
    const harness = createHarness(
      [createState(300, { statut: 'a_valider' })],
      300,
    );

    await harness.service.update(
      300,
      { numero: 'AR renommé' } as any,
      currentUser,
    );

    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 300, numero: 'AR renommé' }),
    );
  });

  it('notifies a published update without reopening historic cursors twice', async () => {
    const harness = createHarness([createState(300)], 300);
    harness.checkModifications.mockRestore();
    const oldAr = toEntity(harness.states.get(300)!, harness.states);
    const updatedAr = { ...oldAr, numero: 'AR-300-modified' };

    await (harness.service as any).checkModifications(
      oldAr,
      updatedAr,
      currentUser,
    );

    expect(harness.mailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(harness.configService.setConfig).not.toHaveBeenCalled();
  });

  it('keeps a committed published update when its notification fails', async () => {
    const harness = createHarness([createState(300)], 300);
    harness.checkModifications.mockRejectedValueOnce(
      new Error('mail unavailable'),
    );
    const loggerError = jest
      .spyOn((harness.service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(
      harness.service.update(
        300,
        { numero: 'AR-300-modified' } as any,
        currentUser,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 300 }));
    await Promise.resolve();

    expect(harness.recordPublicMutation).toHaveBeenCalledWith(
      harness.manager,
      [53, 53],
      'MODIFICATION AR',
    );
    expect(harness.invalidateComputationsFromWithManager).toHaveBeenCalledWith(
      harness.manager,
      '2026-07-01',
    );
    expect(harness.requestCurrentZoneRecompute).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      'ERREUR NOTIFICATION MODIFICATION AR',
      expect.objectContaining({ message: 'mail unavailable' }),
    );
  });

  it('ignores a no-op PATCH on a published restriction order', async () => {
    const harness = createHarness([createState(300)], 300);

    await harness.service.update(300, { numero: 'AR-300' } as any, currentUser);

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(
      harness.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(harness.recordPublicMutation).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });

  it('returns restriction usages after a full no-op PATCH from the frontend', async () => {
    const harness = createHarness([createState(300)], 300);
    const usage = {
      id: 40,
      nom: 'Arrosage des jardins',
      thematique: { id: 4, nom: 'Arrosage' },
      concerneParticulier: true,
      concerneEntreprise: false,
      concerneCollectivite: false,
      concerneExploitation: false,
      concerneEso: true,
      concerneEsu: false,
      concerneAep: false,
      descriptionVigilance: null,
      descriptionAlerte: 'Interdit de 8 h a 20 h',
      descriptionAlerteRenforcee: 'Interdit',
      descriptionCrise: 'Interdit',
    };
    const persistedRestriction = {
      id: 20,
      nomGroupementAep: null,
      zoneAlerte: { id: 7, code: 'ZA-7', nom: 'Zone 7' },
      arreteCadre: { id: 10 },
      niveauGravite: 'alerte',
      communes: [],
      usages: [usage],
    };
    const fullAr = {
      ...toEntity(harness.states.get(300)!, harness.states),
      niveauGraviteSpecifiqueEap: false,
      ressourceEapCommunique: 'max',
      restrictions: [persistedRestriction],
    } as unknown as ArreteRestriction;
    jest.spyOn(harness.service, 'findOne').mockResolvedValue(fullAr);
    const authorizationRestriction = { ...persistedRestriction } as any;
    delete authorizationRestriction.usages;
    jest
      .spyOn(harness.service as any, 'findOneForMutationAuthorization')
      .mockResolvedValue({
        ...fullAr,
        restrictions: [authorizationRestriction],
      });

    const result = await harness.service.update(
      300,
      {
        numero: 'AR-300',
        departement: { id: 53 },
        niveauGraviteSpecifiqueEap: false,
        ressourceEapCommunique: 'max',
        arretesCadre: [{ id: 10 }],
        restrictions: [
          {
            ...persistedRestriction,
            isAep: false,
            zoneAlerte: { id: 7 },
            arreteCadre: { id: 10 },
            usages: [{ ...usage, thematique: { id: 4 } }],
          },
        ],
        arreteRestrictionAbroge: null,
      } as any,
      currentUser,
    );

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
    expect(
      harness.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(harness.recordPublicMutation).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
    expect(result.restrictions).toEqual([
      expect.objectContaining({
        id: 20,
        usages: [expect.objectContaining({ id: 40 })],
      }),
    ]);
  });

  it('treats null restrictions as an empty list before rejecting a published deletion', async () => {
    const harness = createHarness([createState(300)], 300);
    jest.spyOn(harness.service, 'findOne').mockResolvedValue({
      ...toEntity(harness.states.get(300)!, harness.states),
      restrictions: [
        {
          id: 20,
          zoneAlerte: { id: 7 },
          arreteCadre: { id: 10 },
          niveauGravite: 'alerte',
          communes: [],
          usages: [],
        },
      ],
    } as ArreteRestriction);
    harness.checkModifications.mockResolvedValue(undefined);
    jest.spyOn(harness.service, 'checkBeforePublish').mockResolvedValueOnce({
      errors: ['Une zone est obligatoire.'],
      warnings: [],
    });

    await expect(
      harness.service.update(300, { restrictions: null } as any, currentUser),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.service.checkBeforePublish).toHaveBeenCalledWith(
      expect.objectContaining({ restrictions: [] }),
      harness.transactionRepository,
    );
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
    expect(harness.recordPublicMutation).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });

  it('valide les restrictions PATCH contre les arrêtés cadre persistés quand ils sont omis', async () => {
    const harness = createHarness(
      [createState(300, { statut: 'a_valider' })],
      300,
    );
    const restrictions = [
      {
        id: 20,
        isAep: false,
        arreteCadre: { id: 10 },
        zoneAlerte: { id: 7 },
      },
    ];

    await harness.service.update(300, { restrictions } as any, currentUser);

    expect(harness.restrictionService.updateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        restrictions,
        departement: expect.objectContaining({ id: 53 }),
        arretesCadre: [expect.objectContaining({ id: 10 })],
      }),
      300,
      harness.manager,
    );
  });

  it('refuse la création dans un département non autorisé avant toute écriture', async () => {
    const harness = createHarness([createState(300)], 300);

    await expect(
      harness.service.create(
        { numero: 'AR-75', departement: { id: 75 } } as any,
        ddt53User,
      ),
    ).rejects.toThrow(
      `Vous ne pouvez enregistrer un arrêté de restriction que sur un département autorisé.`,
    );

    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
  });

  it('revalide et refuse le département cible d’un déplacement PATCH', async () => {
    const harness = createHarness(
      [createState(300, { statut: 'a_valider' })],
      300,
    );

    await expect(
      harness.service.update(
        300,
        { departement: { id: 75 } } as any,
        ddt53User,
      ),
    ).rejects.toThrow(
      `Vous ne pouvez enregistrer un arrêté de restriction que sur un département autorisé.`,
    );

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
  });

  it('restores the old predecessor and truncates the new predecessor when relinking', async () => {
    const harness = createHarness(
      [
        createState(100, {
          dateFin: '2026-08-09',
          dateFinCalculee: true,
        }),
        createState(200),
        createState(300, {
          dateDebut: '2026-08-10',
          statut: 'a_venir',
          predecessorId: 100,
        }),
      ],
      300,
    );

    await harness.service.update(
      300,
      {
        arreteRestrictionAbroge: { id: 200 },
        restrictions: [],
      } as any,
      currentUser,
    );

    expect(harness.repository.manager.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(harness.states.get(300)?.predecessorId).toBe(200);
    expect(harness.states.get(100)).toMatchObject({
      dateFin: null,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      statut: 'publie',
    });
    expect(harness.states.get(200)).toMatchObject({
      dateFin: '2026-08-09',
      dateFinSaisie: null,
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'publie',
    });
    expect(harness.restrictionService.updateAll).toHaveBeenCalledTimes(1);
    expect(harness.manager.query).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit repeal end behind the earliest successor boundary', async () => {
    const harness = createHarness(
      [
        createState(300, {
          dateDebut: '2026-08-01',
        }),
        createState(400, {
          dateDebut: '2026-08-10',
          statut: 'a_venir',
          predecessorId: 300,
        }),
      ],
      300,
    );

    await harness.service.repeal(300, { dateFin: '2026-08-31' }, currentUser);

    expect(harness.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 300,
        dateFin: '2026-08-31',
        dateFinCalculee: false,
      }),
    );
    expect(harness.states.get(300)).toMatchObject({
      dateFin: '2026-08-09',
      dateFinSaisie: '2026-08-31',
      dateFinCalculee: true,
      dateFinSaisieConnue: true,
      statut: 'publie',
    });
    expect(harness.requestCurrentZoneRecompute).toHaveBeenCalledTimes(1);
    expect(harness.manager.query).toHaveBeenCalledTimes(1);
  });

  it('restores the predecessor after deleting its published successor', async () => {
    const harness = createHarness(
      [
        createState(100, {
          dateFin: '2026-08-03',
          dateFinCalculee: true,
          statut: 'abroge',
        }),
        createState(300, {
          dateDebut: '2026-08-04',
          statut: 'publie',
          predecessorId: 100,
        }),
      ],
      300,
    );

    await harness.service.remove(300, currentUser);

    expect(harness.states.has(300)).toBe(false);
    expect(harness.states.get(100)).toMatchObject({
      dateFin: null,
      dateFinSaisie: null,
      dateFinCalculee: false,
      dateFinSaisieConnue: true,
      statut: 'publie',
    });
    expect(harness.transactionRepository.delete).toHaveBeenCalledWith(300);
    expect(harness.invalidateComputationsFromWithManager).toHaveBeenCalledWith(
      harness.manager,
      '2026-07-01',
    );
    expect(harness.recordPublicMutation).toHaveBeenCalledWith(
      harness.manager,
      [53],
      'SUPPRESSION AR',
    );
    expect(harness.manager.query).toHaveBeenLastCalledWith(
      expect.stringContaining('record_historic_compute_invalidation'),
      [
        '2026-07-01',
        null,
        true,
        true,
        'published-source-mutation',
        null,
        '{}',
        '2026-07-01',
        '2026-07-01',
        false,
        false,
        false,
        true,
        false,
      ],
    );
    expect(harness.requestCurrentZoneRecompute).toHaveBeenCalledTimes(1);
  });

  it('rolls back a relink and returns 409 when the new predecessor provenance is unknown', async () => {
    const harness = createHarness(
      [
        createState(100, {
          dateFin: '2026-08-09',
          dateFinCalculee: true,
        }),
        createState(200, {
          dateFin: '2026-08-05',
          dateFinSaisie: '2026-08-05',
          dateFinCalculee: true,
          dateFinSaisieConnue: false,
        }),
        createState(300, {
          dateDebut: '2026-08-10',
          statut: 'a_venir',
          predecessorId: 100,
        }),
      ],
      300,
    );

    await expect(
      harness.service.update(
        300,
        {
          arreteRestrictionAbroge: { id: 200 },
          restrictions: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.states.get(300)?.predecessorId).toBe(100);
    expect(harness.states.get(100)).toMatchObject({
      dateFin: '2026-08-09',
      dateFinCalculee: true,
    });
    expect(harness.states.get(200)).toMatchObject({
      dateFin: '2026-08-05',
      dateFinSaisieConnue: false,
    });
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.restrictionService.updateAll).not.toHaveBeenCalled();
    expect(harness.checkModifications).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });

  it('rejects a relink that would create a predecessor cycle', async () => {
    const harness = createHarness(
      [
        createState(100),
        createState(300, {
          dateDebut: '2026-08-10',
          statut: 'a_venir',
          predecessorId: 100,
        }),
      ],
      100,
    );

    await expect(
      harness.service.update(
        100,
        {
          arreteRestrictionAbroge: { id: 300 },
          restrictions: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.states.get(100)?.predecessorId).toBeUndefined();
    expect(harness.states.get(300)?.predecessorId).toBe(100);
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('rejects a predecessor that starts after its successor', async () => {
    const harness = createHarness(
      [
        createState(200, { dateDebut: '2026-08-11', statut: 'a_venir' }),
        createState(300, { dateDebut: '2026-08-10', statut: 'a_venir' }),
      ],
      300,
    );

    await expect(
      harness.service.update(
        300,
        {
          arreteRestrictionAbroge: { id: 200 },
          restrictions: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.states.get(300)?.predecessorId).toBeUndefined();
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('rejects a draft predecessor', async () => {
    const harness = createHarness(
      [
        createState(200, { statut: 'a_valider' }),
        createState(300, { dateDebut: '2026-08-10', statut: 'a_venir' }),
      ],
      300,
    );

    await expect(
      harness.service.update(
        300,
        {
          arreteRestrictionAbroge: { id: 200 },
          restrictions: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.states.get(300)?.predecessorId).toBeUndefined();
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('rejects moving an order outside its existing successor department', async () => {
    const harness = createHarness(
      [
        createState(100),
        createState(300, {
          dateDebut: '2026-08-10',
          statut: 'a_venir',
          predecessorId: 100,
        }),
      ],
      100,
    );

    await expect(
      harness.service.update(
        100,
        {
          departement: { id: 65 },
          restrictions: [],
        } as any,
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(harness.transactionRolledBack).toBe(true);
    expect(harness.transactionRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
  });

  it('deletes a dated draft without touching historic control-plane state', async () => {
    const harness = createHarness(
      [
        createState(500, {
          dateDebut: '2026-07-01',
          statut: 'a_valider',
        }),
      ],
      500,
    );

    await harness.service.remove(500, currentUser);

    expect(harness.states.has(500)).toBe(false);
    expect(
      harness.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(harness.recordPublicMutation).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });

  it('does not reconcile a public predecessor when deleting its draft successor', async () => {
    const harness = createHarness(
      [
        createState(100, { statut: 'publie' }),
        createState(500, {
          dateDebut: '2026-07-15',
          statut: 'a_valider',
          predecessorId: 100,
        }),
      ],
      500,
    );

    await harness.service.remove(500, currentUser);

    expect(harness.states.has(500)).toBe(false);
    expect(harness.states.get(100)).toMatchObject({
      dateFin: null,
      statut: 'publie',
    });
    expect(harness.synchronizeArreteRestrictionEndDate).not.toHaveBeenCalled();
    expect(
      harness.invalidateComputationsFromWithManager,
    ).not.toHaveBeenCalled();
    expect(harness.recordPublicMutation).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });
});
