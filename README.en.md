# Pinned passages · dsh-pins

[中文](README.md) | **English**

> Pin selected passages from a conversation into a right-sidebar note wall. Click one to jump back to its source, or type `@` in the composer to quote it into your message.

A Web UI plugin for [DeepSeek Harness](https://github.com/deepseek-ai). What gets lost while reading a long reply is *where was I, and which sentences actually mattered* — select, pin, come back. That is the whole of it.

## Install

Requires the Harness Web UI (`dsh web`). One command — it also **selects the bundle into your profile** for you:

```bash
# from npm (recommended)
dsh plugin --profile web add dsh-pins

# from GitHub (when you want the latest commit)
dsh plugin --profile web add github:ylw-ux/dsh-pins-fixtool

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
- **Your data stays in your browser.** Passages live in `localStorage`: never uploaded, never synced, no account. Clearing site data deletes all of it. Upgrading does not clear your passages — nor the standalone tags you created but have not used yet.
- A 「固定片段」 entry with a count appears at the foot of the left sidebar (next to Settings); the side panel can also be opened from its tab in the right column.

---

## Usage

### 1. Pin a passage

Select text in the conversation; an action bar appears above the selection:

| Button | What it does |
|---|---|
| **Pin** (固定) | Saves it to the right column and leaves a durable mark on the source text |
| **Tag** (标签) | Opens the tag box; Enter applies the tag to this passage |
| **Pin and quote** (固定并引用) | Pins it and puts the quote into the composer |
| **Quote** (引用) | Only puts the quote into the composer |
| **Copy** (复制) | Only copies the raw text |

- `Alt` + `P`: pin / unpin the current selection
- **Hover a card**: it expands in place (capped at `min(60cqh, 420px)`) and scrolls internally
- **Click a card's text**: always jumps back to the source, centred on the selected passage
- `#` / `❞` / `⧉` / `✕` on a card: edit tags / quote into the composer / copy the raw text / unpin

> **DSH 0.2.2 ships its own selection toolbar, 「引用文本」 (Quote text).** Both are shown by default: the host's above the selection, this plugin's below it (pin / tag / quote live on the lower one).
> To keep only one, go to **Settings → Plugins → Pinned passages › Selection toolbar**.

### 2. Tags: type a letter and pick from the ones you already have

Type in a card's tag box, or in the bar's tag box, and the existing tags that match appear right below:

| Action | Effect |
|---|---|
| Typing | Prefix matches first, then by how often a tag is used |
| `↓` / `↑` | Move the highlight **inside the list** (the card list outside does not move) |
| `Enter` | With a highlight you reached by arrow: applies it. Otherwise: creates the name you typed |
| Click | Applies that tag |
| A new name | A 「创建 #xxx」 row appears below, showing the normalised result |

Details:

- **The list does not flicker while an IME composes**: after the characters commit it re-matches immediately. Enter during composition commits the IME, it does not submit a tag.
- Tags already on this passage are marked 「已有」; clicking one only says so, it never adds a duplicate.
- A tag name is capped at 24 characters; leading `#` and repeated whitespace are normalised away.
- **Tags are one vocabulary across conversations**: a tag created anywhere can be picked everywhere.

### 3. Create tags first, file passages later

Organising often starts with a list of names, not with the passages. Use **＋ 标签** at the right end of the panel's tools row:

| Action | Effect |
|---|---|
| Click 「＋ 标签」 | An input row opens under the tools row |
| `Enter` | Creates the tag and **keeps the focus**, so several can be added in a row |
| Duplicate | Says 「已有 #xxx」, creates nothing and keeps the text (case differences count as duplicates) |
| `Esc` / click elsewhere | Closes the row |

A freshly created tag has no passages, so it shows as **`×0`** under **「全部」› 管理全部标签** — it exists, nothing uses it yet.

- Clicking a `×0` tag **does not filter**; it explains that the tag has no passages yet (filtering by it could only produce an empty list)
- Tag any passage with it and the count becomes `×N`; the name is never duplicated
- Standalone tags appear in the 「全部」 view only: 「本对话」 counts what this conversation holds, not the global vocabulary
- At most 200 tags

### 4. Quote into a message

Two shapes, and **both carry their content — neither is a pointer**:

- 「引用 / 固定并引用」 in the bar: a quote block with its source line goes into the composer
- Type `@` in the composer: the first row is 「固定片段」; once inside, **typing filters it** (matching text and tags), and picking inserts a **reference chip**

Either way the passage really reaches the model, and never expires afterwards.

### 5. Settings: the selection toolbar and storage usage

**Settings → Plugins → Pinned passages**.

**Selection toolbar** (one of three) — DSH 0.2.2 added its own 「引用文本」, and the two would claim the same spot:

| Option | Effect |
|---|---|
| **Show both** (default) | The host's above the selection, this plugin's below it |
| **This plugin's bar only** | The host's button is hidden; its quote rendering keeps working |
| **The host's 「引用文本」 only** | This plugin's bar stays out of the way; pinning still works via `Alt+P` and the side panel |

**Storage used** (read-only; the toolbar mode above is the only changeable thing on this page):

| Figure | What it is |
|---|---|
| This plugin | passage count, characters, roughly what percentage of this origin's storage |
| Whole origin | key count, characters, roughly what percentage, with a progress bar |
| ≥90% | a reminder banner; when full, the page states plainly that new pins will not be saved |

Recalculates after pinning, deleting or re-tagging.

### 6. The side panel

| Action | Effect |
|---|---|
| Header | Two views (this conversation / all), four sort orders, search, multi-select tag filter, tag management, Markdown outline export |
| Filters in the two views | **Kept separately**: a tag or search term chosen in 「全部」 does not follow you into 「本对话」, and is still there when you come back. Sort order is a global preference and is remembered |
| Left sidebar foot | The 「固定片段」 entry, with a count |
| Reference chip in the composer | Click it: the side panel opens and that card pulses |

---

## What it does not do

- **No Markdown parsing, no HTML snapshots.** What is stored is the text you selected, plus its turn and offset — readable and portable.
- **It never switches your conversation.** Clicking a card from another conversation in 「全部」 explains itself instead of moving you out of what you are reading.
- **No context injection.** Nothing is ever quietly pushed into the model's context; either you quote it, or the model asks for it explicitly (the latter is not implemented yet).
- **No hidden state.** Pinning is an explicit action, and so is deleting.

## Known limitations

- **Web only** (`platform: web`). TUI and Desktop have no such surface.
- **Anchors depend on the host's DOM contract** (`data-chat-flow-key`, `data-chat-turn`, `[data-conversation-scroll]`). If the host renames them all at once, durable marks and precise jumps break together — **your data does not** (it is still text, turn and offset), and jumping degrades to a position-based fallback. This is the one risk the plugin cannot verify for itself, so it is written down here.
- **A selection longer than 2000 characters is kept as its first 2000** (the toolbar and the success notice say so at capture time, and the card marks it 「已截断」 with a tooltip). Quotes and chips share that ceiling. Passages saved before 1.0.4 hold only their first 600 characters, and that part cannot be recovered.
- **When the same text appears several times in one message**, the jump picks the occurrence nearest the recorded offset that also passes a text check; if none does, it falls back to the whole message and marks the card 「原文未找到」.
- **The 「全部」 view sorts and filters across every conversation**; with many entries, folding groups or filtering by tag beats scrolling to the bottom.

## Compatibility

Verified on: **DSH `0.2.1-rc.5` · Node `24.14.1` · pnpm `12.6.0`** (1.0.3 and earlier were verified on `0.2.0-rc.2`).

**Since DSH `0.2.2`** the host ships its own selection toolbar, 「引用文本」. This plugin is adapted: by default it yields the band above the selection and places itself below it, and the settings can make either one the only one. The host surface is recognised through its public `data-text-interaction-surface` attribute rather than an internal class name — if the host changes that, this plugin simply behaves as if there were no host toolbar and falls back to its old placement.

The package declares **no `peerDependencies` and no `engines.dsh`**, deliberately: it imports no Harness package (the browser half only `require`s `react`; the host half is an empty `apply`), and every host interaction is feature-checked and either degrades or reports clearly. Declaring a version range I cannot verify would only block installs.

Upgrading to a newer version never touches the passages you already have, nor the standalone tags you created but have not used yet.

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
