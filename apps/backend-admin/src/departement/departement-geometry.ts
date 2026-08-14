export type DepartementGeometry = {
  code: string;
  geom: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown[];
  };
};

const MIN_EXPECTED_DEPARTEMENTS = 90;

export function parseDepartementGeometryFeed(
  payload: unknown,
): DepartementGeometry[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload as { type?: unknown }).type !== 'FeatureCollection' ||
    !Array.isArray((payload as { features?: unknown }).features)
  ) {
    throw new Error('Le referentiel des departements est invalide');
  }

  const features = (payload as { features: unknown[] }).features;
  if (features.length < MIN_EXPECTED_DEPARTEMENTS) {
    throw new Error(
      `Le referentiel des departements est incomplet (${features.length} entites)`,
    );
  }

  const seenCodes = new Set<string>();
  return features.map((feature, index) => {
    if (!feature || typeof feature !== 'object') {
      throw new Error(`Entite departementale invalide a l'index ${index}`);
    }
    const properties = (feature as { properties?: unknown }).properties;
    const geometry = (feature as { geometry?: unknown }).geometry;
    const code =
      properties && typeof properties === 'object'
        ? (properties as { code?: unknown }).code
        : undefined;
    if (typeof code !== 'string' || !/^(?:\d{2,3}|2[AB])$/.test(code)) {
      throw new Error(`Code departemental invalide a l'index ${index}`);
    }
    if (seenCodes.has(code)) {
      throw new Error(`Code departemental duplique : ${code}`);
    }
    seenCodes.add(code);

    if (!geometry || typeof geometry !== 'object') {
      throw new Error(`Geometrie absente pour le departement ${code}`);
    }
    const typedGeometry = geometry as {
      type?: unknown;
      coordinates?: unknown;
    };
    if (
      !['Polygon', 'MultiPolygon'].includes(String(typedGeometry.type)) ||
      !Array.isArray(typedGeometry.coordinates) ||
      typedGeometry.coordinates.length === 0
    ) {
      throw new Error(`Geometrie invalide pour le departement ${code}`);
    }

    return {
      code,
      geom: {
        type: typedGeometry.type as 'Polygon' | 'MultiPolygon',
        coordinates: typedGeometry.coordinates,
      },
    };
  });
}
