import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ArreteRestrictionService } from './arrete_restriction.service';

const currentUser = {
  email: 'mte@example.test',
  role: 'mte',
  role_departements: [],
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
  const manager = {
    getRepository: jest.fn((entity) =>
      entity === ArreteCadre ? arreteCadreRepository : transactionRepository,
    ),
    query: jest.fn(async (sql: string) =>
      sql.includes('information_schema.columns')
        ? [{ exists: true }]
        : [{ id: 1 }],
    ),
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
  const service = new ArreteRestrictionService(
    repository as any,
    {} as any,
    {} as any,
    restrictionService as any,
    {} as any,
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
    get transactionRolledBack() {
      return transactionRolledBack;
    },
    lockQuery,
    manager,
    repository,
    requestCurrentZoneRecompute,
    restrictionService,
    service,
    states,
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
    expect(harness.manager.query).toHaveBeenCalledTimes(2);
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
    expect(harness.manager.query).toHaveBeenCalledTimes(2);
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
    expect(harness.manager.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE config'),
      ['2026-07-01'],
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

  it('deletes an undated draft without triggering historic invalidation', async () => {
    const harness = createHarness(
      [
        createState(500, {
          dateDebut: null,
          statut: 'a_valider',
        }),
      ],
      500,
    );

    await harness.service.remove(500, currentUser);

    expect(harness.states.has(500)).toBe(false);
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.requestCurrentZoneRecompute).not.toHaveBeenCalled();
  });
});
