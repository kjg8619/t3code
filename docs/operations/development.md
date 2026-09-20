# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree commands on Unix and Windows link that file to each worktree's
`.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Weavra integration

The V0.6A C07 integration includes read-only observation and a separate, opt-in workflow
control slice. The contracts below are not a claim of remote CI success, paid-provider
quality, or support outside this bounded slice. Acceptance and exact-SHA CI results are
tracked in [Weavra's work log](https://github.com/kjg8619/pi/blob/devlop/docs/WORK_LOG.md).

### Read-only setup

Install a compatible Weavra CLI, explicitly initialize its product home with setup, and
run doctor in the same local environment as the T3 server. Use the Node 24 development
environment above. In a Pi checkout, the actual launcher is
`packages/company-runtime/bin/weavra`, not a generic Pi executable. Its product home defaults
to the server user's `~/.weavra`; an explicit `WEAVRA_HOME` must be used consistently for setup,
doctor, and the T3 process and must not overlap `~/.pi`. Setup is explicit, never performed by
opening the T3 view:

```sh
/absolute/path/to/pi/packages/company-runtime/bin/weavra setup
/absolute/path/to/pi/packages/company-runtime/bin/weavra doctor
```

Configure a trusted absolute executable path on the **T3 server's machine**, then use the
existing dev command:

```sh
T3_WEAVRA_EXECUTABLE=/absolute/path/to/weavra vp run dev
```

There is no browser executable setting or additional server/listener. T3 launches that
executable with `bridge --stdio --project-trusted` in the canonical root of an existing,
authorized T3 `ProjectId`; clients cannot supply arbitrary roots. Project existence and root
are revalidated before and after reads. The existing authenticated `weavra.observe` RPC
requires `orchestration:read`. The optional environment capability `weavraReadOnly` gates
use with older servers; update the server if it does not advertise support.

Open the project's sidebar **Project settings** button, or **Settings → select project scope
→ Project**, then find **Weavra · Read-only**. For a grouped project, select one
environment/checkout first. The read-only view shows an overview, source graph nodes/edges,
and bounded evidence/config summaries, with no mutation controls in that section. Config
summaries describe the current project configuration, not a Run's frozen configuration.

### Read-only transport and recovery

The protocol v1 hello identifies `clientName=t3code` and `capabilities=[snapshots-only]`;
the reply reports `runtimeVersion`, `transport=stdio`, `observationMode=snapshots-only`,
and readiness (`READY`, `NOT_SETUP`, or `CONFIG_INVALID`). Only read commands are supported:
`hello`, `capabilities`, `status`, `current-run`, `graph`, `evidence-summary`,
`config-summary`, and `snapshot`. Strict UTF-8 JSONL, schema and correlation checks bound
requests to 4,096 bytes and responses to 65,536 bytes, including the newline.

T3 polls canonical snapshots every **2 seconds**, retries transport failures after
**5 seconds**, and permits one outstanding request with a **10-second** timeout.
Child shutdown sends SIGTERM, then force-kills after 2 seconds if needed. There is no
event replay or fabrication of Runtime events; the in-process Runtime event sink is unchanged.

Readiness describes local product-home/doctor checks, not project configuration, credentials,
Provider connectivity, or a running workflow. Doctor warnings such as missing authentication
can coexist with `READY`. Project configuration validity is reported separately in the summary.

| State               | Meaning and recovery                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOT_INSTALLED`     | Configure an installed, trusted executable with the absolute server-local path above, then restart T3.                                     |
| `NOT_SETUP`         | Initialize the server user's Weavra product home explicitly with setup, run doctor, then reopen the view.                                  |
| `CONFIG_INVALID`    | Check the executable and local installation, home permissions, JSON files, and build with doctor; fix them, then reopen the view.          |
| `READY`             | Local doctor checks passed; this does not mean a Runtime or Provider is ready to execute.                                                  |
| `CONNECTING`        | The initial connection/handshake is in progress; allow it to complete.                                                                     |
| `CONNECTED`         | Snapshot observation is connected, not proof of a live Runtime owner.                                                                      |
| `DISCONNECTED`      | The transport has closed; retained data is stale. Check the executable/project and allow reconnect.                                        |
| `RECONNECTING`      | T3 is retrying the transport; fix the underlying problem or reopen the view after recovery.                                                |
| `PROTOCOL_MISMATCH` | Use compatible T3/Weavra versions, then restart T3 and reopen the view.                                                                    |
| `ERROR`             | Check the reported failure, project access, and doctor; fix the cause, then reopen the view or restart T3 if server configuration changed. |

