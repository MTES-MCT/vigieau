'use strict';

// Versions 3 and 5 export a callable matcher. Keep their default of doing no
// path-component optimization, while sharing the patched 10.2.6 implementation.
const legacy = require('./commonjs/index.js').minimatch.defaults({ optimizationLevel: 0 });
module.exports = legacy;
// Explicit assignments also expose the historical named exports to ESM users.
module.exports.Minimatch = legacy.Minimatch;
module.exports.sep = legacy.sep;
module.exports.GLOBSTAR = legacy.GLOBSTAR;
module.exports.filter = legacy.filter;
module.exports.defaults = legacy.defaults;
module.exports.braceExpand = legacy.braceExpand;
module.exports.makeRe = legacy.makeRe;
module.exports.match = legacy.match;
