import { createHash } from "node:crypto";

export type ZonePublicationSeverity =
  | "vigilance"
  | "alerte"
  | "alerte_renforcee"
  | "crise";

export type ZonePublicationDepartmentSituation = {
  max: ZonePublicationSeverity | null;
  sup: ZonePublicationSeverity | null;
  sou: ZonePublicationSeverity | null;
  aep: ZonePublicationSeverity | null;
};

export type ZonePublicationAggregatePayload = {
  schemaVersion: 1;
  counts: {
    zones: number;
    communeLinks: number;
    restrictedZones: number;
    byType: Record<"SUP" | "SOU" | "AEP", number>;
  };
  departments: Record<string, ZonePublicationDepartmentSituation>;
};

export type ZonePublicationMaterializedZone = {
  sourceZoneId: string | number;
  departmentCode: string;
  type: string;
  geometry: string;
  publicPayload: Record<string, unknown>;
  communeCodes: readonly string[];
};

const SEVERITY_WEIGHT: Record<ZonePublicationSeverity, number> = {
  vigilance: 2,
  alerte: 3,
  alerte_renforcee: 4,
  crise: 5,
};

function isSeverity(value: unknown): value is ZonePublicationSeverity {
  return typeof value === "string" && value in SEVERITY_WEIGHT;
}

function maximumSeverity(
  current: ZonePublicationSeverity | null,
  candidate: unknown,
): ZonePublicationSeverity | null {
  if (!isSeverity(candidate)) {
    return current;
  }
  if (!current || SEVERITY_WEIGHT[candidate] > SEVERITY_WEIGHT[current]) {
    return candidate;
  }
  return current;
}

export function buildZonePublicationAggregate(
  zones: readonly Record<string, unknown>[],
  communeLinkCount: number,
): ZonePublicationAggregatePayload {
  const departments: Record<string, ZonePublicationDepartmentSituation> = {};
  const byType = { SUP: 0, SOU: 0, AEP: 0 };
  let restrictedZones = 0;

  for (const zone of zones) {
    const type = zone.type;
    if (type === "SUP" || type === "SOU" || type === "AEP") {
      byType[type] += 1;
    }

    const departmentCode = zone.departement;
    if (typeof departmentCode !== "string" || departmentCode.length === 0) {
      continue;
    }
    restrictedZones += 1;
    const situation = (departments[departmentCode] ??= {
      max: null,
      sup: null,
      sou: null,
      aep: null,
    });
    situation.max = maximumSeverity(situation.max, zone.niveauGravite);
    if (type === "SUP") {
      situation.sup = maximumSeverity(situation.sup, zone.niveauGravite);
    } else if (type === "SOU") {
      situation.sou = maximumSeverity(situation.sou, zone.niveauGravite);
    } else if (type === "AEP") {
      situation.aep = maximumSeverity(situation.aep, zone.niveauGravite);
    }
  }

  return {
    schemaVersion: 1,
    counts: {
      zones: zones.length,
      communeLinks: communeLinkCount,
      restrictedZones,
      byType,
    },
    departments,
  };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeZonePublicationFingerprint(input: {
  zones: readonly ZonePublicationMaterializedZone[];
  aggregate: ZonePublicationAggregatePayload;
}): string {
  const canonicalZones = [...input.zones]
    .sort((left, right) =>
      String(left.sourceZoneId).localeCompare(
        String(right.sourceZoneId),
        "en",
        {
          numeric: true,
        },
      ),
    )
    .map((zone) => ({
      sourceZoneId: String(zone.sourceZoneId),
      departmentCode: zone.departmentCode,
      type: zone.type,
      geometry: zone.geometry,
      publicPayload: zone.publicPayload,
      communeCodes: [...zone.communeCodes].sort(),
    }));

  return createHash("sha256")
    .update(
      stableJson({
        schemaVersion: 1,
        zones: canonicalZones,
        aggregate: input.aggregate,
      }),
    )
    .digest("hex");
}