Durable Run state, connection state, and owner liveness are distinct. A disconnected view
may retain a `RUNNING` Run marked stale; missing fields and owner liveness remain `UNKNOWN`,
even when connected. A writer-lock file is not liveness evidence. Regressed project or
same-Run revisions and late results from old sessions are rejected; observations are scoped
to the selected environment, project, and canonical root.

T3 reads only the child's stdout JSONL, never Weavra `.ai` files. Summaries exclude raw
prompts, reasoning, credentials, transcripts, source/document bodies, and tool output.
Observation does not automatically set up a project, start/resume/cancel a Runtime,
approve/reject work, write/edit files, or confer Task Contract, Policy, PASS, COMPLETE,
or owner authority. This is local read-only observation, not paid-provider end-to-end
or workflow-execution proof.

### Opt-in workflow control

Keep the executable/home setup above. From the T3 repository root, opt in on the trusted
server and restart the development process:

```sh
T3_WEAVRA_EXECUTABLE=/absolute/path/to/pi/packages/company-runtime/bin/weavra \
T3_WEAVRA_CONTROL=1 \
vp run dev
```

If setup used a custom `WEAVRA_HOME`, export that same value before this command. Open the
printed pairing URL, choose the existing project and a single environment/checkout, then
open **Settings → select exact project scope → Project → Weavra · Workflow control**, above the read-only view.
There is no browser-configurable executable or arbitrary project-root input.

The server advertises `weavraControl` only when `T3_WEAVRA_CONTROL=1`. Both
`weavra.controlObserve` and `weavra.control` require **`orchestration:operate`**; the legacy
`weavra.observe` remains **`orchestration:read`**. Opening control observation acquires a
server-owned Runtime connection, not merely a read-only observer. T3 launches the separate
`bridge --stdio --project-trusted --control` endpoint in the authorized project's canonical
root. The read-only argv, protocol v1, and snapshot-only capabilities remain unchanged.
No additional network Host or listener is introduced.

The closed control command set is `control.hello`, `control.snapshot`, `workflow.prepare`,
`workflow.confirm`, `workflow.cancel`, and `approval.resolve`. Its strict UTF-8 JSONL limits
are **32,768 request bytes** and **65,536 response bytes**, including the newline. T3 supplies
goal text, reviewed recipe input data, and acceptance-criterion prose, not executable
instructions or authority-bearing overrides. Runtime/Kernel owns classification, allowed
scope, registered checks, criterion IDs and verification mappings, the frozen Task Contract,
revisions, approval grants and consumption, Policy, and completion.

#### Prepare, refresh, and confirm

1. Wait for **CONTROL CONNECTED** and fresh canonical state. A busy owner, active Run, or
   writer prevents preparing another plan.
2. Enter a **Workflow goal** (up to 2,048 characters). Optionally select a **Reviewed recipe**
   and fill its **Recipe inputs (JSON data only)** template. Inputs are string-valued data,
   not shell commands, tools, or configuration overrides.
3. Select **Prepare workflow**. Runtime prepares the preview without Provider calls or
   starting a Workflow. Review workflow/risk/execution mode, allowed paths, registered checks,
   configuration, recipe version, acceptance criteria, and Task Contract digest.
4. Edit **Acceptance criteria · one line per criterion** if needed: 1–16 nonempty statements,
   at most 500 characters each. Select **Refresh Plan Preview** after edits and review the
   replacement Runtime-generated mappings and digest. Editing goal or recipe data invalidates
   the old preview and requires preparing again. A preview expires after five minutes;
   expiry, changed configuration, owner, or project revision requires a fresh preview.
5. Select **Confirm and start**, then explicitly confirm the modal for that exact preview
   and checkout. Only confirmation launches the existing Workflow. Plan confirmation is
   **not R3 approval**, PASS, or COMPLETE.
