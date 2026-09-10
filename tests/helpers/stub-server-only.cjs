/**
 * `--conditions=react-server` is what normally resolves the `server-only`
 * marker package to a no-op (see tests/README.md) — Next's real server
 * bundler sets that same condition. tests/unit-pg-auth/ cannot use that flag
 * (Auth.js's import graph crashes under it, see auth.test.ts's header
 * comment), but it now transitively imports src/core/workspaces/service.ts
 * (guarded by `import "server-only"`) via src/auth.ts's `events.createUser`
 * hook. This --require preloads a stub into the module cache so that guard
 * resolves to an empty module here too — the same outcome the flag produces
 * elsewhere — without turning the flag on.
 */
const resolved = require.resolve("server-only");
require.cache[resolved] = {
  id: resolved,
  path: require("path").dirname(resolved),
  exports: {},
  filename: resolved,
  loaded: true,
  children: [],
  paths: [],
};
