<p align="center">
  <a href="https://llmgateway.io">
    <img src="https://llmgateway.io/opengraph-image.png" alt="LLM Gateway" width="420">
  </a>
</p>

<p align="center">DevPass Code — the terminal coding agent for <a href="https://llmgateway.io">LLM Gateway</a>.</p>

<p align="center">
  <a href="https://github.com/theopenco/devpass-code"><img alt="Repo" src="https://img.shields.io/badge/theopenco-devpass--code-1f6feb?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

---

**DevPass Code** is a rebranded fork of [opencode](https://github.com/anomalyco/opencode) that talks to a single upstream: the **LLM Gateway** OpenAI-compatible API. It ships with exactly two providers, a one-click terminal login, and the LLM Gateway Smart Router.

### Providers

| Provider | Use it when… |
| --- | --- |
| **LLM Gateway** | You pay as you go with credits / your own LLM Gateway API key. |
| **LLM Gateway DevPass** | You have a DevPass coding subscription. Billing is handled automatically by the gateway. |

Both route to `https://api.llmgateway.io/v1` and send an `x-source: devpass-code` header so DevPass usage is attributed correctly. The model catalog comes straight from the gateway's `/v1/models`, so every text model LLM Gateway serves is available.

### Smart Router

Pick **Smart Router** in the model picker and DevPass Code chooses the model for you, one user turn at a time. Before each turn a decision model from the [LLM Gateway decision catalog](https://llmgateway.io/models?filters=1&decisions=true) reads your request and picks the cheapest tier that can handle it:

| Tier | Default model | Used for |
| --- | --- | --- |
| fast | `claude-haiku-5-5` | Questions, lookups, small edits |
| balanced | `claude-sonnet-5-5` | Typical multi-step coding |
| frontier | `claude-opus-5-5` | Large refactors, deep debugging, architecture |

Every tool step of a turn stays on the chosen model, so prompt caching keeps working. Titles and compaction always use the fast tier.

Choose the decision model with the variant picker (the same control that sets reasoning effort on other models): `gpt-6-luna-decisions`, `microsoft-decision-1`, or `jev-1.13.0`. Decision models are billed on input tokens only.

- `DEVPASS_SMART_ROUTER_MODELS=fast,balanced,frontier` — replace the model behind each tier.
- `DEVPASS_SMART_ROUTER_DECISION_MODEL` — default decision model when no variant is selected (defaults to `jev-1.13.0`).

### Tabs

Sessions open as tabs. Run several agents side by side, switch with the keyboard or mouse, and see at a glance which tab is working, waiting for you, or done. Tabs are on by default; set `"tabs": { "mode": "off" }` in your TUI config to turn them off, `"layout": "vertical"` for a sidebar, or `"scope": "global"` to share tabs across directories.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/theopenco/devpass-code/main/install | bash
```

Or with a package manager:

```bash
npm i -g devpass-code            # or: bun / pnpm / yarn
brew install theopenco/tap/devpass-code   # macOS & Linux
paru -S devpass-code-bin         # Arch Linux (AUR)
```

Run it with Docker:

```bash
docker run -it --rm ghcr.io/theopenco/devpass-code
```

Windows binaries (`devpass-code-windows-*.zip`) are attached to every [GitHub release](https://github.com/theopenco/devpass-code/releases); `npm i -g devpass-code` works there too.

Already installed? Upgrade in place with `devpass-code upgrade`.

### Run from source

```bash
bun install
bun dev
```

### Authenticate

Open the model picker or run `/connect`, pick **LLM Gateway** or **LLM Gateway DevPass**, then choose **Log in with browser**. DevPass Code opens `https://llmgateway.io/connect/cli`, you approve the connection in your browser, and the freshly minted API key is handed back to a local loopback server on your machine. Prefer to paste a key? Choose **Paste an API key** instead.

### Configuration

Config lives in `~/.config/devpass-code/devpass-code.jsonc` and per project in `devpass-code.json` or `.devpass-code/`. Existing `opencode.json` files and `.opencode/` directories are read too.

- `DEVPASS_APP_URL` / `LLMGATEWAY_APP_URL` — override the dashboard URL used for browser login (defaults to `https://llmgateway.io`).
- `LLMGATEWAY_API_URL` — override the gateway API (defaults to `https://api.llmgateway.io/v1`).
- `LLMGATEWAY_API_KEY` — provide an API key via the environment instead of logging in.

---

### Credits & license

DevPass Code is a fork of [opencode](https://github.com/anomalyco/opencode) by the opencode authors, used under the MIT License. This fork rebrands the tool and restricts it to LLM Gateway. See [LICENSE](LICENSE).
