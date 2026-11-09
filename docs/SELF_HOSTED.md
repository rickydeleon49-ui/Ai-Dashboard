# Self-Hosted Mode

Run Command Center headless on an always-on machine you own (Linux mini PC or Mac) so agent runs continue without an open desktop window, reachable privately from your phone or laptop.

## Before you start

Make sure you have:
- **Dedicated hardware**: A Linux mini PC or Mac that stays on. (Windows is not supported as a service yet).
- **Node.js 22+**: `node -v` must report v22 or newer.
- **Git**: Installed and on `PATH`.
- **Tailscale**: Installed and signed in on both the machine and your phone.
- **Coding agent CLIs**: Any tools you plan to run (such as `claude`, `codex`, or `agy`) installed, configured, and on `PATH`.

## Step-by-step setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/rickydeleon49-ui/Ai-Dashboard.git
cd Ai-Dashboard
npm ci
```

### 2. Build the application

```bash
npm run build
```

### 3. Set the operator password

Run the password setup script in an interactive terminal on the machine:

```bash
npm run operator:password
```

Enter a password of at least 12 characters. The script writes an scrypt hash and a fresh session signing key to `data/operator.json`.

### 4. Configure environment

Copy the example configuration to `.env.selfhosted` in your repository root:

```bash
cp .env.selfhosted.example .env.selfhosted
```

Verify that `.env.selfhosted` contains:
```env
AGENT_HOST_MODE=self-hosted
HOSTNAME=127.0.0.1
PORT=3000
DATABASE_PATH=./data/dashboard.db
```

Keep `HOSTNAME=127.0.0.1` so the server binds only to loopback. Tailscale provides encrypted external access.

### 5. Install the background service

Install a user service so Command Center and its agent runner restart automatically on boot.

- **Linux (systemd user unit)**:
  1. Copy `scripts/service/command-center.service` to `~/.config/systemd/user/command-center.service`.
  2. Edit the unit file: replace `/path/to/Ai-Dashboard` with your repository path, and adjust `ReadWritePaths=` for your data and worktree paths.
  3. Reload and enable:
     ```bash
     systemctl --user daemon-reload
     systemctl --user enable --now command-center.service
     ```
  4. Check status with `systemctl --user status command-center.service`.

- **macOS (launchd LaunchAgent)**:
  1. Copy `scripts/service/com.commandcenter.selfhosted.plist` to `~/Library/LaunchAgents/com.commandcenter.selfhosted.plist`.
  2. Edit the plist file: replace `/path/to/Ai-Dashboard` and log paths with your actual paths. Ensure `PATH` in `EnvironmentVariables` contains Node and agent CLIs.
  3. Load the agent:
     ```bash
     launchctl load ~/Library/LaunchAgents/com.commandcenter.selfhosted.plist
     ```

### 6. Start Tailscale HTTPS proxy

Expose the loopback server through Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Tailscale issues and manages valid HTTPS certificates automatically for `https://<machine>.<tailnet>.ts.net`.

## Acceptance checklist

Verify the deployment using this checklist:

- [ ] **Open on phone**: In your phone's browser, open `https://<machine>.<tailnet>.ts.net`. The operator sign-in page appears.
- [ ] **Sign in**: Enter your operator password. You are redirected to the dashboard with an encrypted, `Secure; HttpOnly` session cookie.
- [ ] **Start a run**: Navigate to **Agents**, configure a task on a project, and start a run.
- [ ] **Watch live**: Verify that the run timeline, events, and terminal output stream live to your phone.
- [ ] **Approval re-authentication (5-minute rule)**: Wait more than 5 minutes after signing in, then attempt an approval action (such as merge, push, or draft PR). The system must ask you to sign in again before allowing the action.
- [ ] **Verify loopback isolation**: Check that nothing listens on the LAN interfaces:
  - On Linux: `ss -ltnp` (or `ss -ltnp | grep 3000`)
  - On macOS: `lsof -iTCP -sTCP:LISTEN` (or `lsof -iTCP:3000 -sTCP:LISTEN`)
  Output must show listening only on `127.0.0.1:3000`, never on `0.0.0.0` or a physical LAN IP.

## Troubleshooting

### Start-up refusal messages

Command Center checks its environment at launch and refuses to start if incompatible options are configured:

| Message from `startup.ts` / `bind.ts` | What it means |
| --- | --- |
| `AGENT_HOST_MODE must be exactly "self-hosted" when set.` | `AGENT_HOST_MODE` has an unrecognized value. Set `AGENT_HOST_MODE=self-hosted` in `.env.selfhosted`. |
| `Self-hosted mode cannot be used with AUTH_MODE=accounts.` | Multi-user accounts mode conflicts with self-hosted mode. Remove `AUTH_MODE=accounts`. |
| `Self-hosted mode cannot be used with DATABASE_URL.` | PostgreSQL is not used in self-hosted mode. Remove `DATABASE_URL` so local SQLite is used. |
| `Self-hosted mode cannot be used with DASHBOARD_PASSWORD.` | The single shared password setting is for hosted web mode. Remove `DASHBOARD_PASSWORD`. |
| `Self-hosted mode cannot run on Railway (<variable> is set).` | Railway environment variables were detected. Self-hosted mode is for hardware you own, not cloud containers. |
| `Self-hosted mode cannot be used with DASHBOARD_LOCAL=1.` | `DASHBOARD_LOCAL=1` is reserved for local desktop mode without authentication. Remove it. |
| `Self-hosted mode cannot be used with DESKTOP_INTERNAL_SECRET.` | This secret is reserved for the Electron desktop shell. Remove it. |
| `Self-hosted mode needs HOSTNAME set to the address to bind to, for example HOSTNAME=127.0.0.1.` | The `HOSTNAME` environment variable is missing or blank. Add `HOSTNAME=127.0.0.1` to `.env.selfhosted`. |
| `Binding to <address> exposes the dashboard on every interface.` | Wildcard binding (`0.0.0.0` or `::`) is forbidden. Bind to `127.0.0.1` instead. |
| `Bind address <address> is not allowed. Use 127.0.0.1, ::1 or localhost (LAN binding is not enabled).` | A LAN or Tailscale IP was specified for `HOSTNAME`, but `AGENT_HOST_ALLOW_LAN=1` is not set. Use `127.0.0.1` or set `AGENT_HOST_ALLOW_LAN=1`. |
| `Bind address <address> is not allowed. Use 127.0.0.1, ::1 or localhost, or a private or Tailscale address.` | `HOSTNAME` points to a public IP address. Binding to public interfaces is never allowed. |
| `Bind address <address> is a hostname; only localhost or an IP address is allowed.` | A hostname was supplied for `HOSTNAME`. Use an IP address (e.g. `127.0.0.1`) or `localhost`. |

### "Sign-in does not stick"

- **Cause**: The operator session cookie is marked `Secure`, which modern browsers only store and send over HTTPS connections.
- **Fix**: Use your Tailscale HTTPS URL (`https://<machine>.<tailnet>.ts.net`) rather than an unencrypted HTTP URL (such as `http://<IP>:3000`).

### "Sign-in not set up" page (HTTP 503)

- **Cause**: The operator credentials file (`data/operator.json`) has not been generated yet.
- **Fix**: Run `npm run operator:password` directly in an interactive terminal on the host machine to choose an operator password, then reload the page.

### Forgot password

- **Fix**: Run `npm run operator:password` again on the host machine. Setting a new password updates the hash and rotates the session signing key, which immediately invalidates all existing sessions and signs everyone out. A server restart is not needed.
