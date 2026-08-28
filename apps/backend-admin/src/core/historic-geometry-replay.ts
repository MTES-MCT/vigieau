export const HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV =
  'HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED';

/**
 * Historic computation currently resolves zone and commune shapes from mutable
 * canonical tables. Keep every replay path closed unless an operator opts in
 * on an isolated database while a dated geometry source is being introduced.
 */
export function isHistoricMutableGeometryReplayEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value =
    environment[
      HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV
    ]?.trim().toLowerCase() ?? 'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `${HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV} must be either true or false`,
    );
  }
  return value === 'true';
}

export function assertHistoricMutableGeometryReplayEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!isHistoricMutableGeometryReplayEnabled(environment)) {
    throw new Error(
      'Historic replay from mutable geometries is disabled; use an isolated clone with ' +
        `${HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV}=true`,
    );
  }
}
