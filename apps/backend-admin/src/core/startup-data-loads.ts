export const SKIP_STARTUP_DATA_LOADS_ENV = 'SKIP_STARTUP_DATA_LOADS';

export function shouldSkipStartupDataLoads(): boolean {
  return process.env[SKIP_STARTUP_DATA_LOADS_ENV] === 'true';
}
