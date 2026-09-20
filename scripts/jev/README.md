# Optional Jev development helpers

These Node 22 scripts run outside the published package and production moderation path. No request is sent by default. The native moderation evaluation/calibration tools are documented in [moderation tooling](../../docs/moderation-tooling.md).

## One-time local credentials

All Jev helpers share the developer-machine file `$XDG_CONFIG_HOME/bitsocial/jev.json`, or `~/.config/bitsocial/jev.json` when `XDG_CONFIG_HOME` is unset. Configure it once outside your repositories; new checkouts and worktrees use it automatically. Store a pointer to your existing key file, not a copy of the key:

```json
{
    "apiKeyFile": "/absolute/path/to/private/typesafe-key.txt",
    "model": "jev-X.Y.Z"
}
```

Replace the path and model with your private key file and an available pinned version. The key file contains only the API key. On macOS/Linux, keep its permissions and the config file at `600` and the config directory at `700`. No user-specific path or model default belongs in the repository. `.env` files are not automatically loaded, and no shell startup changes are needed.

Check setup from any checkout without making a provider request:

```sh
node scripts/jev/config.mjs --check
```

The result reports only readiness, pinned model, and a safe error code if unavailable. Live development commands then work without exporting the key. Helpers read configuration only for a live Jev run or this explicit check; offline validation do not read credentials.

Runtime overrides are supported: explicit client options/`--model`, then `TYPESAFE_API_KEY` (or `TYPESAFE_API_KEY_FILE` when no key is set) and `JEV_MODEL`, then machine defaults. `JEV_CONFIG_FILE` selects another absolute config path. Empty overrides fail instead of silently using another credential. Config and key-file paths must be absolute; `~` inside JSON or environment variables is not expanded. Complete key/model overrides work without reading a machine config. Invalid explicit configuration fails before an API request runs.

For CI, supply `TYPESAFE_API_KEY` from the CI secret store and `JEV_MODEL` from workflow configuration only in an explicitly requested live job. The included Jev CI workflow stays offline. Never use `VITE_*` variables, commit credentials, add them to plans or CLI arguments, or expose them to page JavaScript. The helper sends credentials only to `https://api.typesafe.ai/v1/systemone` and rejects redirects. It never exports a file-loaded key into the parent environment.

## Tools

- [Advisory semantic diff review](review-README.md): explicitly selected patches, no automatic hooks or edits.

## Offline checks

```sh
node --test scripts/jev/tests/*.test.mjs
```

For explicitly selected, sanitized operational events, see [advisory log triage](triage-README.md). It does not suppress alerts or trigger repairs.
