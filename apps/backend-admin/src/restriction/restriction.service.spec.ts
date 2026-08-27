import { BadRequestException } from '@nestjs/common';
import { Commune } from '@shared/entities/commune.entity';
import { RestrictionService } from './restriction.service';

const usageService = {
  findByRestriction: jest.fn(async () => [{ id: 100, nom: 'Persisted' }]),
  updateAllByRestriction: jest.fn(async () => []),
};

const createRestriction = (overrides: Record<string, unknown> = {}) => ({
  isAep: true,
  nomGroupementAep: 'Réseau Nord',
  arreteCadre: { id: 10 },
  zoneAlerte: null,
  communes: [{ id: 1 }],
  niveauGravite: 'alerte',
  usages: [],
  ...overrides,
});

const createUsage = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  nom: 'Arrosage des jardins potagers',
  thematique: { id: 1, nom: 'Arroser' },
  concerneParticulier: true,
  concerneEntreprise: false,
  concerneCollectivite: false,
  concerneExploitation: false,
  concerneEso: false,
  concerneEsu: false,
  concerneAep: true,
  descriptionVigilance: 'Autorisé',
  descriptionAlerte: 'Interdit de 8 h à 20 h',
  descriptionAlerteRenforcee: 'Interdit de 8 h à 20 h',
  descriptionCrise: 'Interdit',
  ...overrides,
});

const createArrete = (restrictions: any[] | null) => ({
  numero: 'AR-TEST',
  departement: { id: 79 },
  arretesCadre: [{ id: 10 }],
  restrictions,
});

function createHarness(
  validCommuneIds: number[] = [1, 2],
  linkedZones: Array<{
    arreteCadreId: number;
    zoneAlerteId: number;
    departementId: number;
  }> = [{ arreteCadreId: 10, zoneAlerteId: 7, departementId: 79 }],
) {
  const restrictionRepository = {
    delete: jest.fn(async () => ({ affected: 0 })),
    save: jest.fn(async (values: any[]) =>
      values.map((value, index) => ({ ...value, id: value.id ?? index + 1 })),
    ),
  };
  const communeRepository = {
    find: jest.fn(async () => validCommuneIds.map((id) => ({ id }))),
  };
  const manager = {
    getRepository: jest.fn((entity) =>
      entity === Commune ? communeRepository : restrictionRepository,
    ),
    query: jest.fn(async (sql: string, parameters: unknown[]) => {
      if (sql.includes('arrete_cadre_zone_alerte')) {
        return linkedZones;
      }
      return (parameters[0] as number[]).map((id) => ({ id }));
    }),
  };
  const repository = {
    ...restrictionRepository,
    manager,
  };
  const service = new RestrictionService(
    repository as any,
    usageService as any,
  );
  return { communeRepository, manager, repository, service };
}

