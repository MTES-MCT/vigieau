module.exports = {
  content: ['.output/public/**/*.html', '.output/public/**/*.js'],
  css: ['.output/public/**/*.css'],
  safelist: [
    /-(leave|enter|appear)(|-(to|from|active))$/,
    /^situation-level-/,
    /^fr-p/,
    /^fr-m/,
    /^fr-col/,
    /^fr-btn/,
    /^fr-badge/,
    /^maplibregl/,
    /^fr-tooltip/,
    /^fr-placement/,
    /^fr-alert/,
  ],
  output: ['.output/public/_nuxt'],
};
