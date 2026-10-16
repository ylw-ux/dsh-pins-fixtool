# Pinned passages · dsh-pins

[中文](README.md) | **English**

> Pin selected passages from a conversation into a right-sidebar note wall. Click one to jump back to its source, or type `@` in the composer to quote it into your message.

A Web UI plugin for [DeepSeek Harness](https://github.com/deepseek-ai). What gets lost while reading a long reply is *where was I, and which sentences actually mattered* — select, pin, come back. That is the whole of it.

## Install

Requires the Harness Web UI (`dsh web`). One command — it also **selects the bundle into your profile** for you:

```bash
# from GitHub
dsh plugin --profile web add github:ylw-ux/dsh-pins

# once published to npm
dsh plugin --profile web add dsh-pins

# from a local directory (development; creates a link dependency, so edits
# apply after a page refresh)
dsh plugin --profile web add D:\path\to\dsh-pins
```

Then **refresh the browser**. If nothing happens, restart `dsh`.

Uninstall:

```bash
dsh plugin --profile web remove dsh-pins
```

Worth knowing:

- **No pnpm build approval.** The package has no `prepare` / `postinstall` script and no build step — plain JavaScript, usable the moment it installs, no "allow build scripts" prompt.
- **It touches nothing outside your profile.** It adds one dependency to the profile's `package.json`, one name to `dsh.profile.bundles`, and its own patch row.
- **Your data stays in your browser.** Passages live in `localStorage` (key `dsh-pins/v1`): never uploaded, never synced, no account. Clearing site data deletes all of it.
- A 「固定片段」 entry with a count appears at the foot of the left sidebar (next to Settings); the side panel can also be opened from its tab in the right column.

## Usage

| Action | Effect |
|---|---|
| Select text | An action bar appears above the selection: **Pin / Tag / Pin and quote / Quote / Copy** |
| `Alt` + `P` | Pin or unpin the current selection |
| Hover a card | The card expands in place (capped at `min(60cqh, 420px)`), scrollable inside |
| Click a card's text | **Always jumps back to the source**, centred on the selected passage |
| `#` / `❞` / `⧉` / `✕` on a card | Edit tags / quote into the composer / copy the raw text / unpin |
| Type `@` in the composer | The first row is 「固定片段」; once inside, **typing filters it** (matching text and tags) and picking inserts a **reference chip** |
| Click a reference chip | Opens the side panel and pulses that card |
| Panel header | Two views (this conversation / all), four sort orders, search, multi-select tag filter, tag management, Markdown outline export |
| Filters in the two views | **Kept separately**: a tag or search term chosen in 「全部」 does not follow you into 「本对话」, and is still there when you come back. Sort order is a global preference and is remembered |

Quoting comes in two shapes, and **both carry their content — neither is a pointer**: a quote block pasted straight into the composer with its source line, or a **reference chip** that the plugin expands into the full quote just before sending. Either way the passage really reaches the model, and never expires afterwards.

## What it does not do

- **No Markdown parsing, no HTML snapshots.** What is stored is the text you selected, plus its turn and offset — readable and portable.
- **It never switches your conversation.** Clicking a card from another conversation in 「全部」 explains itself instead of moving you out of what you are reading.
- **No context injection.** Nothing is ever quietly pushed into the model's context; either you quote it, or the model asks for it explicitly (the latter is not implemented yet).
- **No hidden state.** Pinning is an explicit action, and so is deleting.

## Known limitations

- **Web only** (`platform: web`). TUI and Desktop have no such surface.
- **Anchors depend on the host's DOM contract** (`data-chat-flow-key`, `data-chat-turn`, `[data-conversation-scroll]`). If the host renames them all at once, durable marks and precise jumps break together — **your data does not** (it is still text, turn and offset), and jumping degrades to a position-based fallback. This is the one risk the plugin cannot verify for itself, so it is written down here.
- **A selection longer than 600 characters is kept as its first 600** (the card says 「已截断」). Quotes and chips share that ceiling.
- **When the same text appears several times in one message**, the jump picks the occurrence nearest the recorded offset that also passes a text check; if none does, it falls back to the whole message and marks the card 「原文未找到」.

## Compatibility

Verified on: **DSH `0.2.0-rc.2` · Node `24.14.1` · pnpm `12.6.0`**.

The package declares **no `peerDependencies` and no `engines.dsh`**, deliberately: it imports no Harness package (the browser half only `require`s `react`; the host half is an empty `apply`), and every host interaction is feature-checked and either degrades or reports clearly. Declaring a version range I cannot verify would only block installs.

## Development

```
dsh-pins/
├── package.json         bundle manifest: dsh.bundle.patch + dsh.client
├── cordis.patch.yml     inserts one row into the profile
├── index.js             host half (a reserved pinsHost service, currently empty)
├── client.js            browser half: the entire plugin lives in this one file
├── locale/{zh,en}.json  display name and description (the meta.title the marketplace reads)
├── icon.svg             icon (≤ 256 KiB)
└── docs/                install troubleshooting (Chinese)
```

For local development, `dsh plugin --profile web add <absolute path>` installs it as a link dependency; edit `client.js` and refresh the page. The `plugin_manager` tool and the Web Plugins page manage the same profile state.

## License

[MIT](LICENSE)
