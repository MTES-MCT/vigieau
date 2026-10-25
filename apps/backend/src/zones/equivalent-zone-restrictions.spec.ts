import { haveEquivalentZoneRestrictions } from './equivalent-zone-restrictions';

function makeZone() {
  return {
    id: 7260843,
    idSandre: 2110,
    code: '76_34_0008',
    nom: 'Orb hors axe soutenu',
    type: 'SUP',
    departement: '34',
    niveauGravite: 'vigilance',
    ressourceInfluencee: false,
    arrete: {
      id: 38231,
      dateDebutValidite: '2026-10-10T00:00:00.000Z',
      dateFinValidite: '2026-12-31T00:00:00.000Z',
      cheminFichier: 'https://example.test/restriction.pdf',
      cheminFichierArreteCadre: 'https://example.test/cadre.pdf',
    },
    usages: [
      {
        id: 1,
        nom: 'Arrosage',
        thematique: 'Arroser',
        description: 'Sensibiliser les usagers.',
        concerneParticulier: true,
        concerneEntreprise: true,
        concerneCollectivite: true,
        concerneExploitation: false,
      },
      {
        id: 2,
        nom: 'Irrigation',
        thematique: 'Irriguer',
        description: 'Sensibiliser les agriculteurs.',
        concerneParticulier: false,
        concerneEntreprise: false,
        concerneCollectivite: false,
        concerneExploitation: true,
      },
    ],
  };
}

describe('haveEquivalentZoneRestrictions', () => {
  it('preserves source identity while ignoring only usage IDs and list order', () => {
    const first = makeZone();
    const second = {
      ...makeZone(),
      id: 7260839,
      idSandre: 2111,
      code: '76_34_0009',
      nom: 'Axe Orb soutenu',
    };
    second.usages.reverse();
    second.usages.forEach((usage) => (usage.id += 100));
    const before = JSON.stringify([first, second]);

    expect(haveEquivalentZoneRestrictions([first, second])).toBe(true);
    expect(JSON.stringify([first, second])).toBe(before);
  });

  it('also recognizes the documented SANDRE source-identity aliases', () => {
    const first = { ...makeZone(), gid: 2110, CdZAS: '0008', LbZAS: 'Orb' };
    const second = {
      ...makeZone(),
      gid: 2111,
      CdZAS: '0009',
      LbZAS: 'Axe Orb',
    };
    expect(haveEquivalentZoneRestrictions([first, second])).toBe(true);
  });

  it.each([
    ['type', (zone: any) => (zone.type = 'SOU')],
    ['department', (zone: any) => (zone.departement = '30')],
    ['severity', (zone: any) => (zone.niveauGravite = 'crise')],
    ['influenced resource', (zone: any) => (zone.ressourceInfluencee = true)],
    ['decree ID', (zone: any) => (zone.arrete.id += 1)],
    [
      'start date',
      (zone: any) => (zone.arrete.dateDebutValidite = '2026-10-11'),
    ],
    ['end date', (zone: any) => (zone.arrete.dateFinValidite = null)],
    [
      'decree document',
      (zone: any) =>
        (zone.arrete.cheminFichier = 'https://example.test/other.pdf'),
    ],
    [
      'framework document',
      (zone: any) =>
        (zone.arrete.cheminFichierArreteCadre =
          'https://example.test/other.pdf'),
    ],
    ['usage name', (zone: any) => (zone.usages[0].nom = 'Autre usage')],
    ['usage theme', (zone: any) => (zone.usages[0].thematique = 'Autre thème')],
    [
      'usage description',
      (zone: any) => (zone.usages[0].description = 'Arrosage interdit.'),
    ],
    ...[
      'concerneParticulier',
      'concerneEntreprise',
      'concerneCollectivite',
      'concerneExploitation',
    ].map((field): [string, (zone: any) => void] => [
      field,
      (zone: any) => (zone.usages[0][field] = !zone.usages[0][field]),
    ]),
    [
      'usage hidden by the requested profile',
      (zone: any) => (zone.usages[1].description = 'Irrigation interdite.'),
    ],
    ['usage count', (zone: any) => zone.usages.push({ ...zone.usages[0] })],
    ['additional decree field', (zone: any) => (zone.arrete.numero = 'other')],
    [
      'additional usage field',
      (zone: any) => (zone.usages[0].exception = 'other'),
    ],
    ['additional zone field', (zone: any) => (zone.derogation = 'other')],
    ['nested identifier', (zone: any) => (zone.usages[0].source = { id: 123 })],
  ])('rejects a difference in %s', (_label, change: (zone: any) => void) => {
    const second = makeZone();
    change(second);
    expect(haveEquivalentZoneRestrictions([makeZone(), second])).toBe(false);
  });

  it.each([
    ['decree', (zone: any) => (zone.arrete = {})],
    ['decree identity', (zone: any) => delete zone.arrete.id],
    ['start date', (zone: any) => delete zone.arrete.dateDebutValidite],
    ['end date', (zone: any) => delete zone.arrete.dateFinValidite],
    ['document', (zone: any) => delete zone.arrete.cheminFichier],
    [
      'framework document',
      (zone: any) => delete zone.arrete.cheminFichierArreteCadre,
    ],
    ['usages', (zone: any) => (zone.usages = [])],
    ['description', (zone: any) => (zone.usages[0].description = '')],
    ['profile flag', (zone: any) => delete zone.usages[0].concerneParticulier],
    ['resource flag', (zone: any) => delete zone.ressourceInfluencee],
    ['department', (zone: any) => (zone.departement = '')],
    [
      'invalid date',
      (zone: any) => (zone.arrete.dateDebutValidite = 'invalid'),
    ],
    [
      'undefined evidence',
      (zone: any) => (zone.usages[0].exception = undefined),
    ],
    ['undefined zone evidence', (zone: any) => (zone.derogation = undefined)],
    ['sparse evidence', (zone: any) => (zone.derogations = new Array(1))],
  ])('rejects equally incomplete %s evidence', (_label, change) => {
    const first = makeZone();
    const second = makeZone();
    change(first);
    change(second);
    expect(haveEquivalentZoneRestrictions([first, second])).toBe(false);
  });

  it('accepts an explicitly open-ended decree and compares Date values', () => {
    const first: any = makeZone();
    const second: any = makeZone();
    first.arrete.dateFinValidite = null;
    second.arrete.dateFinValidite = null;
    first.arrete.dateDebutValidite = new Date(first.arrete.dateDebutValidite);
    second.arrete.dateDebutValidite = new Date(second.arrete.dateDebutValidite);
    expect(haveEquivalentZoneRestrictions([first, second])).toBe(true);
    second.arrete.dateDebutValidite = new Date('2026-10-11T00:00:00.000Z');
    expect(haveEquivalentZoneRestrictions([first, second])).toBe(false);
  });

  it('compares every zone in a group and requires at least two zones', () => {
    expect(haveEquivalentZoneRestrictions([])).toBe(false);
    expect(haveEquivalentZoneRestrictions([makeZone()])).toBe(false);
    const third = makeZone();
    third.usages[1].description = 'Autre prescription.';
    expect(
      haveEquivalentZoneRestrictions([makeZone(), makeZone(), third]),
    ).toBe(false);
  });
});
