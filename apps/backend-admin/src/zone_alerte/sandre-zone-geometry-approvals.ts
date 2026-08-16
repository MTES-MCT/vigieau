export interface SandreGeometryNormalizationContext {
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string | null;
  featureCount: number;
}

export interface SandreGeometryNormalizationCandidate {
  codeSandre: string;
  gid: number;
  payloadHash: string;
  rawGeometryHash: string;
  normalizedGeometryHash: string;
  rawGeometryType: string;
  normalizedGeometryType: string;
  rawParts: number;
  normalizedParts: number;
  rawPoints: number;
  normalizedPoints: number;
  relativeAreaDelta: number;
  absoluteGeodesicAreaDeltaSquareMeters: number;
}

export interface SandreGeometryNormalizationApproval {
  id: string;
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string;
  featureCount: number;
  maxRelativeAreaDelta: number;
  maxAbsoluteGeodesicAreaDeltaSquareMeters: number;
  features: Array<{
    codeSandre: string;
    gid: number;
    payloadHash: string;
    rawGeometryHash: string;
    normalizedGeometryHash: string;
    rawGeometryType: 'MULTIPOLYGON';
    normalizedGeometryType: 'MULTIPOLYGON';
    rawParts: number;
    normalizedParts: number;
    rawPoints: number;
    normalizedPoints: number;
    maxRelativeAreaDelta: number;
    maxAbsoluteGeodesicAreaDeltaSquareMeters: number;
  }>;
}

// These exceptions are immutable source fixtures. Any upstream payload or raw
// geometry change falls back to the strict global normalization threshold.
export const SANDRE_GEOMETRY_NORMALIZATION_APPROVALS: readonly SandreGeometryNormalizationApproval[] =
  [
    {
      id: '2026-08-15-department-11-invalid-source-geometries',
      departmentCode: '11',
      snapshotHash:
        '7836f3211bee2b02bb1af6624cc9b25faec0126f8c80a58cc555962479da68d9',
      sourceUpdatedAt: '2026-08-13',
      featureCount: 54,
      maxRelativeAreaDelta: 5e-8,
      maxAbsoluteGeodesicAreaDeltaSquareMeters: 25,
      features: [
        {
          codeSandre: '3575',
          gid: 3575,
          payloadHash:
            'c5848889f0306c43b2b89760e6c666b8f34d539f789e648e6783c674ab6b04d5',
          rawGeometryHash:
            'da24a4b3f357b39ac0c8deddddffd0680df3a3e47a86164551d3b12154a276b8',
          normalizedGeometryHash:
            'b27e1f52fa9b14efbbf56f96a141befd4dae2d3861ec1d5055bc0aca13e04ce3',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 37,
          normalizedParts: 43,
          rawPoints: 8785,
          normalizedPoints: 8631,
          maxRelativeAreaDelta: 3.6e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 1.8,
        },
        {
          codeSandre: '3579',
          gid: 3579,
          payloadHash:
            '6d59218028d254f82d6d66d95e346ddb7d14c680d39ca8dd2e904c9509570897',
          rawGeometryHash:
            '50114a1b42924b6e510278ae09d42f091f7102c9103450f301d7cb97b06e786b',
          normalizedGeometryHash:
            '1c577366664f859ff840507d41670ce6fabed2cd573804113bd0747b8341c035',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 33,
          normalizedParts: 38,
          rawPoints: 8353,
          normalizedPoints: 8273,
          maxRelativeAreaDelta: 2.4e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 1.2,
        },
        {
          codeSandre: '3586',
          gid: 3586,
          payloadHash:
            'c586c36b73ba27b045f1ea20596e85ca13e7df579dacde678499b67e1b9c8400',
          rawGeometryHash:
            '8bf2afa53e7b0f5d0d0b38f2dff5c734cadbe6675fcb54beedd3653ecbf68669',
          normalizedGeometryHash:
            '97e7b260b02179e256b593dd256f52b350844077951c60c8d68bdef0f2c3c586',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 160,
          normalizedParts: 163,
          rawPoints: 4746,
          normalizedPoints: 4674,
          maxRelativeAreaDelta: 7.8e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 4,
        },
        {
          codeSandre: '3592',
          gid: 3592,
          payloadHash:
            '2d21b1bb96e2f29fbfde912d9d579410fc28ea7acd5c505a7c170c72bca64701',
          rawGeometryHash:
            '53e69a81415d4c4340d09df6f7edc53086171a82626cdcf99407623d56d93bcd',
          normalizedGeometryHash:
            '4cde431879147a41f48b864acf10002c8db7f47c56a3ae34583bfbb706747298',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 2,
          normalizedParts: 3,
          rawPoints: 310,
          normalizedPoints: 304,
          maxRelativeAreaDelta: 6e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 0.04,
        },
        {
          codeSandre: '3951',
          gid: 3951,
          payloadHash:
            'b96d6fec16b4bbb19d4c1fc8ef885eedcd5ebf68c59834a8db8b555152b4b040',
          rawGeometryHash:
            '3fc3ea162076191c17946dbb1fcc404804ba0a1b5535b64e06bd53034c590372',
          normalizedGeometryHash:
            '9faef154c805adc07691b4f6068f23f7fafc426e60e33c743152ac4d1cc056c0',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 44,
          normalizedParts: 49,
          rawPoints: 8076,
          normalizedPoints: 7990,
          maxRelativeAreaDelta: 2.2e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 1.1,
        },
        {
          codeSandre: '3956',
          gid: 3956,
          payloadHash:
            'a064e1ee0186cfae8642ecb06bf43696392be6f10fada1a77544d6951a58c755',
          rawGeometryHash:
            'dc25ab72fa68f8746e82c58a3ef09795a41511e9c6a90d6d836f0176a86c130f',
          normalizedGeometryHash:
            '6c82f58706fbe5d4efc142db4f4b01bc44276e94848d59a34d5a7c7c6789d0ad',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 95,
          normalizedParts: 77,
          rawPoints: 4194,
          normalizedPoints: 3975,
          maxRelativeAreaDelta: 4.6e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 2.4,
        },
        {
          codeSandre: '3958',
          gid: 3958,
          payloadHash:
            '366bdd85b8189d03d9d31841b0fd139300818113029920c8ea051f575d76c00b',
          rawGeometryHash:
            '7e2445b7ca90fc7bfe75a74bf22fcb6912ef90100b99675e8aa9e34ece7bec9e',
          normalizedGeometryHash:
            '74b340c0cfd8779ee9136c074e4e1e659325a519cca20f1209f784ec170ce77f',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 280,
          normalizedParts: 335,
          rawPoints: 9112,
          normalizedPoints: 8839,
          maxRelativeAreaDelta: 4.6e-8,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 22,
        },
        {
          codeSandre: '3961',
          gid: 3961,
          payloadHash:
            'dcef39950c9246e7ebe5bd9450761e7a2ecaf2c3f47624dcb067ce317133830e',
          rawGeometryHash:
            '8bb2ada29f08faecc2baa57dd4ffb7a29dc912b77351679df5d9e09912566888',
          normalizedGeometryHash:
            '02bd15b44cbd554253a3e62d51f98fdc9fc36562f1e63378c2b0b8c58a15e815',
          rawGeometryType: 'MULTIPOLYGON',
          normalizedGeometryType: 'MULTIPOLYGON',
          rawParts: 17,
          normalizedParts: 19,
          rawPoints: 3576,
          normalizedPoints: 3512,
          maxRelativeAreaDelta: 9e-9,
          maxAbsoluteGeodesicAreaDeltaSquareMeters: 0.15,
        },
      ],
    },
  ];

