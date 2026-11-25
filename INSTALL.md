# Install, upgrade and rollback

The plugin is installed through the Paperclip plugin API (or the
`paperclipai plugin` CLI, which calls the same routes). Plugin management
needs an **instance-admin board user**; agent keys are refused. Keep the board
token in an environment variable, never on a command line.

Installing, upgrading or reconfiguring a plugin starts, stops or restarts only
that plugin's worker. No server restart is needed.

## Build or unpack

Build from source:

```sh
pnpm install --frozen-lockfile
pnpm build:artifact
(cd artifact && sha256sum -c ./*.sha256)
```

Or use a released `paperclip-plugin-decision-triage-<version>.tgz` and check it
against its `.sha256` file. Unpack it into a directory of its own that will
stay in place: the host loads the package from that directory and does not
copy it.

```sh
NEW_DIR=/path/to/plugins/paperclip-plugin-decision-triage-<version>
mkdir -p "$NEW_DIR" && tar xzf paperclip-plugin-decision-triage-<version>.tgz -C "$NEW_DIR" --strip-components=1
```

## Install

```sh
paperclipai plugin install "$NEW_DIR"
# or: POST /api/plugins/install {"packageName": "<NEW_DIR>", "isLocalPath": true}
```

Expect `paperclip.decision-triage` in status `ready`. Record its plugin id.
Until it is configured, the worker logs `config is invalid; triage is off` and
does nothing.

## Configure

Save a config for each company (`POST /api/plugins/<id>/config`):

```json
{
  "companyId": "<company uuid>",
  "configJson": {
    "enabled": true,
    "triageAgentId": "<triage agent uuid>",
    "triageIssueId": "<standing triage issue uuid, optional>",
    "paperclipBaseUrl": "https://paperclip.example.com",
    "investigationProjectId": "<project uuid>"
  }
}
```

See the README for all keys. Check it with
`POST /api/plugins/<id>/config/test` (same body): expect `{"valid": true}`.

`triageIssueId` is optional. It names a standing issue assigned to the triage
agent, used as the fallback wake target when a direct invoke fails.

## Check

- `GET /api/plugins/<id>`: `status: "ready"` and the expected version and
  capabilities.
- Server log within about a minute of start: `decision triage: sweep
  finished` with `errors: 0`, and no `config is invalid`.
- A new board- or user-owned item gives one routing issue assigned to the
  triage agent and one wake.

## Upgrade

Save the current config first
(`GET /api/plugins/<id>/config?companyId=<company uuid>`) and keep the old
package directory: it is the rollback.

- **Same capabilities:** replace the package directory's contents with the new
  version, then `POST /api/plugins/<id>/upgrade`.
- **New capabilities** (for example 0.3.4 adds `agents.read`): on a host that
  supports it, the upgrade route goes to `upgrade_pending` and a board user
  approves the new capabilities with `POST /api/plugins/<id>/enable`. If the
  host refuses the upgrade ("introduces new capabilities that require
  approval"), use soft uninstall + install instead:

  ```sh
  paperclipai plugin uninstall paperclip.decision-triage   # no --force
  paperclipai plugin install "$NEW_DIR"
  ```

  A soft uninstall (`DELETE /api/plugins/<id>` without `purge=true`) keeps the
  plugin row, its config and its state. Installing the same plugin key again
  brings back the same plugin id, config and state. The install is the board
  user's approval of the new capabilities.

Then run the checks above.

## Rollback

- **Fast and reversible:** set `"enabled": false` in the config (no wakes,
  comments or issues), or `POST /api/plugins/<id>/disable` (the worker stops;
  undo with `/enable`).
- **Previous version:** soft uninstall, then install the old package
  directory, and re-save the saved config if it changed. 0.3.3 reads the
  state written by 0.3.4 unchanged.
- **Remove:** `paperclipai plugin uninstall paperclip.decision-triage`. Add
  `--force` (or `purge=true`) only to delete the plugin's state and config as
  well.
