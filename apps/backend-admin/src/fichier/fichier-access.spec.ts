import { canAccessDocument } from './fichier-access';

describe('document access', () => {
  const cadre = { arreteCadre: { departements: [{ code: '33' }] } } as any;
  const municipal = {
    arreteMunicipal: {
      communes: [{ code: '33063', departement: { code: '33' } }],
    },
  } as any;
  it('limits department and commune accounts to the linked resources', () => {
    expect(
      canAccessDocument(
        { role: 'departement', role_departements: ['33'] } as any,
        cadre,
      ),
    ).toBe(true);
    expect(
      canAccessDocument(
        { role: 'departement', role_departements: ['75'] } as any,
        cadre,
      ),
    ).toBe(false);
    expect(
      canAccessDocument(
        { role: 'commune', role_communes: ['33063'] } as any,
        cadre,
      ),
    ).toBe(false);
    expect(
      canAccessDocument(
        { role: 'commune', role_communes: ['33063'] } as any,
        municipal,
      ),
    ).toBe(true);
    expect(
      canAccessDocument(
        { role: 'commune', role_communes: ['75056'] } as any,
        municipal,
      ),
    ).toBe(false);
  });
  it('allows MTE access but never an absent account', () => {
    expect(canAccessDocument({ role: 'mte' } as any, cadre)).toBe(true);
    expect(canAccessDocument(null, cadre)).toBe(false);
  });
});