export function findSandreGeometryNormalizationApproval(
  context: SandreGeometryNormalizationContext | undefined,
  candidate: SandreGeometryNormalizationCandidate,
): SandreGeometryNormalizationApproval | null {
  if (!context) {
    return null;
  }
  for (const approval of SANDRE_GEOMETRY_NORMALIZATION_APPROVALS) {
    if (
      approval.departmentCode !== context.departmentCode ||
      approval.snapshotHash !== context.snapshotHash ||
      approval.sourceUpdatedAt !== context.sourceUpdatedAt ||
      approval.featureCount !== context.featureCount ||
      candidate.relativeAreaDelta > approval.maxRelativeAreaDelta ||
      candidate.absoluteGeodesicAreaDeltaSquareMeters >
        approval.maxAbsoluteGeodesicAreaDeltaSquareMeters
    ) {
      continue;
    }
    const feature = approval.features.find(
      (item) => item.codeSandre === candidate.codeSandre,
    );
    if (
      feature &&
      candidate.relativeAreaDelta <= feature.maxRelativeAreaDelta &&
      candidate.absoluteGeodesicAreaDeltaSquareMeters <=
        feature.maxAbsoluteGeodesicAreaDeltaSquareMeters &&
      feature.gid === candidate.gid &&
      feature.payloadHash === candidate.payloadHash &&
      feature.rawGeometryHash === candidate.rawGeometryHash &&
      feature.normalizedGeometryHash === candidate.normalizedGeometryHash &&
      feature.rawGeometryType === candidate.rawGeometryType &&
      feature.normalizedGeometryType === candidate.normalizedGeometryType &&
      feature.rawParts === candidate.rawParts &&
      feature.normalizedParts === candidate.normalizedParts &&
      feature.rawPoints === candidate.rawPoints &&
      feature.normalizedPoints === candidate.normalizedPoints
    ) {
      return approval;
    }
  }
  return null;
}