6. Observe canonical Run state and evidence. **accepted** is only an ACK that Runtime accepted
   the request, not proof that a Run exists, checks passed, or execution completed. Model/Git/LSP
   preflight can fail before creating a Run; the UI reports the start failure rather than
   manufacturing a successful outcome or retrying automatically.

#### Ownership, guards, and bounded retries

Mutations carry the current Runtime owner UUID, Runtime-issued monotonic `nextRequestId`,
and expected project revision. Confirmation also binds the preview ID/digest; cancellation
and approval bind the existing Run ID and Run revision, and approval binds its pending
approval ID. Runtime rechecks ownership, canonical root, configuration, and relevant state;
T3 rejects regressed snapshots and late results from old sessions. A different owner cannot
control a previously observed Run simply because a writer file or durable `RUNNING` status
exists.

Retry semantics are deliberately bounded, not a durable replay log:

- IDs have the form `<owner UUID>:<sequence>` and must use the next sequence supplied by
  Runtime. The owner retains at most **64 payload-bound mutation receipts**, including
  rejected mutation results. Within that window, an identical ID and payload returns the
  original response without executing again; a changed payload gives `REQUEST_ID_REUSED`.
- An evicted/older ID gives `REQUEST_EXPIRED` and never executes again in the same owner epoch.
  Skipping the next sequence gives `REQUEST_OUT_OF_ORDER`; a previous owner gives
  `OWNER_CHANGED`. A new owner has no old receipt history and does not adopt old mutations.
- The transport permits one outstanding exchange with a **10-second** wait. A timeout does
  not forget that exchange: an identical retry waits for its correlated receipt without
  writing another mutation; a different request cannot replace it.
- **The UI does not automatically retry mutations or queue them for reconnect.** A transport
  error means the outcome is unknown, not that the action failed. Wait for fresh canonical
  state and review it before a new explicit action; never turn an uncertain ACK into a new
  request ID merely to retry.

Control snapshots poll every **2 seconds**. Transport closure/spawn failure can reconnect
after **5 seconds**, but only observation reconnects; prior mutations are not replayed.
Closing the tab, leaving Project Settings, or losing the browser connection does **not**
terminate server-owned execution. Reconnecting must obtain fresh canonical state before
enabling controls. This is not restart recovery: loss/replacement of the Runtime owner does
not provide resume or adoption of its old Run.

#### Cancel and pending R3 decisions

**Cancel workflow** is available only for an existing, active Run owned by this connection
with current Run/project revisions. Confirm the cancellation modal, then wait for canonical
terminal state, owner idle state, and writer release. An accepted cancellation only requests
shutdown: Runtime must stop active agents, checks, and child processes before releasing the
writer. Partial workspace changes remain; there is no automatic commit, rollback, file
cleanup, or fallback. Before a canonical Run exists, model/Git/LSP preflight has no wire Run ID
to cancel; the UI does not offer a fictitious cancellation target.

The only R3 decision surface is an existing, Runtime-owned **WAITING_APPROVAL** request for
the already-supported **one-file deletion**. Inspect the target, Run/approval IDs, role/step,
Run/project revisions, bytes, fingerprint, and expiry. **Reject** denies that pending request;
**Approve once** requires explicit confirmation for that one deletion. Deny is the default,
and expired/stale requests cannot be approved. Runtime still validates and consumes the grant
against the exact operation and precondition. Neither the decision ACK nor approval itself
establishes PASS or COMPLETE. This is not generic R3, a session-wide grant, or scope expansion.

#### Unavailable state and limits

**CONTROL UNAVAILABLE** disables actions when the environment is unsupported, disconnected,
or stale; retained Run data is not current execution authority. Enable the server opt-in or
update incompatible versions as appropriate, check `orchestration:operate` access, and use
the readiness/doctor guidance above for installation/home failures. Fix project/root or
protocol errors before reopening the view; restart T3 when changing its server environment.
Do not remove a writer lock or infer owner liveness from it to bypass unavailable controls.

This slice supports the existing QUICK/STANDARD Workflow paths, not COMPLEX, arbitrary
write/edit/tool/shell dispatch, generic R3, resume/recovery, rollback, or fallback. T3 remains
a Host requesting Runtime actions and showing bounded canonical summaries; it never becomes
the Task Contract, Policy, approval-consumption, or completion authority.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
