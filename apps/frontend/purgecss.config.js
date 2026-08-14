module.exports = {
  content: [".output/public/**/*.html", ".output/public/**/*.js"],
  css: [".output/public/**/*.css"],
  safelist: [
    /-(leave|enter|appear)(|-(to|from|active))$/,
    /^situation-level-/,
    /^fr-p/,
    /^fr-m/,
    /^fr-col/,
    /^fr-btn/,
    "fr-icon-arrow-left-s-first-line",
    "fr-icon-arrow-left-s-line",
    "fr-icon-arrow-right-s-line",
    "fr-icon-arrow-right-s-last-line",
    /^maplibregl/,
    /^fr-tooltip/,
    /^fr-placement/,
    /^fr-alert/,
    /^text-align/
  ],
  output: [".output/public/_nuxt"]
};
