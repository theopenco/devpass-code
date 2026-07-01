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

**DevPass Code** is a rebranded fork of [opencode](https://github.com/anomalyco/opencode) that talks to a single upstream: the **LLM Gateway** OpenAI-compatible API. It ships with exactly two providers and a Claude-Code-style one-click terminal login — no per-provider API keys to juggle.

### Providers

| Provider | Use it when… |
| --- | --- |
| **LLM Gateway** | You pay as you go with credits / your own LLM Gateway API key. |
| **LLM Gateway DevPass** | You have a DevPass coding subscription. Billing is handled automatically by the gateway. |

Both route to `https://api.llmgateway.io/v1` and send an `x-source: devpass-code` header so DevPass usage is attributed correctly.

### Install & run (from source)

```bash
bun install
bun run packages/devpass-code/src/index.ts --help
```

### Authenticate

```bash
devpass-code auth login
```

Pick **LLM Gateway** or **LLM Gateway DevPass**, then choose **Log in with browser**. DevPass Code opens `https://llmgateway.io/connect/cli`, you approve the connection in your browser, and the freshly minted API key is handed back to a local loopback server on your machine — the terminal picks up right where it left off. Prefer to paste a key? Choose **Paste an API key** instead.

Credentials are stored at `~/.local/share/devpass-code/auth.json`.

### Configuration

- `DEVPASS_APP_URL` / `LLMGATEWAY_APP_URL` — override the dashboard URL used for browser login (defaults to `https://llmgateway.io`).
- `LLMGATEWAY_API_KEY` — provide an API key via the environment instead of logging in.

---

### Credits & license

DevPass Code is a fork of [opencode](https://github.com/anomalyco/opencode) by the opencode authors, used under the MIT License. This fork rebrands the tool and restricts it to LLM Gateway. See [LICENSE](LICENSE).