describe('RestrictionService.updateAll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['une liste vide', []],
    ['null', null],
  ])(
    'supprime explicitement toutes les anciennes restrictions avec %s',
    async (_label, restrictions) => {
      const { repository, service } = createHarness();

      await service.updateAll(createArrete(restrictions) as any, 42);

      expect(repository.delete).toHaveBeenCalledWith({
        arreteRestriction: { id: 42 },
      });
      expect(repository.save).toHaveBeenCalledWith([]);
    },
  );

  it('normalise une zone AEP sans modifier le DTO reçu', async () => {
    const input = createRestriction({
      nomGroupementAep: '  Réseau Nord  ',
      zoneAlerte: { id: 99 },
      usages: undefined,
    });
    const arrete = createArrete([input]);
    const { repository, service } = createHarness([1]);

    await service.updateAll(arrete as any, 42);

    const saved = repository.save.mock.calls[0][0][0];
    expect(saved).toMatchObject({
      nomGroupementAep: 'Réseau Nord',
      zoneAlerte: null,
      communes: [{ id: 1 }],
      usages: [],
      arreteRestriction: { id: 42 },
    });
    expect(input.nomGroupementAep).toBe('  Réseau Nord  ');
    expect(input.zoneAlerte).toEqual({ id: 99 });
  });

  it("verrouille et vérifie que chaque restriction existante appartient à l'arrêté", async () => {
    const { manager, repository, service } = createHarness([1]);
    const arrete = createArrete([createRestriction({ id: 7 })]);

    await service.updateAll(arrete as any, 42);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      [[7], 42],
    );
    expect(repository.save).toHaveBeenCalledWith([
      expect.objectContaining({ id: 7, arreteRestriction: { id: 42 } }),
    ]);
  });

  it('rejette un identifiant de restriction appartenant à un autre arrêté', async () => {
    const { manager, repository, service } = createHarness([1]);
    manager.query.mockResolvedValueOnce([]);

    await expect(
      service.updateAll(
        createArrete([createRestriction({ id: 7 })]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Une restriction à modifier n'appartient pas à cet arrêté de restriction.`,
    );
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejette des identifiants de restrictions dupliqués ou invalides', async () => {
    const { manager, repository, service } = createHarness([1, 2]);

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({ id: 7 }),
          createRestriction({
            id: 7,
            nomGroupementAep: 'Réseau Sud',
            communes: [{ id: 2 }],
          }),
        ]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Les identifiants des restrictions à modifier sont invalides.`,
    );
    expect(manager.query).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('rejette les noms AEP identiques après trim et normalisation de casse', async () => {
    const { service } = createHarness();
    const arrete = createArrete([
      createRestriction({ nomGroupementAep: 'Réseau Nord' }),
      createRestriction({
        nomGroupementAep: '  réseau nord ',
        communes: [{ id: 2 }],
      }),
    ]);

    await expect(service.updateAll(arrete as any, 42)).rejects.toThrow(
      new BadRequestException(
        `Les noms des groupements d'eau potable doivent être uniques.`,
      ),
    );
  });

  it('rejette une commune présente dans plusieurs groupements AEP', async () => {
    const { service } = createHarness();
    const arrete = createArrete([
      createRestriction(),
      createRestriction({
        nomGroupementAep: 'Réseau Sud',
        communes: [{ id: 1 }],
      }),
    ]);

    await expect(service.updateAll(arrete as any, 42)).rejects.toThrow(
      `Une commune ne peut appartenir qu'à un seul groupement d'eau potable.`,
    );
  });

  it("rejette une commune qui n'appartient pas au département de l'arrêté", async () => {
    const { service } = createHarness([]);

    await expect(
      service.updateAll(createArrete([createRestriction()]) as any, 42),
    ).rejects.toThrow(
      `Toutes les communes des groupements d'eau potable doivent appartenir au département de l'arrêté.`,
    );
  });

  it('rejette une restriction liée à un arrêté cadre étranger', async () => {
    const { service } = createHarness();

    await expect(
      service.updateAll(
        createArrete([createRestriction({ arreteCadre: { id: 11 } })]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Une restriction est liée à un arrêté cadre qui n'appartient pas à cet arrêté de restriction.`,
    );
  });

  it("rejette les usages contradictoires avant d'enregistrer la restriction", async () => {
    const { repository, service } = createHarness();

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            usages: [
              createUsage(),
              createUsage({
                id: 2,
                nom: 'ARROSAGE\u00A0DES JARDINS POTAGERS',
                descriptionCrise: 'Interdit de 8 h à 20 h',
              }),
            ],
          }),
        ]) as any,
        42,
      ),
    ).rejects.toThrow('possède des consignes contradictoires');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('normalise une restriction non AEP et accepte un brouillon incomplet', async () => {
    const restriction = createRestriction({
      isAep: false,
      nomGroupementAep: 'À supprimer',
      communes: [{ id: 1 }],
      zoneAlerte: { id: 7 },
    });
    const { repository, service } = createHarness();

    await service.updateAll(createArrete([restriction]) as any, 42);

    expect(repository.save.mock.calls[0][0][0]).toMatchObject({
      zoneAlerte: { id: 7 },
      communes: null,
      nomGroupementAep: null,
    });
    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            isAep: false,
            zoneAlerte: null,
            arreteCadre: null,
          }),
        ]) as any,
        42,
      ),
    ).resolves.toHaveLength(1);
  });

  it("verrouille et accepte une zone non AEP liée à l'arrêté cadre et au département", async () => {
    const { manager, repository, service } = createHarness();

    await service.updateAll(
      createArrete([
        createRestriction({
          isAep: false,
          zoneAlerte: { id: 7 },
          communes: null,
        }),
      ]) as any,
      42,
    );

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR KEY SHARE OF link, zone'),
      [[10], [7]],
    );
    expect(repository.save).toHaveBeenCalled();
  });

  it("rejette sans mutation une zone non AEP étrangère à l'arrêté cadre", async () => {
    const { manager, repository, service } = createHarness([1, 2], []);

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            isAep: false,
            zoneAlerte: { id: 7 },
            communes: null,
          }),
        ]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Chaque zone d'alerte hors eau potable doit appartenir à l'arrêté cadre de sa restriction.`,
    );

    expect(manager.query).toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("rejette sans mutation une zone non AEP d'un autre département", async () => {
    const { repository, service } = createHarness(
      [1, 2],
      [{ arreteCadreId: 10, zoneAlerteId: 7, departementId: 49 }],
    );

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            isAep: false,
            zoneAlerte: { id: 7 },
            communes: null,
          }),
        ]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Chaque zone d'alerte hors eau potable doit appartenir au département de l'arrêté de restriction.`,
    );

    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('accepte un groupement AEP incomplet tant que le brouillon n’est pas publié', async () => {
    const { service } = createHarness();

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            nomGroupementAep: null,
            arreteCadre: null,
            communes: [],
          }),
        ]) as any,
        42,
      ),
    ).resolves.toHaveLength(1);
  });

  it("préserve les usages d'une restriction existante quand le PATCH les omet", async () => {
    const { service } = createHarness([1]);
    const restriction = createRestriction({ id: 7 });
    delete restriction.usages;

    const result = await service.updateAll(
      createArrete([restriction]) as any,
      42,
    );

    expect(usageService.updateAllByRestriction).not.toHaveBeenCalled();
    expect(usageService.findByRestriction).toHaveBeenCalledWith(7, undefined);
    expect(result[0].usages).toEqual([{ id: 100, nom: 'Persisted' }]);
  });

  it("supprime explicitement les usages d'une restriction existante avec []", async () => {
    const { service } = createHarness([1]);

    await service.updateAll(
      createArrete([createRestriction({ id: 7, usages: [] })]) as any,
      42,
    );

    expect(usageService.updateAllByRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, usages: [] }),
      undefined,
    );
    expect(usageService.findByRestriction).not.toHaveBeenCalled();
  });

  it('refuse encore les incohérences présentes dans un brouillon incomplet', async () => {
    const { service } = createHarness();

    await expect(
      service.updateAll(
        createArrete([
          createRestriction({
            nomGroupementAep: null,
            arreteCadre: { id: 11 },
            communes: [],
          }),
        ]) as any,
        42,
      ),
    ).rejects.toThrow(
      `Une restriction est liée à un arrêté cadre qui n'appartient pas à cet arrêté de restriction.`,
    );
  });
});

