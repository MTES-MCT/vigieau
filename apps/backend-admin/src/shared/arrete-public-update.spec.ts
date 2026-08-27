import {
  hasArreteCadrePublicUpdate,
  hasArreteRestrictionPublicUpdate,
} from './arrete-public-update';

describe('arrete public update detection', () => {
  it('detects a framework pilot change when ACI departments are reordered', () => {
    const current = {
      numero: 'ACI-1',
      departements: [{ id: 1 }, { id: 2 }],
      departementPilote: { id: 1 },
      zonesAlerte: [],
      usages: [],
      arreteCadreAbroge: null,
    } as any;

    expect(
      hasArreteCadrePublicUpdate(current, {
        numero: 'ACI-1',
        departements: [{ id: 2 }, { id: 1 }],
        zonesAlerte: [],
        usages: [],
        arreteCadreAbroge: null,
      }),
    ).toBe(true);
  });

  it('preserves omitted optional fields of an existing framework usage', () => {
    const currentUsage = {
      id: 30,
      nom: 'Arrosage',
      thematique: { id: 4 },
      concerneParticulier: true,
      concerneEntreprise: false,
      concerneCollectivite: false,
      concerneExploitation: false,
      concerneEso: true,
      concerneEsu: false,
      concerneAep: false,
      descriptionVigilance: null,
      descriptionAlerte: 'Interdit de 8 h a 20 h',
      descriptionAlerteRenforcee: null,
      descriptionCrise: 'Interdit',
    };
    const current = {
      numero: 'AC-1',
      departements: [{ id: 1 }],
      departementPilote: null,
      zonesAlerte: [],
      usages: [currentUsage],
      arreteCadreAbroge: null,
    } as any;
    const requestedUsage: Partial<typeof currentUsage> = { ...currentUsage };
    delete requestedUsage.descriptionAlerte;

    expect(
      hasArreteCadrePublicUpdate(current, {
        numero: 'AC-1',
        departements: [{ id: 1 }],
        zonesAlerte: [],
        usages: [requestedUsage as any],
        arreteCadreAbroge: null,
      }),
    ).toBe(false);
  });

  it('preserves omitted fields of an existing non-AEP restriction', () => {
    const current = {
      numero: 'AR-1',
      departement: { id: 1 },
      arretesCadre: [{ id: 10 }],
      restrictions: [
        {
          id: 20,
          zoneAlerte: { id: 7 },
          arreteCadre: { id: 10 },
          niveauGravite: 'alerte',
          nomGroupementAep: null,
          communes: [],
          usages: [],
        },
      ],
      arreteRestrictionAbroge: null,
    } as any;

    expect(
      hasArreteRestrictionPublicUpdate(current, {
        numero: 'AR-1',
        departement: { id: 1 },
        arretesCadre: [{ id: 10 }],
        restrictions: [
          {
            id: 20,
            arreteCadre: { id: 10 },
            niveauGravite: 'alerte',
          } as any,
        ],
        arreteRestrictionAbroge: null,
      }),
    ).toBe(false);
  });

  it('detects when omitted isAep would clear an existing AEP restriction', () => {
    const current = {
      numero: 'AR-1',
      departement: { id: 1 },
      arretesCadre: [{ id: 10 }],
      restrictions: [
        {
          id: 20,
          zoneAlerte: null,
          arreteCadre: { id: 10 },
          niveauGravite: 'alerte',
          nomGroupementAep: 'Reseau nord',
          communes: [{ id: 100 }],
          usages: [],
        },
      ],
      arreteRestrictionAbroge: null,
    } as any;

    expect(
      hasArreteRestrictionPublicUpdate(current, {
        numero: 'AR-1',
        departement: { id: 1 },
        arretesCadre: [{ id: 10 }],
        restrictions: [
          {
            id: 20,
            arreteCadre: { id: 10 },
            niveauGravite: 'alerte',
          } as any,
        ],
        arreteRestrictionAbroge: null,
      }),
    ).toBe(true);
  });
});
