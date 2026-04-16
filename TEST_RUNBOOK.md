# Test Runbook

This is the shortest known-good setup for running focused Pokemon Showdown tests on this Windows machine.

If you are bringing the stack up on an Intel Mac instead, use [INTEL_MAC_HANDOFF.md](./INTEL_MAC_HANDOFF.md) for the fresh-machine flow. The narrow-file Mocha strategy below still applies; only the shell syntax changes.

Assumptions:

- the repo is already cloned and dependencies are installed
- you are using the local Node install under `C:\Program Files\nodejs`
- you want to validate one test file first, not the full suite

## 1. Known-Good Versions

- Node: `v20.11.0`
- npm: `10.2.4`

Use the same Node version for install, build, and test runs. Mixing Node versions can leave native modules out of sync.

## 2. Quick Sanity Check

From PowerShell:

```powershell
& 'C:\Program Files\nodejs\node.exe' -v
& 'C:\Program Files\nodejs\npm.cmd' -v
```

If `node` is not on PATH in PowerShell, use the full paths above instead of relying on shell lookup.

## 3. Fast Single-File Test Command

```powershell
& 'C:\Program Files\nodejs\node.exe' .\node_modules\mocha\bin\mocha.js --no-config --file .\test\main.js test\server\browser-model-bridge.test.js --timeout 15000 --exit
```

Notes:

- `--file test/main.js` loads the repo test harness correctly.
- `--no-config` keeps Mocha from picking up broader repo defaults.
- `--exit` is useful for narrow checks when a test leaves an open handle.

For a different file, replace `test\server\browser-model-bridge.test.js` with the file you want to check.

## 3b. macOS / POSIX equivalent

On macOS or another POSIX shell, the same narrow-file command is:

```bash
node ./node_modules/mocha/bin/mocha.js --no-config --file ./test/main.js test/server/browser-model-bridge.test.js --timeout 15000 --exit
```

For a different file, replace `test/server/browser-model-bridge.test.js` with the file you want to check.

## 4. Common Compatibility Issues

### `assert.ok` fails with "This API is deprecated; please use assert()"

This repo intentionally disables `assert.ok`. Use `assert(condition)` or the more specific helpers in `test/assert.js`.

### `better-sqlite3.node was compiled against a different Node.js version`

That means the native module was built with a different Node major version than the one currently running.

Fixes:

- rerun `npm rebuild better-sqlite3`
- if that does not work, rerun `npm ci` under the Node version you plan to test with

### Mocha runs far more tests than expected

That usually means the command was run without `--no-config`.

### A test appears to hang after printing results

That is usually an open handle from the harness or server startup. Try the same command with `--exit` before assuming the test failed.

## 5. Minimal Re-run Checklist

1. Check Node and npm versions.
2. Run one file with the explicit Mocha command above.
3. If a native module mismatch appears, rebuild the addon under the same Node version.
4. Only fall back to `npm test` or `npm run full-test` once the narrow check is green.