describe('RestrictionService.getPublicationValidationErrors', () => {
  it('accepte un graphe AEP complet sans doublon', () => {
    const { service } = createHarness();

    expect(
      service.getPublicationValidationErrors([
        createRestriction() as any,
        createRestriction({
          nomGroupementAep: 'Réseau Sud',
          communes: [{ id: 2 }],
        }) as any,
      ]),
    ).toEqual([]);
  });

  it('retourne des erreurs dédupliquées pour un ancien brouillon AEP invalide', () => {
    const { service } = createHarness();

    const errors = service.getPublicationValidationErrors(
      [
        createRestriction({
          nomGroupementAep: 'Réseau Nord',
          niveauGravite: null,
        }) as any,
        createRestriction({
          nomGroupementAep: ' réseau nord ',
          arreteCadre: null,
          niveauGravite: null,
        }) as any,
      ],
      [10],
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        `Chaque zone de l'arrêté doit avoir un niveau de gravité.`,
        `Les noms des groupements d'eau potable doivent être uniques.`,
        `Chaque zone doit être liée à un arrêté cadre.`,
        `Une commune ne peut appartenir qu'à un seul groupement d'eau potable.`,
      ]),
    );
    expect(
      errors.filter(
        (error) =>
          error === `Chaque zone de l'arrêté doit avoir un niveau de gravité.`,
      ),
    ).toHaveLength(1);
  });

  it('rejette une restriction non AEP sans arrêté cadre ou liée à un arrêté cadre étranger', () => {
    const { service } = createHarness();

    expect(
      service.getPublicationValidationErrors(
        [
          createRestriction({
            isAep: false,
            zoneAlerte: { id: 7 },
            arreteCadre: null,
            communes: null,
          }) as any,
        ],
        [10],
      ),
    ).toContain(`Chaque zone doit être liée à un arrêté cadre.`);
    expect(
      service.getPublicationValidationErrors(
        [
          createRestriction({
            isAep: false,
            zoneAlerte: { id: 7 },
            arreteCadre: { id: 11 },
            communes: null,
          }) as any,
        ],
        [10],
      ),
    ).toContain(
      `Chaque zone doit être liée à un arrêté cadre associé à cet arrêté de restriction.`,
    );
  });

  it('valide la forme annoncée par isAep plutôt que les champs contradictoires du DTO', () => {
    const { service } = createHarness();

    expect(
      service.getPublicationValidationErrors(
        [
          createRestriction({
            isAep: true,
            zoneAlerte: { id: 7 },
            nomGroupementAep: null,
            communes: [],
          }) as any,
        ],
        [10],
      ),
    ).toEqual(
      expect.arrayContaining([
        `Le nom de chaque groupement d'eau potable est obligatoire.`,
        `Chaque groupement d'eau potable doit contenir au moins une commune.`,
      ]),
    );
    expect(
      service.getPublicationValidationErrors(
        [
          createRestriction({
            isAep: false,
            zoneAlerte: null,
            nomGroupementAep: 'Réseau Nord',
          }) as any,
        ],
        [10],
      ),
    ).toContain(
      `Chaque restriction hors eau potable doit être liée à une zone d'alerte.`,
    );
  });

  it('rejette les variantes typographiques contradictoires visant le même public', () => {
    const { service } = createHarness();
    const first = createUsage();
    const second = createUsage({
      id: 2,
      nom: '  ARROSAGE\u00a0DES JARDINS POTAGERS  ',
      thematique: { id: 2, nom: 'Arroser' },
      descriptionCrise: 'Interdit de 8 h à 20 h',
    });

    expect(
      service.getPublicationValidationErrors([
        createRestriction({ usages: [first, second] }) as any,
      ]),
    ).toContain(
      `L'usage « Arrosage des jardins potagers » possède des consignes contradictoires pour des profils et ressources identiques dans une même zone.`,
    );
  });

  it('unifie les apostrophes, les tirets et les formes Unicode du libellé', () => {
    const { service } = createHarness();
    const first = createUsage({
      nom: "Nettoyage d'installations - hors production",
      thematique: { id: 1, nom: 'Activités économiques' },
    });
    const second = createUsage({
      id: 2,
      nom: 'Nettoyage d’installations – hors production',
      thematique: { id: 2, nom: 'ACTIVITE\u0301S E\u0301CONOMIQUES' },
      descriptionAlerte: 'Interdit',
    });

    expect(
      service.getPublicationValidationErrors([
        createRestriction({ usages: [first, second] }) as any,
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('possède des consignes contradictoires'),
      ]),
    );
  });

  it('détecte la variante réelle avec un article facultatif après y compris', () => {
    const { service } = createHarness();

    expect(
      service.getPublicationValidationErrors([
        createRestriction({
          usages: [
            createUsage({
              nom: 'Arrosage des jardins potagers (y compris les serres non-agricoles)',
            }),
            createUsage({
              id: 2,
              nom: 'Arrosage des jardins potagers (y compris serres non-agricoles)',
              descriptionCrise: 'Interdit de 8 h à 20 h',
            }),
          ],
        }) as any,
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('possède des consignes contradictoires'),
      ]),
    );
  });

  it('accepte les doublons équivalents et les variantes sans audience commune', () => {
    const { service } = createHarness();
    const reference = createUsage();

    expect(
      service.getPublicationValidationErrors([
        createRestriction({
          usages: [
            reference,
            createUsage({ id: 2, nom: 'ARROSAGE DES JARDINS POTAGERS' }),
            createUsage({
              id: 3,
              concerneParticulier: false,
              concerneEntreprise: true,
              descriptionCrise: 'Interdit de 8 h à 20 h',
            }),
            createUsage({
              id: 4,
              concerneAep: false,
              concerneEso: true,
              descriptionCrise: 'Interdit totalement',
            }),
          ],
        }) as any,
      ]),
    ).toEqual([]);
  });

  it('ne compare jamais les usages de deux restrictions différentes', () => {
    const { service } = createHarness();

    expect(
      service.getPublicationValidationErrors([
        createRestriction({ usages: [createUsage()] }) as any,
        createRestriction({
          nomGroupementAep: 'Réseau Sud',
          communes: [{ id: 2 }],
          usages: [
            createUsage({ id: 2, descriptionCrise: 'Interdit de 8 h à 20 h' }),
          ],
        }) as any,
      ]),
    ).toEqual([]);
  });
});

describe('RestrictionService.getZoneAlerteRelationValidationErrors', () => {
  it('valide aussi une restriction legacy complète sans champ isAep', async () => {
    const { manager, service } = createHarness();

    await expect(
      service.getZoneAlerteRelationValidationErrors(
        [
          {
            arreteCadre: { id: 10 },
            zoneAlerte: { id: 7 },
          } as any,
        ],
        79,
        manager as any,
      ),
    ).resolves.toEqual([]);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('arrete_cadre_zone_alerte'),
      [[10], [7]],
    );
  });

  it('préserve un brouillon non AEP incomplet sans requête relationnelle', async () => {
    const { manager, service } = createHarness();

    await expect(
      service.getZoneAlerteRelationValidationErrors(
        [
          {
            isAep: false,
            arreteCadre: null,
            zoneAlerte: { id: 7 },
          } as any,
        ],
        79,
        manager as any,
      ),
    ).resolves.toEqual([]);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
