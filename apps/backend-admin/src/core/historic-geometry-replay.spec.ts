import {
  assertHistoricMutableGeometryReplayEnabled,
  HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV,
  isHistoricMutableGeometryReplayEnabled,
} from './historic-geometry-replay';

describe('historic mutable geometry replay switch', () => {
  it('fails closed by default and accepts an explicit opt-in', () => {
    expect(isHistoricMutableGeometryReplayEnabled({})).toBe(false);
    expect(
      isHistoricMutableGeometryReplayEnabled({
        [HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV]: ' TRUE ',
      }),
    ).toBe(true);
    expect(() => assertHistoricMutableGeometryReplayEnabled({})).toThrow(
      'Historic replay from mutable geometries is disabled',
    );
  });

  it.each(['', 'yes', '1', 'enabled'])('rejects invalid value %p', (value) => {
    expect(() =>
      isHistoricMutableGeometryReplayEnabled({
        [HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV]: value,
      }),
    ).toThrow(
      `${HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV} must be either true or false`,
    );
  });
});
