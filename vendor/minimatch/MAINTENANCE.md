# Updating application lockfiles

Use the Node and npm versions pinned in each application's `engines`.
After rebuilding the archives, update each affected lockfile from the repository
root with:

```sh
node scripts/update-minimatch-lockfile.mjs backend
node scripts/update-minimatch-lockfile.mjs backend-admin
node scripts/update-minimatch-lockfile.mjs frontend
node scripts/update-minimatch-lockfile.mjs frontend-admin
```

The helper works around npm 12's initial resolution of relative file overrides
from nested consumer directories. It temporarily uses absolute paths for only
the two minimatch overrides, resolves the lock without running install scripts,
then restores the original manifest and writes portable `file:vendor/` paths.
If resolution or normalization fails, both original files are restored.

Commit only the restored manifest and portable lockfile. Run a normal `npm ci`
in every affected application, the full and production npm audits, application
tests and builds, and `node --test scripts/minimatch-security.test.mjs`.
The helper is not needed for subsequent clean installations. A clean install
from another directory and an empty npm cache verifies portability.

This maintenance document is not included in the fork archives, so changes to
these instructions do not change dependency checksums.
