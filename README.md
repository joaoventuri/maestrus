<div align="center">

# Maestrus

**The maestro of your AI coding agents.**

One conductor for every codebase you own — desktop, web and phone.
Runs entirely on your machines, with your accounts and your tokens.

[![License](https://img.shields.io/badge/license-Apache--2.0-ff8a3d)](LICENSE)
[![Platforms](https://img.shields.io/badge/desktop-Windows%20%7C%20macOS%20%7C%20Linux-ff8a3d)](#install)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-ff8a3d)](#run-your-own-server)

</div>

---

## What it is

Claude Code and Codex are excellent at one project at a time, in one terminal,
on one machine. Maestrus is the layer above that: **many projects, many
accounts, one orchestra.**

Each codebase you own becomes a *system* Maestrus can drive — a local folder, a
GitHub repo, a server over SSH. From a single chat you dispatch work to
different projects in parallel, like a conductor cueing every section.

It is not a hosted service and it does not proxy your prompts. The agent runs
on **your** machine, under **your** subscription. Maestrus conducts.

## Why people use it

**Many projects at once.** Dispatch a task to one project, switch to another
while it works, come back when it is done. Each project keeps its own
conversation, model, permissions and memory.

**Your account, your tokens.** Engines are pluggable: the Claude Code CLI under
your own subscription, the Codex CLI, or a direct API key you control. Nothing
is metered by us because there is no *us* in the request path.

**Several accounts, no juggling.** Hit a usage limit mid-task and switch to
another account without losing the conversation — per project, in real time.

**Keep working from anywhere.** One machine acts as **host**; laptop, browser
and phone connect to it through a relay. Close the laptop and the work keeps
running on the host.

**Conduct by voice.** Jarvis Mode turns a session into a conversation — speak,
the agent works, the answer comes back spoken. Wake word included.

**Scheduled routines.** Cron-style jobs per project, resolved in the host's
timezone: *"every weekday at 9am, review yesterday's diff and open issues."*

## Screens

| Desktop | Phone (PWA) | Browser |
|---|---|---|
| Full orchestrator, voice mode, Kanban, file browser | Same conversations, install-free | Zero-install client for any machine |

## Install

### Desktop app

Grab the installer for your platform from
[**Releases**](../../releases/latest):

| Platform | File |
|---|---|
| Windows | `maestrus-win-x.y.z.exe` |
| macOS (Apple Silicon) | `maestrus-mac-x.y.z.dmg` |
| Linux | `maestrus-x.y.z.AppImage` |

The app auto-updates from GitHub Releases. Nothing else to configure.

### Build from source

```bash
git clone https://github.com/joaoventuri/maestrus.git
cd maestrus
npm install
npm run dev          # desktop app in development
npm run build        # installer for the current platform
```

Requires Node 22+. The build downloads the runtimes it bundles (Node, Git,
Claude CLI) on first run.

## Connect an engine

Maestrus drives agents you already have. Pick per project:

| Engine | What it uses | Setup |
|---|---|---|
| **Claude** | Claude Code CLI, your subscription | `claude auth login`, then pick it in the project |
| **Codex** | Codex CLI, your ChatGPT plan | `codex auth login` |
| **Claude API** | Anthropic API key | paste the key in Settings |
| **Codex API** | OpenAI API key | paste the key in Settings |

> Authentication happens between you and the provider, in your terminal.
> Maestrus reads the credential the CLI already stored — it never brokers your
> login.

## Run your own server

Want the host to be a server instead of your desktop? The self-hosted stack
runs the orchestrator 24/7 and serves the web app and the PWA from the same
port.

```bash
cd selfhost
cp .env.example .env       # set MAESTRUS_SELFHOST_SECRET
docker compose up -d
```

Then open `http://your-server:8080` in a browser, or point the desktop app at
it with **Connect to my server** (URL + secret). Full guide in
[`selfhost/README.md`](selfhost/README.md).

Nothing calls home. There is no license check, no telemetry and no account.

## How it works

```
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│  Desktop     │        │   Browser    │        │  Phone (PWA) │
└──────┬───────┘        └──────┬───────┘        └──────┬───────┘
       │                       │                       │
       └───────────────┬───────┴───────────────┬───────┘
                       │        relay (ws)     │
                       ▼                       ▼
                ┌─────────────────────────────────┐
                │            HOST                 │
                │  projects · sessions · queue    │
                │  spawns: claude / codex CLI     │
                └─────────────────────────────────┘
```

The **host** owns the projects, the conversation history and the prompt queue.
Clients are views onto it — which is why closing your laptop does not stop a
running turn, and why a prompt typed on the phone survives a reconnect.

| Piece | Path | Role |
|---|---|---|
| Desktop app | `electron/` | Main process: IPC, agent spawn, queue, SSH, host mode |
| UI | `renderer/` | React app — desktop, web and mobile share it |
| Relay | `relay/` | WebSocket broker so clients reach the host |
| Self-host | `selfhost/` | Docker Compose stack |
| Server | `maestrus-server/` | Headless orchestrator for containers |

## Contributing

Issues and pull requests are welcome. `npm test` runs the suite; please keep it
green and add a test when you fix a bug — several tests in this repo exist
because a regression shipped once and should not ship twice.

## License

[Apache License 2.0](LICENSE).

Maestrus orchestrates third-party agents; it does not include them. The Claude
Code CLI and the Codex CLI are distributed by their vendors under their own
terms, and your use of them is governed by your agreement with those vendors.
