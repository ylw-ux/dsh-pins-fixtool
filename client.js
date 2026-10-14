/**
 * dsh-pins — browser half.
 *
 * What it adds to the Harness Web UI:
 *   1. a floating action bar over a text selection inside the conversation
 *      (pin / tag / copy), rendered in `shell.overlay`;
 *   2. a right-Sidebar tab, "Pinned passages", listing the pins of the
 *      on-screen Session (or of every Session), each card clamped to at most
 *      three lines, with tag chips and click-to-jump back to the source message;
 *   3. durable state in the browser, keyed by Session id.
 *
 * Anchoring follows the W3C Web Annotation advice: a pin is addressed by the
 * message it came from (the chat timeline's own `data-chat-flow-key`, which the
 * Conversation assembler materialises and keeps stable), and by a quote
 * selector (exact + prefix + suffix) with a relative character offset. No
 * absolute DOM position is ever stored.
 *
 * Failures are reported, never silent: a selection outside a message node, a
 * selection spanning two messages, and a missing Host/Sidebar service each
 * surface as console errors or an in-panel notice instead of a wrong pin.
 */

window.__ModuleLoader__.load({
  id: 'dsh-pins',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    //#region constants

    const PKG = 'dsh-pins';
    const TAB_KIND = 'dsh-pins';
    const TAB_ID = 'dsh-pins';
    const STATE_KEY = 'dsh-pins/v1';
    const MODE_KEY = 'dsh-pins/mode';
    const MAX_CHARS = 600;
    const TOOLBAR_HEIGHT = 40;
    const TOOLBAR_WIDTH = 220;
    /** How far from the recorded offset a re-located passage may sit, in characters. */
    const LOCATE_WINDOW = 4000;

    const NODE_SELECTOR = '[data-chat-flow-key], [data-chat-node-key]';

    /** Cross-component signals inside the plugin (jump happened, filter requested, notice). */
    const PINS_EVENTS = new EventTarget();

    //#endregion

    //#region storage and store

    function readJson(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
      } catch {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    function normalizeData(raw) {
      const data = { version: 1, order: [], sessions: {}, mode: readJson(MODE_KEY, 'session') };
      if (typeof raw !== 'object' || raw === null) return data;
      if (raw.sessions && typeof raw.sessions === 'object') data.sessions = raw.sessions;
      if (Array.isArray(raw.order)) data.order = raw.order.filter((id) => typeof id === 'string');
      data.mode = raw.mode === 'all' ? 'all' : 'session';
      return data;
    }

    function relTime(ts) {
      if (typeof ts !== 'number' || ts <= 0) return '';
      const diff = Date.now() - ts;
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      const days = Math.floor(diff / 86_400_000);
      if (days < 30) return `${days} 天前`;
      const date = new Date(ts);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function sourceLabel(pin) {
      const kind = pin.anchor?.kind;
      if (kind === 'user') return '我的提问';
      if (kind === 'assistant-step') return '模型回复';
      if (typeof kind === 'string' && kind !== '') return kind;
      return '消息';
    }

    /**
     * Heading for one Session in the overview.
     *
     * The Session's real title is the preferred source and is read live (see
     * `readSessionTitle`), so renaming a Session updates this heading. When no
     * title exists yet — a brand-new Session has none until its first message — the
     * newest pin's first line stands in, because that is the text the user chose
     * and will recognise.
     */
    function sessionLabel(entry) {
      // The live projection is preferred, the cached title second: the cache is only
      // written when a pin is added, so a rename would otherwise be lost for a Session
      // whose title was read after its last pin.
      if (typeof entry?.liveTitle === 'string' && entry.liveTitle.trim() !== '') return entry.liveTitle.trim();
      if (typeof entry?.title === 'string' && entry.title.trim() !== '') return entry.title.trim();
      const pins = entry?.pins ?? [];
      let newest = null;
      for (const pin of pins) {
        if (newest === null || (pin.pinnedAt ?? 0) > (newest.pinnedAt ?? 0)) newest = pin;
      }
      const text = (newest?.text ?? '').replace(/\s+/g, ' ').trim();
      if (text === '') return `${pins.length} 条固定片段`;
      return text.length > 18 ? `${text.slice(0, 18)}…` : text;
    }

    /**
     * Read one Session's title through the Client session service.
     *
     * Levels are probed most-direct first, because these shapes move between Harness
     * releases: the live Session's projection face, the session list row, the Session
     * snapshot, then the row's `projectionValues` block. Absence is not an error: a
     * Session with no title yet reports an empty string, and callers fall back to the
     * newest pin's text.
     *
     * @returns the title, or an empty string when none is available.
     */
    function readSessionTitle(context, sessionId) {
      if (!sessionId) return '';
      let sessions = null;
      try {
        sessions = context?.get?.('sessions') ?? null;
      } catch {
        return '';
      }
      if (!sessions) return '';

      const clean = (value) => (typeof value === 'string' ? value.trim() : '');
      const row = (() => {
        try {
          return sessions.list?.getSnapshot?.()?.byId?.[sessionId] ?? null;
        } catch {
          return null;
        }
      })();
      const binding = (() => {
        try {
          return sessions.binding?.(sessionId) ?? null;
        } catch {
          return null;
        }
      })();

      const attempts = [
        () => binding?.session?.projections?.faceOf?.('title')?.getSnapshot?.(),
        () => row?.projectionValues?.title,
        () => row?.title,
        () => binding?.session?.getSnapshot?.()?.title,
      ];
      for (const attempt of attempts) {
        try {
          const value = clean(attempt());
          if (value !== '') return value;
        } catch {
          /* try the next shape */
        }
      }
      return '';
    }

    /**
     * Subscribe to one Session's title changes, so a rename lands in the overview.
     *
     * The projection face is preferred: it is fed by the Host's broadcast frames
     * without instantiating the Session. The Session instance is the fallback and
     * is heavier, so it is only used when the face is unavailable.
     *
     * @returns an unsubscribe function, never `null`.
     */
    function subscribeSessionTitle(context, sessionId, onChange) {
      const noop = () => {};
      if (!sessionId) return noop;
      let sessions = null;
      try {
        sessions = context?.get?.('sessions') ?? null;
      } catch {
        return noop;
      }
      if (!sessions) return noop;
      try {
        const session = sessions.binding?.(sessionId)?.session;
        const face = session?.projections?.faceOf?.('title');
        if (face && typeof face.subscribe === 'function') {
          return face.subscribe(() => onChange());
        }
        if (session && typeof session.subscribe === 'function') {
          return session.subscribe(() => onChange());
        }
      } catch {
        /* no subscription surface; the title simply will not follow a rename */
      }
      return noop;
    }

    function normalizeTag(value) {
      return String(value ?? '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 24);
    }

    function matchesQuery(pin, query) {
      if (query === '') return true;
      const needle = query.toLowerCase();
      if (typeof pin.text === 'string' && pin.text.toLowerCase().includes(needle)) return true;
      if (Array.isArray(pin.tags)) {
        for (const tag of pin.tags) if (String(tag).toLowerCase().includes(needle)) return true;
      }
      return false;
    }

    /**
     * Rough line count a card needs, so a 1-line pin really renders as one line.
     *
     * Explicit line breaks count as lines too: a 40-character code snippet with
     * four breaks is not a one-line card just because it is short.
     */
    function cardLines(text) {
      const value = String(text ?? '');
      const breaks = value.slice(0, 600).split('\n').length;
      const wrapped = value.length <= 30 ? 1 : value.length <= 76 ? 2 : 3;
      return String(Math.max(breaks, wrapped, 1));
    }

    function newId() {
      try {
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
      } catch {
        /* fall through to the timestamp form */
      }
      return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Pin store: plain listener/subscriber state (no `useSyncExternalStore`, so the
     * plugin does not depend on a particular React minor). Every mutation persists
     * first and notifies React second.
     */
    function createStore() {
      let data = normalizeData(readJson(STATE_KEY, null));
      const listeners = new Set();
      /**
       * Why the last persistence attempt failed, or `''` when it succeeded.
       *
       * A full storage quota used to be completely silent: the UI reported "已固定 1
       * 条", the record existed in memory, and a refresh wiped it without a single
       * console line. The panel reads this and keeps a warning on screen until a
       * write succeeds again.
       *
       * `persistOk` starts true because nothing has failed yet. Starting it false made
       * a freshly loaded page announce "your work is not being saved" before the user
       * had done anything at all — and an alarm that fires when nothing is wrong is
       * worse than no alarm, because the real one stops being believed.
       */
      let persistError = '';
      let persistOk = true;

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[dsh-pins] subscriber failed', error);
          }
        }
      };

      /** Rough usage of this origin's whole storage pool, for the quota message. */
      const usageNote = () => {
        try {
          const store = globalThis.localStorage;
          if (!store) return '';
          let bytes = 0;
          for (let at = 0; at < store.length; at += 1) {
            const key = store.key(at) ?? '';
            bytes += (key.length + (store.getItem(key) ?? '').length) * 2; // UTF-16
          }
          return `（这个站点当前已用约 ${(bytes / 1024 / 1024).toFixed(2)} MB）`;
        } catch {
          return '';
        }
      };

      const describeFailure = (error) => {
        const name = String(error?.name ?? '');
        if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          return `浏览器存储已满${usageNote()}：这次改动没有保存。删掉一些不再需要的固定片段，或清掉别的插件缓存后就会恢复。`;
        }
        if (globalThis.localStorage === undefined) {
          return '这个页面不允许访问本地存储：改动只存在于内存里，刷新就会丢。';
        }
        return `保存失败（${name || String(error ?? '未知原因')}）：改动没有写入本地存储。`;
      };

      /**
       * Write the whole state, then tell subscribers what happened.
       *
       * @returns whether both keys were written.
       */
      const commit = () => {
        let failure = '';
        try {
          if (globalThis.localStorage === undefined) throw new Error('localStorage unavailable');
          globalThis.localStorage.setItem(STATE_KEY, JSON.stringify(data));
          globalThis.localStorage.setItem(MODE_KEY, JSON.stringify(data.mode));
        } catch (error) {
          failure = describeFailure(error);
          console.error('[dsh-pins] 保存固定片段失败', error);
        }
        persistError = failure;
        persistOk = failure === '';
        notify();
        return persistOk;
      };

      const sessionOf = (sessionId, create) => {
        const key = String(sessionId);
        let entry = data.sessions[key];
        if (!entry || typeof entry !== 'object') {
          if (!create) return undefined;
          entry = { pins: [], firstAt: Date.now(), updatedAt: Date.now() };
          data.sessions[key] = entry;
        }
        if (!Array.isArray(entry.pins)) entry.pins = [];
        return entry;
      };

      const touch = (sessionId, title) => {
        const key = String(sessionId);
        data.order = [key, ...data.order.filter((id) => id !== key)];
        const entry = sessionOf(key, true);
        if (typeof title === 'string' && title.trim() !== '') entry.title = title.trim();
        entry.updatedAt = Date.now();
      };

      const api = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /**
         * Whether the last write reached local storage.
         *
         * The panel shows a standing warning whenever this is false; a mutation that
         * failed silently is worse than one that failed loudly.
         */
        storageStatus() {
          return { ok: persistOk && persistError === '', error: persistError };
        },
        /** Whether the most recent mutating call reached local storage. */
        lastPersisted: true,
        getMode() {
          return data.mode === 'all' ? 'all' : 'session';
        },
        setMode(mode) {
          data.mode = mode === 'all' ? 'all' : 'session';
          api.lastPersisted = commit();
        },
        /** Pins of one Session in display order: the Session's own order, else source order. */
        list(sessionId) {
          const entry = sessionOf(sessionId, false);
          if (!entry || entry.pins.length === 0) return [];
          if (Array.isArray(entry.order) && entry.order.length > 0) {
            const byId = new Map(entry.pins.map((pin) => [pin.id, pin]));
            const ordered = [];
            for (const id of entry.order) {
              const pin = byId.get(id);
              if (pin) {
                ordered.push(pin);
                byId.delete(id);
              }
            }
            for (const pin of entry.pins) if (byId.has(pin.id)) ordered.push(pin);
            return ordered;
          }
          // Source order, by Turn. `seq` is not the primary key: it was hardcoded 0
          // for a long time, so existing pins carry none, while `turn` was always
          // captured from the row and is what the conversation itself is ordered by.
          return [...entry.pins].sort((a, b) => {
            const turnDelta = (a.anchor?.turn ?? 0) - (b.anchor?.turn ?? 0);
            if (turnDelta !== 0) return turnDelta;
            const seqDelta = (a.anchor?.seq ?? 0) - (b.anchor?.seq ?? 0);
            if (seqDelta !== 0) return seqDelta;
            return (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0);
          });
        },
        count(sessionId) {
          return sessionOf(sessionId, false)?.pins.length ?? 0;
        },
        /** `[sessionId, entry]` for every Session holding pins, most recently pinned first. */
        sessions() {
          const rows = [];
          for (const [sessionId, entry] of Object.entries(data.sessions)) {
            if (!entry || !Array.isArray(entry.pins) || entry.pins.length === 0) continue;
            rows.push([sessionId, entry, typeof entry.updatedAt === 'number' ? entry.updatedAt : 0]);
          }
          rows.sort((a, b) => b[2] - a[2]);
          return rows.map(([sessionId, entry]) => [sessionId, entry]);
        },
        tags(sessionId) {
          const seen = new Set();
          for (const pin of api.list(sessionId)) {
            for (const tag of pin.tags ?? []) seen.add(tag);
          }
          return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        },
        /**
         * Delete a tag from every pin, across every Session.
         *
         * The overview has one tag list over all Sessions, and the per-Session view
         * manages only its own: a delete must never reach into conversations the user
         * is not looking at.
         *
         * @param sessionId - the Session to clear, or `undefined` for all of them.
         * @returns how many pins the tag was removed from.
         */
        removeTagEverywhere(sessionId, tag) {
          if (sessionId === undefined || sessionId === null) {
            let touched = 0;
            for (const id of Object.keys(data.sessions)) touched += api.removeTagEverywhere(id, tag);
            return touched;
          }
          const entry = sessionOf(sessionId, false);
          if (!entry) return 0;
          let touched = 0;
          for (const pin of entry.pins) {
            const current = pin.tags ?? [];
            if (!current.includes(tag)) continue;
            pin.tags = current.filter((each) => each !== tag);
            touched += 1;
          }
          if (touched > 0) {
            entry.updatedAt = Date.now();
            api.lastPersisted = commit();
          }
          return touched;
        },
        get(sessionId, id) {
          return sessionOf(sessionId, false)?.pins.find((pin) => pin.id === id);
        },
        /** The pin for one passage, if that exact passage is already pinned. */
        find(sessionId, anchor) {
          return sessionOf(sessionId, false)?.pins.find((pin) => sameAnchor(pin.anchor, anchor));
        },
        /**
         * The pin living in one message, if any.
         *
         * Tagging a live selection needs this and must not use {@link find}: the
         * stored quote is normalized while the toolbar carries the raw selection, so
         * an exact comparison can miss the pin the user just created and silently
         * create a second one. A tag action always belongs to the message the
         * selection is in, so the message key is the correct and unambiguous scope.
         */
        findByFlowKey(sessionId, flowKey) {
          if (typeof flowKey !== 'string' || flowKey === '') return undefined;
          return sessionOf(sessionId, false)?.pins.find((pin) => pin.anchor?.flowKey === flowKey);
        },
        add(sessionId, pin, title) {
          const entry = sessionOf(sessionId, true);
          // One message holds many pins; only the same passage is a duplicate.
          const existing = entry.pins.find((each) => sameAnchor(each.anchor, pin.anchor));
          if (existing) {
            // A pin created before the display form existed has no raw text; pinning
            // the same passage again upgrades it in place instead of doing nothing.
            if (typeof existing.anchor?.rawQuote !== 'string' && typeof pin.anchor?.rawQuote === 'string') {
              existing.anchor = { ...existing.anchor, ...pin.anchor };
              if (typeof pin.text === 'string' && pin.text !== '') existing.text = pin.text;
              entry.updatedAt = Date.now();
              api.lastPersisted = commit();
            }
            return existing;
          }
          const record = {
            ...pin,
            // Display text keeps the selection's line breaks; the anchor keeps the
            // normalized form the locator and the search work in.
            text: typeof pin.text === 'string' && pin.text !== '' ? pin.text : (pin.anchor?.quote ?? ''),
            id: newId(),
            pinnedAt: Date.now(),
          };
          entry.pins = [...entry.pins, record];
          touch(sessionId, title);
          // Told to the caller, never written into the record: whether this write
          // reached storage is a fact about this moment, not about the pin.
          api.lastPersisted = commit();
          return record;
        },
        remove(sessionId, id) {
          const entry = sessionOf(sessionId, false);
          if (!entry) return;
          entry.pins = entry.pins.filter((pin) => pin.id !== id);
          if (Array.isArray(entry.order)) entry.order = entry.order.filter((each) => each !== id);
          entry.updatedAt = Date.now();
          if (entry.pins.length === 0) delete data.sessions[String(sessionId)];
          api.lastPersisted = commit();
        },
        /**
         * Add a tag to one pin.
         *
         * Adding is deliberately not a toggle: an input that removes a label when you
         * type the same word again is impossible to predict, so removal lives on the
         * chips and the trash buttons alone. A repeat add reports `false` and the
         * caller tells the user the tag is already there.
         *
         * @returns whether the pin gained the tag.
         */
        addTag(sessionId, id, tag) {
          const pin = api.get(sessionId, id);
          if (!pin) return false;
          const current = pin.tags ?? [];
          if (current.includes(tag)) return false;
          pin.tags = [...current, tag];
          const entry = sessionOf(sessionId, true);
          entry.updatedAt = Date.now();
          api.lastPersisted = commit();
          return true;
        },
        /** Remove one tag from one pin. @returns whether anything changed. */
        removeTag(sessionId, id, tag) {
          const pin = api.get(sessionId, id);
          if (!pin) return false;
          const current = pin.tags ?? [];
          if (!current.includes(tag)) return false;
          pin.tags = current.filter((each) => each !== tag);
          const entry = sessionOf(sessionId, true);
          entry.updatedAt = Date.now();
          api.lastPersisted = commit();
          return true;
        },
      };

      return api;
    }

    const store = createStore();

    //#endregion

    //#region selection reading

    /** Injectable seam over `window.getSelection`, so the reading logic stays unit-testable. */
    const dom = {
      range() {
        try {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
          return selection.getRangeAt(0);
        } catch {
          return null;
        }
      },
    };

    /** Which kind of markdown block a selection landed in, as the DOM reveals it at pin time. */
    function blockKindOf(element) {
      try {
        if (element.closest('pre, [data-code-block], .md-code-block')) return 'code';
        if (element.closest('table')) return 'table';
        if (element.closest('blockquote')) return 'quote';
        if (element.closest('li')) return 'list';
      } catch {
        /* an element detached mid-read falls back to prose */
      }
      return 'prose';
    }

    /** The language label a fenced code block advertises, when the DOM carries one. */
    function codeLanguageOf(element) {
      try {
        const banner = element.closest('[data-code-block], .md-code-block')?.querySelector('[data-code-block-banner], [data-lang], code[class*="language-"]');
        const raw =
          banner?.getAttribute?.('data-lang') ??
          /language-([\w+#-]+)/.exec(banner?.className ?? '')?.[1] ??
          '';
        return String(raw).trim().slice(0, 16);
      } catch {
        return '';
      }
    }

    /**
     * Read a browser selection as a durable pin anchor.
     *
     * Three things are captured, and each has one job:
     *
     * - `raw` keeps the selection exactly as the DOM serialized it, line breaks
     *   and indentation included. It is the display text, the copy source, and the
     *   first choice when re-locating the passage.
     * - `quote` is the whitespace-normalized form. It is the only basis for search,
     *   tag matching, and de-duplication of the same passage.
     * - `block`, `lang`, and `partial` are facts only observable while the DOM is in
     *   front of us; they tell the renderer how to lay the passage out later.
     *
     * @returns a delivery-ready anchor, or `{ ok: false, reason }` when the
     *   selection is empty, outside a message node, or spans several messages.
     */
    function readAnchor(range) {
      if (!range) return { ok: false, reason: 'empty' };
      const rawText = (() => {
        try {
          return String(range.toString());
        } catch {
          return '';
        }
      })();
      const normalized = rawText.replace(/\s+/g, ' ');
      const text = normalized.trim() === '' ? '' : normalized;
      if (text === '') return { ok: false, reason: 'empty' };

      const startElement = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const endElement = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
      if (!startElement || !endElement) return { ok: false, reason: 'empty' };

      const source = startElement.closest?.(NODE_SELECTOR) ?? null;
      if (!source) return { ok: false, reason: 'outside' };
      const target = endElement.closest?.(NODE_SELECTOR) ?? null;
      const sourceKey = source.getAttribute('data-chat-flow-key') ?? source.getAttribute('data-chat-node-key');
      const targetKey = target?.getAttribute('data-chat-flow-key') ?? target?.getAttribute('data-chat-node-key');
      if (!sourceKey || sourceKey !== targetKey) return { ok: false, reason: 'multi' };

      const truncated = text.length > MAX_CHARS;
      // Cut the raw selection first and normalize the cut, so the display text and the
      // locator quote always describe the same characters. Slicing each in its own
      // character space made the display form shorter than "the first MAX_CHARS" on
      // whitespace-dense selections, and left the two pointing at different passages.
      const rawQuote = truncated ? rawText.slice(0, MAX_CHARS) : rawText;
      const quote = truncated ? rawQuote.replace(/\s+/g, ' ') : text;

      let offset = -1;
      let rawOffset = -1;
      try {
        const before = document.createRange();
        before.selectNodeContents(source);
        before.setEnd(range.startContainer, range.startOffset);
        const beforeText = String(before.toString());
        rawOffset = beforeText.length;
        offset = beforeText.replace(/\s+/g, ' ').length;
      } catch {
        offset = -1;
        rawOffset = -1;
      }

      const singleBlock = blockKindOf(startElement) === blockKindOf(endElement) ? blockKindOf(startElement) : 'prose';

      // Whether the selection is only part of its block: a fact only observable at
      // pin time, and the one the renderer needs to say "this is a fragment".
      const partial = (() => {
        try {
          const block = startElement.closest('pre, p, li, blockquote, table, h1, h2, h3, h4, h5, h6') ?? startElement;
          const whole = String(block.textContent ?? '').replace(/\s+/g, ' ').trim();
          return whole !== '' && whole !== text.trim();
        } catch {
          return false;
        }
      })();

      return {
        ok: true,
        anchor: {
          sessionId: '',
          flowKey: sourceKey,
          node: source.getAttribute('data-chat-node-key') ?? sourceKey,
          kind: source.getAttribute('data-chat-flow-kind') ?? '',
          turn: Number(source.getAttribute('data-chat-turn') ?? 0) || 0,
          // `seq` is left out on purpose: the row does not carry it, and the value
          // has to be resolved from the turn outline when a jump needs to page
          // history. Writing a placeholder here is what made "source order" and
          // "jump to unloaded history" silently wrong.
          offset,
          rawOffset,
          rawLength: rawQuote.length,
          quote,
          rawQuote,
          block: singleBlock,
          lang: singleBlock === 'code' ? codeLanguageOf(startElement) : '',
          partial,
        },
        text: rawQuote,
        truncated,
      };
    }

    /** Whether a DOM node belongs to this plugin's own UI, so a selection there never pins. */
    function isOwnUi(node) {
      try {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        return Boolean(element?.closest?.('[data-dsh-pins]'));
      } catch {
        return false;
      }
    }

    /**
     * Whether two pins address the same passage.
     *
     * A passage is identified by its message *and* its quote: one message may hold
     * many pins, so keying on the message alone would allow only the first one and
     * treat every later selection in that message as "already pinned".
     */
    function sameAnchor(left, right) {
      if (!left || !right) return false;
      return left.flowKey === right.flowKey && left.quote === right.quote;
    }

    //#endregion

    //#region jumping back

    /**
     * Index a message node's rendered text.
     *
     * Three views of the same nodes, because three callers need different things:
     *
     * - `raw` is the text nodes concatenated exactly as the DOM serializes them,
     *   which is what `Range.toString()` returns for a whole-row selection. A
     *   stored raw quote that came from this row matches at one unique offset, so
     *   `index.raw.indexOf(rawQuote)` is an exact answer rather than an estimate.
     * - `spaced` is `raw` with every whitespace run collapsed to one space, the
     *   same normalization the selection reader applies. It locates quotes whose
     *   original whitespace changed (a re-rendered block, a collapsed blank line).
     * - `packed` is the earlier, browser-like packing. It is kept because existing
     *   pins were resolved against it.
     *
     * Each normalized view carries a map back to raw offsets, so any located
     * interval resolves to a live Range — the only thing the highlighter accepts.
     */
    function indexText(root) {
      const nodes = [];
      let raw = '';

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
          if (window.getComputedStyle(parent).display === 'none') return NodeFilter.FILTER_REJECT;
          if (parent.closest('[hidden],[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let seen = 0;
      let node = walker.nextNode();
      while (node) {
        const value = node.nodeValue;
        nodes.push({ node, start: seen, end: seen + value.length });
        raw += value;
        seen += value.length;
        node = walker.nextNode();
      }

      const buildRunView = (collapseAll) => {
        let text = '';
        const map = [0];
        for (let at = 0; at < raw.length; ) {
          if (/\s/.test(raw[at])) {
            const from = at;
            while (at < raw.length && /\s/.test(raw[at])) at += 1;
            const spansNodes = nodes.some((entry) => from < entry.start && at > entry.start);
            const boundary = collapseAll || spansNodes || /\s/.test(raw[from - 1] ?? ' ') || /\s/.test(raw[at] ?? '');
            if (boundary) {
              map[map.length - 1] = from;
              text += ' ';
              map.push(at);
            } else {
              map[map.length - 1] = from;
            }
            continue;
          }
          text += raw[at];
          map.push(at + 1);
          at += 1;
        }
        return { text, map };
      };

      const packedView = buildRunView(false);
      const spacedView = buildRunView(true);

      const rangeForRaw = (from, to) => {
        if (nodes.length === 0 || to <= from) return null;
        const first = nodes.find((entry) => from >= entry.start && from < entry.end);
        if (!first) return null;
        const last = nodes.find((entry) => to > entry.start && to <= entry.end) ?? first;
        try {
          const range = document.createRange();
          range.setStart(first.node, from - first.start);
          range.setEnd(last.node, Math.max(0, Math.min(to - last.start, last.node.nodeValue.length)));
          return range;
        } catch {
          return null;
        }
      };

      const rangeForView = (view, start, end) => {
        if (nodes.length === 0 || view.text.length === 0) return null;
        const from = view.map[Math.max(0, Math.min(start, view.text.length))];
        const to = view.map[Math.max(0, Math.min(end, view.text.length))];
        if (from === undefined || to === undefined) return null;
        return rangeForRaw(from, to);
      };

      return {
        raw,
        packed: packedView.text,
        packedMap: packedView.map,
        spaced: spacedView.text,
        spacedMap: spacedView.map,
        nodes,
        rangeFor: (start, end) => rangeForView(packedView, start, end),
        rangeForSpaced: (start, end) => rangeForView(spacedView, start, end),
        rangeForRaw,
      };
    }

    function clearPulse() {
      for (const element of document.querySelectorAll('[data-dsh-pins-flash]')) element.removeAttribute('data-dsh-pins-flash');
      try {
        globalThis.CSS?.highlights?.delete('dsh-pins-flash');
      } catch {
        /* the highlight registry is optional */
      }
    }

    /** Highlight one live Range for two seconds, through the Custom Highlight API when present. */
    function flashRange(range) {
      try {
        const registry = globalThis.CSS?.highlights;
        if (registry && typeof globalThis.Highlight === 'function') {
          const highlight = new globalThis.Highlight(range);
          registry.set('dsh-pins-flash', highlight);
          window.setTimeout(() => {
            if (registry.get('dsh-pins-flash') === highlight) registry.delete('dsh-pins-flash');
          }, 2200);
          return true;
        }
      } catch {
        /* the block-level flash still applies */
      }
      return false;
    }

    //#region persistent pin markers

    /**
     * Draw a durable marker on every pinned passage that is currently rendered.
     *
     * A pin must be findable again by eye, so the mark stays as long as the pin
     * does. Two mechanisms:
     *
     * - The CSS Custom Highlight API (`CSS.highlights`) paints a range without
     *   touching the DOM, which is the safe choice in a timeline that re-renders
     *   while it streams. Highlight ranges go stale as the document changes, so
     *   they are recomputed on a throttle.
     * - Where that API is missing, the range is wrapped in a `<mark>` styled by
     *   this plugin; each recomputation unwraps the previous one first.
     *
     * Only the Session on screen is marked, so switching Sessions never claims
     * pins that belong elsewhere.
     */
    const markerState = { sessionId: null, refreshTimer: null, refreshSoon: false, observer: null, indexCache: new WeakMap(), applying: false };

    /** Per-row text index, reused until the row's DOM changes (the observer clears it). */
    function cachedIndex(row) {
      const hit = markerState.indexCache.get(row);
      if (hit) return hit;
      const fresh = indexText(row);
      markerState.indexCache.set(row, fresh);
      return fresh;
    }

    function markedRows() {
      try {
        const found = [];
        for (const row of document.querySelectorAll('[data-chat-flow-key],[data-chat-anchor-key]')) {
          if (row.closest('[data-dsh-pins]')) continue;
          found.push(row);
        }
        return found;
      } catch {
        return [];
      }
    }

    /**
     * Locate one stored passage inside an indexed row.
     *
     * The same words often appear more than once in one message — a heading and
     * the paragraph under it, a repeated term — so "the first match wins" marks the
     * wrong place. Every candidate occurrence is therefore scored against the
     * stored offset and the closest one is chosen, and the resolved range is
     * verified to be that passage before it is returned.
     *
     * Search order, most precise first:
     *   1. the raw quote, which is exact for a pin whose row has not changed;
     *   2. the normalized quote against the same whitespace-collapsed view the
     *      selection reader used;
     *   3. the browser-like packed view, which is what existing pins were resolved
     *      against.
     *
     * `widen` grows a short quote to the surrounding word boundaries so a two-word
     * pin is still findable by eye; the widening is re-verified so it can never
     * drift onto neighbouring words.
     *
     * @returns `{ range, verdict }` — `'exact'` for a quote match, `'message'` when
     *   the passage could not be found (the caller then highlights the message).
     */
    function locateQuote(row, pin, widen) {
      try {
        const index = cachedIndex(row);
        const anchor = pin?.anchor ?? {};
        const rawQuote = typeof anchor.rawQuote === 'string' && anchor.rawQuote !== '' ? anchor.rawQuote : '';
        const normQuote = typeof anchor.quote === 'string' ? anchor.quote : '';
        if (rawQuote === '' && normQuote === '') return { range: null, verdict: 'message' };

        const hint = typeof anchor.offset === 'number' && anchor.offset >= 0 ? anchor.offset : -1;
        const near = hint < 0 ? 0 : Math.max(0, hint - LOCATE_WINDOW);
        const far = hint < 0 ? Number.MAX_SAFE_INTEGER : hint + (normQuote.length || 0) + LOCATE_WINDOW;

        /** Collect every occurrence of `needle` in `text`, closest to `hint` first. */
        const occurrences = (text, needle) => {
          const hits = [];
          if (needle === '' || text === '') return hits;
          let at = text.indexOf(needle);
          while (at >= 0 && hits.length < 200) {
            hits.push(at);
            at = text.indexOf(needle, at + 1);
          }
          if (hint < 0 || hits.length < 2) return hits;
          return hits.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
        };

        const candidates = [];
        for (const at of occurrences(index.raw, rawQuote)) {
          candidates.push({ mode: 'raw', at, length: rawQuote.length, delta: 0, verdict: 'exact' });
        }
        for (const at of occurrences(index.spaced, normQuote)) {
          candidates.push({ mode: 'spaced', at, length: normQuote.length, delta: Math.abs(at - hint), verdict: 'exact' });
        }
        for (const at of occurrences(index.packed, normQuote)) {
          candidates.push({ mode: 'packed', at, length: normQuote.length, delta: Math.abs(at - hint) + 1, verdict: 'exact' });
        }

        let best = null;
        for (const candidate of candidates) {
          if (candidate.mode === 'raw' && hint >= 0) candidate.delta = Math.abs(candidate.at - (anchor.rawOffset ?? hint));
          if (hint >= 0 && candidate.mode !== 'raw' && (candidate.at < near || candidate.at > far)) continue;
          if (best === null || candidate.delta < best.delta) best = candidate;
        }
        if (best === null) return { range: null, verdict: 'message' };

        const view = best.mode === 'raw' ? null : best.mode === 'spaced' ? index.spaced : index.packed;
        const toRawOffset = (position) => {
          if (best.mode === 'raw') return position;
          const map = best.mode === 'spaced' ? index.spacedMap : index.packedMap;
          const mapped = map?.[position];
          return typeof mapped === 'number' ? mapped : position;
        };

        let start = best.at;
        let length = best.length;
        if (widen && length < 24) {
          const text = view ?? index.raw;
          const left = text.lastIndexOf(' ', start);
          if (left >= 0 && start - left < 8) {
            length += start - left - 1;
            start = left + 1;
          }
          const right = text.indexOf(' ', start + length);
          if (right >= 0 && right - (start + length) < 8) length = right - start;
        }

        const range = best.mode === 'raw'
          ? index.rangeForRaw(start, start + length)
          : best.mode === 'spaced'
            ? index.rangeForSpaced(start, start + length)
            : index.rangeFor(start, start + length);
        if (!range) return { range: null, verdict: 'message' };

        // Final check: the resolved range must actually read as the stored passage.
        // A mismatch means the mapping drifted, and marking the message beats
        // marking the wrong words.
        const expected = (view ?? index.raw).slice(start, start + length);
        const actual = (() => {
          try {
            return String(range.toString()).replace(/\s+/g, ' ');
          } catch {
            return '';
          }
        })();
        const wanted = best.mode === 'raw' ? expected.replace(/\s+/g, ' ') : expected;
        if (actual !== wanted) return { range: null, verdict: 'message' };

        return { range, verdict: best.verdict, offset: toRawOffset(start) };
      } catch (error) {
        console.error('[dsh-pins] 定位固定片段失败', error);
        return { range: null, verdict: 'message' };
      }
    }

    function unwrapMarks() {
      try {
        for (const mark of document.querySelectorAll('mark[data-dsh-pins-mark]')) {
          const parent = mark.parentNode;
          if (!parent) continue;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
        }
      } catch {
        /* a partially unwrapped DOM is harmless: the next pass retries */
      }
    }

    /**
     * Marking outcome per pin id, rewritten by every marker pass.
     *
     * A pin whose passage cannot be re-located while its message *is* on screen is
     * a defect worth showing: the card says so instead of silently losing its mark.
     * `pending` means the message is not mounted (scrolled away or paged out), which
     * is normal and must not be reported as a failure.
     */
    const markerReport = new Map();

    function reportMarker(id, status) {
      if (markerReport.get(id) === status) return;
      markerReport.set(id, status);
      PINS_EVENTS.dispatchEvent(new Event('markers'));
    }

    function applyMarkers() {
      // The observer stays connected while the pass runs. Disconnecting it left a
      // window in which an edit inside a marked row went unnoticed and the marks
      // stayed stale; the re-entrancy guard below is what prevents the pass from
      // scheduling itself.
      if (markerState.applying) return;
      markerState.applying = true;
      try {
        const sessionId = markerState.sessionId;
        const registry = globalThis.CSS?.highlights;
        const canUseHighlight = Boolean(registry) && typeof globalThis.Highlight === 'function';

        const ranges = [];
        const seen = new Set();
        if (sessionId) {
          const rows = markedRows();
          for (const pin of store.list(sessionId)) {
            seen.add(pin.id);
            const row = rows.find(
              (candidate) =>
                candidate.getAttribute('data-chat-flow-key') === pin.anchor?.flowKey ||
                candidate.getAttribute('data-chat-anchor-key') === pin.anchor?.flowKey,
            );
            if (!row) {
              reportMarker(pin.id, 'pending');
              continue;
            }
            const located = locateQuote(row, pin, true);
            if (located.range) {
              ranges.push(located.range);
              reportMarker(pin.id, 'ok');
            } else {
              reportMarker(pin.id, 'miss');
            }
          }
        }
        for (const id of [...markerReport.keys()]) {
          if (!seen.has(id)) markerReport.delete(id);
        }

        if (canUseHighlight) {
          // Replacing the registry entry in one call keeps the previous marks
          // visible until the new ones are ready, so a refresh never blanks them.
          if (ranges.length > 0) registry.set('dsh-pins-mark', new globalThis.Highlight(...ranges));
          else registry.delete('dsh-pins-mark');
        } else {
          unwrapMarks();
          for (const range of ranges) {
            try {
              const mark = document.createElement('mark');
              mark.setAttribute('data-dsh-pins-mark', '');
              range.surroundContents(mark);
            } catch {
              /* a range crossing element boundaries cannot be wrapped; skip it */
            }
          }
        }
      } catch (error) {
        console.error('[dsh-pins] 绘制固定标记失败', error);
      } finally {
        markerState.applying = false;
      }
    }

    /**
     * Ask for the marks to be redrawn.
     *
     * `immediate` skips the coalescing delay and is what the DOM watcher asks for,
     * because that is the case the user sees as a lag. The cache of affected rows is
     * dropped by the watcher itself, so this only schedules work. The pass runs out
     * of a timer rather than synchronously so several mutations in one frame cost
     * one redraw, and so a throw inside the pass cannot leave the scheduler
     * believing a refresh is still pending.
     */
    function scheduleMarkers(immediate) {
      if (markerState.refreshSoon === true) return;
      markerState.refreshSoon = immediate === true;
      if (markerState.refreshTimer !== null) return;
      markerState.refreshTimer = window.setTimeout(() => {
        markerState.refreshTimer = null;
        markerState.refreshSoon = false;
        try {
          applyMarkers();
        } catch (error) {
          console.error('[dsh-pins] 标记刷新失败，下次 DOM 变化时会重试', error);
        }
      }, immediate === true ? 0 : 120);
    }

    function setMarkedSession(sessionId) {
      const next = sessionId === undefined || sessionId === null ? null : String(sessionId);
      if (markerState.sessionId === next) {
        scheduleMarkers(false);
        return;
      }
      markerState.sessionId = next;
      // A different conversation means every cached row belongs to another session.
      markerState.indexCache = new WeakMap();
      scheduleMarkers(false);
    }

    function startMarkerWatch() {
      try {
        markerState.observer = new MutationObserver((records) => {
          // Our own `<mark>` wrappers are mutations too. Without this pass they would
          // be read as document changes, schedule another pass, and that pass would
          // unwrap and re-wrap — a self-sustaining loop measured at hundreds of DOM
          // changes per second in browsers without the Custom Highlight API.
          let foreign = false;
          for (const record of records) {
            if (record.target?.nodeType === 1 && record.target.hasAttribute?.('data-dsh-pins-mark')) continue;
            const added = record.addedNodes ?? [];
            const removed = record.removedNodes ?? [];
            const onlyOurs =
              [...added, ...removed].length > 0 &&
              [...added, ...removed].every(
                (node) => node.nodeType === 1 && node.hasAttribute?.('data-dsh-pins-mark'),
              );
            if (onlyOurs) continue;
            foreign = true;
            break;
          }
          if (!foreign) return;

          // Only an edit that touches a row we indexed can invalidate anything.
          // React re-renders the frame constantly (composer state, streaming
          // tokens, scroll affordances), and treating all of it as a change made
          // every pass rebuild the whole conversation's indexes.
          let touched = false;
          outer: for (const record of records) {
            const node = record.target;
            const row = node?.nodeType === 1 ? node : node?.parentElement;
            if (!row) continue;
            if (markerState.indexCache.has(row)) {
              markerState.indexCache.delete(row);
              touched = true;
              continue;
            }
            const owner = row.closest?.('[data-chat-flow-key],[data-chat-anchor-key]');
            if (owner && markerState.indexCache.has(owner)) {
              markerState.indexCache.delete(owner);
              touched = true;
              continue;
            }
            // A row that is not cached yet may still be a newly mounted message.
            if (record.addedNodes?.length > 0) {
              for (const added of record.addedNodes) {
                const element = added.nodeType === 1 ? added : added.parentElement;
                if (element?.closest?.('[data-chat-flow-key],[data-chat-anchor-key]')) {
                  touched = true;
                  break outer;
                }
              }
            }
          }
          if (touched) scheduleMarkers(true);
        });
        markerState.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (error) {
        console.error('[dsh-pins] 无法监听对话变化，标记只在固定时刷新', error);
      }
      return () => {
        try {
          markerState.observer?.disconnect();
        } catch {
          /* already gone */
        }
        markerState.observer = null;
        if (markerState.refreshTimer !== null) {
          window.clearTimeout(markerState.refreshTimer);
          markerState.refreshTimer = null;
        }
        unwrapMarks();
        try {
          globalThis.CSS?.highlights?.delete('dsh-pins-mark');
          globalThis.CSS?.highlights?.delete('dsh-pins-flash');
        } catch {
          /* the registry is optional */
        }
      };
    }

    //#endregion

    /**
     * Find the rendered flow item for one anchor key, if it is currently mounted.
     *
     * Matches `data-chat-anchor-key` as well as `data-chat-flow-key`: the two
     * differ only for grouped rows, and the anchor attribute is the one the
     * Conversation's own jump logic reads.
     */
    function findFlowRow(flowKey) {
      try {
        for (const candidate of document.querySelectorAll('[data-chat-flow-key],[data-chat-anchor-key]')) {
          if (
            candidate.getAttribute('data-chat-flow-key') === flowKey ||
            candidate.getAttribute('data-chat-anchor-key') === flowKey
          ) {
            return candidate;
          }
        }
      } catch {
        return null;
      }
      return null;
    }

    /** The conversation's own scrollport; the frame is `overflow:hidden`, so this is the only thing that scrolls. */
    function findScroller() {
      const fromAttribute = document.querySelector('[data-conversation-scroll]');
      if (fromAttribute) return fromAttribute;
      let best = null;
      for (const element of document.querySelectorAll('div')) {
        if (element.scrollHeight - element.clientHeight < 40) continue;
        if (getComputedStyle(element).overflowY !== 'auto' && getComputedStyle(element).overflowY !== 'scroll') continue;
        if (best === null || element.scrollHeight > best.scrollHeight) best = element;
      }
      return best;
    }

    /**
     * Bring one rendered row into the middle of the conversation's scrollport.
     *
     * Scrolls the scroller rather than calling `scrollIntoView`: the app frame is
     * `overflow:hidden` and the conversation owns a single scrollport, so letting
     * the browser pick the scroll container lands the row unpredictably.
     *
     * @returns whether the row was found and the scroll was written.
     */
    function scrollToRow(row) {
      const scroller = findScroller();
      if (!scroller) {
        try {
          row.scrollIntoView({ block: 'center' });
          return true;
        } catch {
          return false;
        }
      }
      const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const target = Math.max(0, scroller.scrollTop + offset - Math.max(0, (scroller.clientHeight - row.clientHeight) / 2));
      try {
        scroller.scrollTo({ top: target, behavior: 'smooth' });
      } catch {
        scroller.scrollTop = target;
      }
      return true;
    }

    /**
     * Bring one located Range into the middle of the conversation's scrollport.
     *
     * This is the precise jump: several pins can share one message, so the text the
     * user clicked is the only useful target. The computed position is clamped to
     * the scrollport's own range, which is what makes a passage near the end of the
     * conversation land at the bottom instead of being pushed up by an impossible
     * "centre" request, and the mirror case at the top.
     *
     * @returns whether the range had a usable box and the scroll was written.
     */
    function scrollToRange(range) {
      if (!range) return false;
      let box = null;
      try {
        box = range.getBoundingClientRect();
      } catch {
        return false;
      }
      // A collapsed or not-yet-laid-out range has no box worth scrolling to.
      if (!box || (box.height === 0 && box.width === 0)) return false;
      const scroller = findScroller();
      if (!scroller) return false;
      const anchorTop = box.top - scroller.getBoundingClientRect().top;
      const target = scroller.scrollTop + anchorTop - Math.max(0, (scroller.clientHeight - box.height) / 2);
      const clamped = Math.max(0, Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
      try {
        scroller.scrollTo({ top: clamped, behavior: 'smooth' });
      } catch {
        scroller.scrollTop = clamped;
      }
      return true;
    }

    /**
     * How the panel hands the turn-outline projection to the frame-wide code.
     *
     * Paging history needs the `turn/start` seq of the turn a pin lives in, and that
     * mapping only exists as the `turnOutline` projection — which reaches the panel
     * through the slot standard kit (`useProjection`), not through the Cordis
     * context the overlay half holds. The panel registers a resolver here, so a jump
     * started anywhere can page history for a turn number.
     */
    let turnSeqProvider = null;

    function setTurnSeqProvider(provider) {
      turnSeqProvider = provider;
    }

    /**
     * The `turn/start` seq of one pin's turn, when it can be determined.
     *
     * Preference order: what the pin recorded at pin time, then the live projection.
     * A pin from before this existed has no seq, and a projection may legitimately
     * lack the turn (history not loaded), in which case the caller reports that
     * paging is unavailable instead of jumping somewhere wrong.
     */
    function resolveTurnSeq(pin) {
      const stored = pin?.anchor?.turnSeq;
      if (Number.isFinite(stored) && stored > 0) return stored;
      const turn = pin?.anchor?.turn;
      const sessionId = pin?.anchor?.sessionId;
      if (!Number.isFinite(turn) || turn <= 0 || !sessionId || typeof turnSeqProvider !== 'function') return 0;
      try {
        return turnSeqProvider(sessionId, turn);
      } catch (error) {
        console.error('[dsh-pins] 查询轮次 seq 失败', error);
        return 0;
      }
    }

    /**
     * Ask the Session to page history back through the turn a pin lives in, then
     * give the Conversation a moment to mount the row.
     *
     * Best-effort by design: the jump API that would await this is not exported to
     * plugins, so a message outside the loaded window may still need one manual
     * scroll upward. The caller reports that outcome instead of pinning a guess.
     */
    function pageHistoryFor(pin, context) {
      const seq = resolveTurnSeq(pin);
      const sessionId = pin?.anchor?.sessionId;
      if (!Number.isFinite(seq) || seq <= 0 || !sessionId) return Promise.resolve(false);
      try {
        const binding = context?.get?.('sessions')?.binding?.(sessionId);
        const session = binding?.session;
        if (session && typeof session.loadThrough === 'function') {
          return Promise.resolve()
            .then(() => session.loadThrough(seq))
            .then(
              () => true,
              () => false,
            );
        }
      } catch {
        /* the session controller may not expose this Session; the caller reports it */
      }
      return Promise.resolve(false);
    }

    /**
     * Scroll a pinned passage back into view and mark it.
     *
     * The passage — not its message — is what gets centred. One message may hold
     * several pins, and centring the message would send every one of them to the
     * same middling position and leave the user hunting for the words they clicked.
     * When the passage cannot be located, the message is centred instead, which is
     * still the honest answer.
     *
     * @returns `'exact'` when the quote was re-anchored inside the message,
     *   `'message'` when only the message could be located, `'missing'` when the
     *   message is not in the loaded window.
     */
    function jumpToPin(pin, context) {
      clearPulse();
      const flowKey = pin?.anchor?.flowKey;
      if (typeof flowKey !== 'string' || flowKey === '') return 'missing';

      const row = findFlowRow(flowKey);
      if (!row) {
        // Not mounted: it may be below the loaded window (history paginates
        // upwards) or inside a collapsed process disclosure. Page once and try
        // again on the next frames rather than reporting failure immediately.
        void pageHistoryFor(pin, context).then((paged) => {
          if (!paged) return;
          let frames = 0;
          const retry = () => {
            frames += 1;
            const late = findFlowRow(flowKey);
            if (late) {
              const lateLocated = locateQuote(late, pin, false);
              scrollToRange(lateLocated.range) || scrollToRow(late);
              return;
            }
            if (frames < 120) window.requestAnimationFrame(retry);
          };
          window.requestAnimationFrame(retry);
        });
        return 'missing';
      }

      const located = locateQuote(row, pin, false);

      if (!(located.range && scrollToRange(located.range))) scrollToRow(row);
      row.setAttribute('data-dsh-pins-flash', '');
      if (located.range) flashRange(located.range);
      window.setTimeout(() => row.removeAttribute('data-dsh-pins-flash'), 2000);
      return located.range ? located.verdict : 'message';
    }

    //#endregion

    //#region styles

    function registerStyles() {
      const css = `
/* Every selector below is scoped to a class this plugin alone uses. No layout
   rule keys off a data attribute: attribute selectors here once collided with
   the host's own overlay rules and with each other, which made the floating bar
   lay itself out as a column and cover the frame. */
.dsh-pins-bar{position:fixed;z-index:30;display:inline-flex;flex-direction:row;align-items:center;gap:2px;
  width:auto;height:auto;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:12px;
  color:var(--dsw-alias-label-primary);user-select:none;font-family:inherit;line-height:1;pointer-events:auto}
.dsh-pins-bar button{display:inline-flex;align-items:center;height:26px;padding:0 9px;border:none;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap}
.dsh-pins-bar button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-pins-bar button[data-primary]{color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-pins-bar .sep{width:1px;height:16px;margin:0 3px;background:var(--dsw-alias-border-l1);flex:none}
.dsh-pins-bar input{width:104px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}

.dsh-pins-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;
  color:var(--dsw-alias-label-primary);font-family:inherit;background:var(--dsw-specific-sidebar-fill,transparent)}
.dsh-pins-root .hd{display:flex;flex-direction:column;gap:8px;padding:10px 12px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1);max-height:70vh;overflow-y:auto;overscroll-behavior:contain}
.dsh-pins-root .tabs{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-root .tabs button{flex:1;height:24px;border:none;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.dsh-pins-root .tabs button[data-on]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-pins-root .search{display:flex;align-items:center;gap:6px}
.dsh-pins-root .search input{flex:1;min-width:0;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dsh-pins-root .search input:focus{border-color:var(--dsw-alias-border-l2)}
.dsh-pins-root .search .clear{width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.dsh-pins-root .search .clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-pins-root .count{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* A query container so the expanded cap can be a share of the LIST viewport rather
   than of the window: the right column is often shorter than the window, and viewport
   units would then allow a card taller than the list itself. */
.dsh-pins-root .scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px;
  container-type:size}
.dsh-pins-root .group{margin:0 0 2px;padding:6px 6px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pins-root .group span{color:var(--dsw-alias-label-secondary);font-weight:600}
.dsh-pins-card{position:relative;box-sizing:border-box;width:100%;margin:0 0 6px;padding:8px 9px 7px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);
  text-align:left;font:inherit;color:inherit;cursor:pointer}
.dsh-pins-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-card[data-current]{border-color:var(--dsw-alias-brand-primary)}
.dsh-pins-card .meta{display:flex;align-items:center;gap:5px;margin-bottom:4px;font-size:10px;
  color:var(--dsw-alias-label-tertiary)}
.dsh-pins-card .dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsh-pins-card[data-kind="user"] .dot{background:var(--dsw-alias-brand-primary)}
.dsh-pins-card .txt{white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;
  max-height:calc(3 * (17px + var(--dsh-content-font-delta, 0px)));
  font-size:12px;line-height:calc(17px + var(--dsh-content-font-delta, 0px))}
/* Expanded: the card is the height owner, the text becomes the scrolling window. */
.dsh-pins-card[data-open]{display:flex;flex-direction:column;max-height:min(60cqh, 420px)}
.dsh-pins-card[data-open] .txt{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  max-height:none;cursor:text;
  /* The gutter that keeps the wheel on the list belongs to the CARD, so it is a margin
     here and never padding on the scroller: padding would belong to the scroller and
     the wheel over it would keep scrolling the text. */
  margin-right:16px}
.dsh-pins-card[data-open] .txt.is-open{max-height:none}
.dsh-pins-card[data-open] .tagrow,.dsh-pins-card[data-open] .tags,.dsh-pins-card[data-open] .meta{flex:none}
@media (prefers-reduced-motion:reduce){.dsh-pins-card,.dsh-pins-card .txt{transition:none}}
/* Code keeps its own layout: no collapsing of indentation, monospace metrics. */
.dsh-pins-card .txt-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11.5px;line-height:calc(16px + var(--dsh-content-font-delta, 0px));
  white-space:pre;overflow-x:hidden;
  max-height:calc(3 * (16px + var(--dsh-content-font-delta, 0px)))}
.dsh-pins-card[data-lines="1"] .txt{max-height:calc(1 * (17px + var(--dsh-content-font-delta, 0px)))}
.dsh-pins-card[data-lines="2"] .txt{max-height:calc(2 * (17px + var(--dsh-content-font-delta, 0px)))}
.dsh-pins-card[data-lines="1"] .txt-code{max-height:calc(1 * (16px + var(--dsh-content-font-delta, 0px)))}
.dsh-pins-card[data-lines="2"] .txt-code{max-height:calc(2 * (16px + var(--dsh-content-font-delta, 0px)))}
.dsh-pins-card .meta .warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-pins-card .tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
/* Filter chips: ellipsised, because the row must stay one line and the tooltip
   carries the full name. The tag *manager* deliberately does the opposite. */
.dsh-pins-root .tag{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;
  border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:10px;cursor:pointer}
.dsh-pins-root .tag:hover{color:var(--dsw-alias-label-primary)}
.dsh-pins-root .tag[data-on]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-pins-root .tagbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dsh-pins-root .tagbar-chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.dsh-pins-root .tagbar-clear{flex:none;height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer}
.dsh-pins-root .tagbar-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}

/* Collapsible tag manager: one row per tag, full name, trash beside it. */
.dsh-pins-root .tagmgr{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-pins-root .tagmgr-head{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 8px;border:none;
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;text-align:left}
.dsh-pins-root .tagmgr-head:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-root .tagmgr-head .chev{width:10px;flex:none;color:var(--dsw-alias-label-tertiary)}
.dsh-pins-root .tagmgr-head .badge{margin-left:auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-tertiary);font-size:10px}
.dsh-pins-root .tagmgr-body{display:flex;flex-direction:column;gap:1px;padding:2px 4px 6px}
/* The panel-level manager is bounded and scrolls on its own. Overflow on a flex
   item also gives it an automatic minimum size of zero, so a long tag list can
   never push the pin list out of reach. The important flag is what re-establishes
   that bound after a drag writes an inline height on the manager root. */
.dsh-pins-root .tagmgr-scroll{overflow-y:auto;overscroll-behavior:contain;
  max-height:var(--dsh-pins-mgr-height, 200px) !important}
.dsh-pins-root .tagmgr-resize{display:block;width:100%;height:10px;margin-top:2px;padding:0;border:none;background:transparent;
  cursor:ns-resize;user-select:none;touch-action:none}
.dsh-pins-root .tagmgr-resize::after{content:'';display:block;width:32px;height:3px;margin:0 auto;border-radius:999px;
  background:var(--dsw-alias-border-l2)}
.dsh-pins-root .tagmgr-resize:hover::after{background:var(--dsw-alias-label-tertiary)}
.dsh-pins-root .tagmgr-row{display:flex;align-items:center;gap:6px;min-height:24px;padding:0 4px;border-radius:6px}
.dsh-pins-root .tagmgr-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-root .tagmgr-row[data-active]{background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-root .tagmgr-name{flex:1;min-width:0;word-break:break-all;padding:2px 0;text-align:left;font-size:11px;
  color:var(--dsw-alias-label-primary);background:transparent;border:none;font-family:inherit}
.dsh-pins-root .tagmgr-name.filter{cursor:pointer}
.dsh-pins-root .tagmgr-name.filter:hover{color:var(--dsw-alias-brand-primary)}
.dsh-pins-root .tagmgr-count{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dsh-pins-root .tagmgr-del{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
  border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.dsh-pins-root .tagmgr-del:hover{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary)}
.dsh-pins-root .tagmgr-hint{padding:4px 4px 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}
.dsh-pins-root .tagmgr-empty{padding:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}

/* The card's tag editor: a line saying how to delete, the chips, then the input on
   a line of its own so no number of tags can push it off the card. */
.dsh-pins-root .tagrow-head{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}
.dsh-pins-root .tagrow-chips{display:flex;flex-wrap:wrap;gap:4px}
.dsh-pins-root .tagrow-chips .tag{border:none;font-family:inherit}
.dsh-pins-card .ops{position:absolute;top:5px;right:5px;display:none;gap:2px}
.dsh-pins-card:hover .ops,.dsh-pins-card:focus-within .ops{display:flex}
/* An expanded card keeps its controls in place: the passage below it is a jump target,
   so the editor's own entry point must not depend on the pointer staying over the card. */
.dsh-pins-card[data-open] .ops{display:flex}
.dsh-pins-card .ops button{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
  border:none;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer}
.dsh-pins-card .ops button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dsh-pins-card .tagrow{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dsh-pins-card .tagrow input{width:100%;box-sizing:border-box;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dsh-pins-root .empty{margin:22px 14px;color:var(--dsw-alias-label-tertiary);line-height:1.8;text-align:center}
.dsh-pins-root .empty b{display:block;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.dsh-pins-root .empty kbd{padding:1px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px}
.dsh-pins-root .note{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.6}
.dsh-pins-root .storage-warn{padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:7px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.6}
.dsh-pins-note{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;padding:6px 12px;
  border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;pointer-events:none}
.dsh-pins-crash{position:fixed;right:18px;bottom:64px;z-index:30;max-width:280px;padding:6px 10px;
  border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-state-error-primary);font-size:11px;font-family:inherit;pointer-events:auto}

[data-dsh-pins-flash]{animation:dsh-pins-flash 2s ease-out;border-radius:8px}
@keyframes dsh-pins-flash{
  0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
  100%{background:transparent}}
::highlight(dsh-pins-flash){background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}

/* The durable mark on every pinned passage (jump lands on the same colour). */
::highlight(dsh-pins-mark){background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);
  text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent);
  text-decoration-thickness:1px;text-underline-offset:3px}
mark[data-dsh-pins-mark]{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);color:inherit;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent);border-radius:3px}

.dsh-pins-return{position:fixed;right:18px;bottom:18px;z-index:30;display:flex;align-items:center;gap:6px;
  padding:6px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2);pointer-events:auto}
.dsh-pins-return:hover{background:var(--dsw-alias-bg-layer-2)}
`;
      try {
        const element = document.createElement('style');
        element.setAttribute('data-dsh-pins-style', '');
        element.textContent = css;
        document.head.appendChild(element);
        return () => element.remove();
      } catch (error) {
        console.error('[dsh-pins] style injection failed', error);
        return () => {};
      }
    }

    //#endregion

    //#region floating action bar

    function Toolbar({ state, onAction }) {
      const [tagging, setTagging] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const inputRef = React.useRef(null);

      React.useEffect(() => {
        if (tagging) inputRef.current?.focus();
      }, [tagging]);

      const submitTag = () => {
        const tag = normalizeTag(draft);
        setDraft('');
        setTagging(false);
        if (tag !== '') onAction({ type: 'tag', tag });
      };

      const buttons = [];

      if (state.pinned) {
        buttons.push(h('button', { key: 'unpin', type: 'button', onClick: () => onAction({ type: 'unpin' }) }, '取消固定'));
      } else {
        buttons.push(
          h(
            'button',
            { key: 'pin', type: 'button', 'data-primary': '', onClick: () => onAction({ type: 'pin' }) },
            state.truncated ? `固定前 ${MAX_CHARS} 字` : '固定',
          ),
        );
        if (tagging) {
          buttons.push(
            h('input', {
              key: 'tag',
              ref: inputRef,
              value: draft,
              placeholder: '标签，回车',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitTag();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setTagging(false);
                }
              },
            }),
          );
        } else {
          buttons.push(h('button', { key: 'addtag', type: 'button', onClick: () => setTagging(true) }, '加标签'));
        }
      }

      buttons.push(h('span', { key: 'sep', className: 'sep' }));
      buttons.push(h('button', { key: 'copy', type: 'button', onClick: () => onAction({ type: 'copy' }) }, '复制'));

      const rect = state.rect;
      const above = rect ? rect.top - TOOLBAR_HEIGHT - 8 : 0;
      const below = rect ? window.innerHeight - rect.bottom + 8 : 0;
      const top = above >= 8 ? above : below;
      const left = rect ? Math.max(8, Math.min(rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2, window.innerWidth - TOOLBAR_WIDTH - 8)) : 8;

      return h(
        'div',
        {
          className: 'dsh-pins-bar',
          style: { top: `${Math.max(8, Math.round(top))}px`, left: `${Math.round(left)}px` },
          onMouseDown: (event) => event.preventDefault(),
          // Leaving the bar puts the tag editor away, so clicking anywhere else in
          // the app dismisses it. Moving focus between the bar's own buttons keeps
          // it open.
          onBlur: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setTagging(false);
          },
        },
        buttons,
      );
    }

    /**
     * The frame-wide selection watcher and its floating bar.
     *
     * The selection is re-read on `selectionchange`, not on `mouseup`: a selection
     * change is the event that always carries the new range, and `mouseup` alone
     * misses keyboard selection. The bar's own `mousedown` is prevented so
     * pressing it never clears the selection it acts on.
     */
    function FloatingActions({ context }) {
      const [state, setState] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const stateRef = React.useRef(null);
      const actionRef = React.useRef(() => {});
      stateRef.current = state;

      const liveSession = React.useCallback(() => {
        try {
          return context?.get?.('sidebarRight')?.mounted?.getSnapshot?.() ?? null;
        } catch {
          return null;
        }
      }, [context]);

      const [sessionId, setSessionId] = React.useState(() => liveSession());

      React.useEffect(() => {
        let service = null;
        try {
          service = context?.get?.('sidebarRight') ?? null;
        } catch {
          service = null;
        }
        if (!service?.mounted?.subscribe) {
          // Without the Sidebar's published Session the panel cannot be opened
          // from here; the pin still lands, and this says so once.
          console.error('[dsh-pins] sidebarRight.mounted 不可用：固定后无法自动展开右侧栏');
          return undefined;
        }
        const sync = () => {
          const next = service.mounted.getSnapshot() ?? null;
          setSessionId(next);
          setMarkedSession(next);
        };
        sync();
        return service.mounted.subscribe(sync);
      }, [context, liveSession]);

      // A new pin (from anywhere, including the panel) redraws the marks.
      // A pin changed: redraw the marks, without pretending the DOM moved.
      React.useEffect(() => store.subscribe(() => scheduleMarkers(false)), []);

      const accept = React.useCallback(
        (range) => {
          if (!range) return;
          try {
            if (isOwnUi(range.startContainer) || isOwnUi(range.endContainer)) return;
            const anchor = readAnchor(range);
            if (!anchor.ok) {
              setState(null);
              return;
            }
            const rect = range.getBoundingClientRect();
            const target = liveSession();
            setState({
              anchor: anchor.anchor,
              text: anchor.text,
              truncated: anchor.truncated,
              rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: Math.max(1, rect.width) },
              pinned: target ? Boolean(store.find(target, anchor.anchor)) : false,
            });
          } catch (error) {
            // A selection may be read while its nodes are being replaced (streaming
            // markdown); never let that escape an event listener.
            console.error('[dsh-pins] 读取选区失败', error);
            setState(null);
          }
        },
        [liveSession],
      );

      const say = React.useCallback((text) => {
        setNotice(text);
        window.setTimeout(() => setNotice(''), 3000);
      }, []);

      /**
       * Reveal the panel, and report the reason when it cannot be revealed.
       *
       * The Sidebar's `openTab` throws for the two conditions a plugin can hit —
       * no registered kind, and no Session on screen — and a silent failure here
       * would leave the user with a recorded pin and no way to see it.
       */
      const showPanel = React.useCallback(() => {
        let service = null;
        try {
          service = context?.get?.('sidebarRight') ?? null;
        } catch (error) {
          console.error('[dsh-pins] 取 sidebarRight 失败', error);
        }
        if (!service || typeof service.openTab !== 'function') {
          return '右侧栏服务不可用，请从右栏手动打开「固定片段」';
        }
        try {
          service.openTab(TAB_KIND);
          return '';
        } catch (error) {
          console.error('[dsh-pins] openTab 失败', error);
          return `打不开右侧栏：${String(error?.message ?? error)}`;
        }
      }, [context]);

      const onAction = React.useCallback(
        (action) => {
          const current = stateRef.current;
          if (!current) return;

          if (action.type === 'copy') {
            try {
              void navigator.clipboard?.writeText(current.text);
            } catch {
              /* the clipboard can refuse outside a user gesture; copying stays best-effort */
            }
            setState(null);
            return;
          }

          const target = liveSession();
          if (!target) {
            say('这个对话还没进入会话上下文，暂时无法固定');
            return;
          }

          if (action.type === 'unpin') {
            const existing = store.find(target, current.anchor);
            if (existing) store.remove(target, existing.id);
            setState(null);
            say('已取消固定');
            return;
          }

          if (action.type === 'pin' || action.type === 'tag') {
            let record = null;
            let tagAdded = null;
            try {
              // A tag action belongs to the message the selection is in: matching on
              // the passage signature here would miss the pin the user just made
              // (the toolbar carries the raw selection, the pin keeps the normalized
              // quote) and quietly create a second pin under the same tag.
              const existing =
                action.type === 'tag'
                  ? (store.findByFlowKey(target, current.anchor.flowKey) ?? store.find(target, current.anchor))
                  : store.find(target, current.anchor);
              record =
                existing ??
                store.add(target, {
                  // `text` is the display form (line breaks kept); `anchor.quote`
                  // stays the normalized form the locator and search rely on.
                  text: current.text,
                  tags: [],
                  anchor: { ...current.anchor, sessionId: String(target) },
                });
              if (action.type === 'tag') {
                // Adding never removes, so a repeat reports itself instead of
                // silently detaching the label.
                tagAdded = store.addTag(target, record.id, action.tag);
              }
            } catch (error) {
              console.error('[dsh-pins] 保存固定失败', error);
              say(`保存失败：${String(error?.message ?? error)}`);
              return;
            }
            setState(null);
            scheduleMarkers(false);
            if (action.type === 'tag' && tagAdded === false) {
              say(`已经有 #${action.tag} 这个标签了`);
              return;
            }
            if (store.lastPersisted === false) {
              const status = store.storageStatus();
              say(status.error || '保存失败：这条没有写入本地存储');
              return;
            }
            const count = store.count(target);
            const panelProblem = showPanel();
            say(panelProblem !== '' ? `已固定 ${count} 条 · ${panelProblem}` : `已固定 ${count} 条（原文已加标记）`);
          }
        },
        [liveSession, say, showPanel],
      );
      actionRef.current = onAction;

      React.useEffect(() => {
        const onSelectionChange = () => {
          const range = dom.range();
          if (range) accept(range);
          else if (stateRef.current) setState(null);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && stateRef.current) {
            setState(null);
            return;
          }
          if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'p' || event.key === 'P')) {
            if (!stateRef.current) return;
            event.preventDefault();
            actionRef.current({ type: stateRef.current.pinned ? 'unpin' : 'pin' });
          }
        };
        const onBlur = () => setState(null);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('blur', onBlur);
        return () => {
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('blur', onBlur);
        };
      }, [accept]);

      return h(
        React.Fragment,
        null,
        state ? h(Toolbar, { state, onAction }) : null,
        h(ReturnPill, { context }),
        notice !== ''
          ? h('div', { className: 'dsh-pins-note' }, notice)
          : null,
      );
    }

    /** The "back to the pins" affordance, shown for a few seconds after a jump. */
    function ReturnPill({ context }) {
      const [visible, setVisible] = React.useState(false);
      const timerRef = React.useRef(null);

      React.useEffect(() => {
        const show = () => {
          setVisible(true);
          window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setVisible(false), 6000);
        };
        PINS_EVENTS.addEventListener('jump', show);
        return () => {
          window.clearTimeout(timerRef.current);
          PINS_EVENTS.removeEventListener('jump', show);
        };
      }, []);

      if (!visible) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-pins-return',
          onClick: () => {
            try {
              context?.get?.('sidebarRight')?.openTab?.(TAB_KIND);
            } catch (error) {
              console.error('[dsh-pins] openTab failed', error);
            }
          },
        },
        '回到固定片段',
      );
    }

    //#endregion

    //#region tags

    /** One-line explanation shown inside a tag manager panel. */
    const TAG_MANAGER_HINT = '点标签名或右侧垃圾桶都能删除这个标签（只删标签，片段本身不会删）';

    /**
     * Interaction guard for the pin card.
     *
     * Collapsing an editor on `blur` looks right and is not: `relatedTarget` is null
     * whenever focus moves to something that cannot take focus (a chip, a hint line,
     * a plain row), so every such click was read as "focus left the box" and closed
     * it — which is why clicking a chip to delete it destroyed the editor instead.
     * Preventing the default of `mousedown` keeps the input focused for any click
     * inside the card without suppressing the click itself, so the click handlers
     * still run and the editor stays open until the user leaves the card.
     */
    const CARD_GUARD = {
      onMouseDown: (event) => {
        const editor = event.currentTarget.querySelector('.tagrow');
        if (editor && editor.contains(event.target)) event.preventDefault();
      },
    };

    /**
     * The same guard for the panel's own interactive rows: keeping focus is what
     * lets a user click a tag name or a trash button without the surrounding
     * surface reacting as if focus had left.
     */
    const MGR_GUARD = {
      onMouseDown: (event) => event.preventDefault(),
    };

    /** Remembered height of the panel-level tag manager, in px. */
    const PANEL_HEIGHT_KEY = 'dsh-pins/tagmgr-height';
    const PANEL_HEIGHT_MIN = 96;
    const PANEL_HEIGHT_MAX = 420;

    function clampPanelManagerHeight(value) {
      const ceiling = Math.min(PANEL_HEIGHT_MAX, Math.round(window.innerHeight * 0.6));
      const floor = Math.min(PANEL_HEIGHT_MIN, ceiling);
      return Math.max(floor, Math.min(value, ceiling));
    }

    function readPanelManagerHeight() {
      const saved = readJson(PANEL_HEIGHT_KEY, null);
      const value = typeof saved === 'number' && Number.isFinite(saved) ? saved : 200;
      return clampPanelManagerHeight(value);
    }

    function announce(text) {
      PINS_EVENTS.dispatchEvent(new CustomEvent('notice', { detail: text }));
    }

    /**
     * A collapsible tag manager.
     *
     * Tags are listed one per row with their full name, how many pins carry them,
     * and a trash button — the "long names get ellipsised" treatment used for
     * filtering chips is wrong here, because a delete control whose label you cannot
     * read is a control you cannot use.
     *
     * One component serves both scopes: a pin card passes that pin's tags, the panel
     * header passes every tag of the Session (or of every Session, in the overview).
     */
    function TagManager({ title, tags, countOf, onDelete, onToggleFilter, activeTags, startOpen, hint, testId, bodyClass, style }) {
      const [open, setOpen] = React.useState(startOpen === true);
      return h(
        'div',
        { className: 'tagmgr', 'data-cmp': testId ?? 'tagmgr', style },
        h(
          'button',
          {
            type: 'button',
            className: 'tagmgr-head',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'chev' }, open ? '▾' : '▸'),
          h('span', null, title),
          h('span', { className: 'badge' }, tags.length),
        ),
        open
          ? h(
              'div',
              { className: `tagmgr-body${bodyClass ? ` ${bodyClass}` : ''}` },
              tags.length === 0
                ? h('div', { className: 'tagmgr-empty' }, '这个范围里还没有标签')
                : tags.map((tag) => {
                    const count = typeof countOf === 'function' ? countOf(tag) : 0;
                    const active = activeTags ? activeTags[tag] === true : false;
                    return h(
                      'div',
                      { key: tag, className: 'tagmgr-row', 'data-active': active ? '' : undefined },
                      // The name doubles as the filter in the panel header scope; in a
                      // card scope it is plain text, so nothing invites a click that
                      // would do nothing.
                      onToggleFilter
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'tagmgr-name filter',
                              title: active ? '取消这个筛选' : '只看带这个标签的片段',
                              onClick: () => onToggleFilter(tag),
                            },
                            `#${tag}`,
                          )
                        : h('span', { className: 'tagmgr-name' }, `#${tag}`),
                      count > 0 ? h('span', { className: 'tagmgr-count' }, `×${count}`) : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tagmgr-del',
                          title: `删除标签 #${tag}`,
                          'aria-label': `删除标签 ${tag}`,
                          onClick: (event) => {
                            event.preventDefault();
                            onDelete(tag);
                          },
                        },
                        '🗑',
                      ),
                    );
                  }),
              h('div', { className: 'tagmgr-hint' }, hint ?? TAG_MANAGER_HINT),
            )
          : null,
      );
    }

    /**
     * The panel-level tag manager: the same list, with a height the user controls.
     *
     * An unbounded tag list is a trap — with enough labels it consumed the whole
     * panel, so the pins below could not be reached and the only way to remove a
     * label was to delete the ones above it. The body therefore scrolls on its own
     * and its height is bounded from the start, and the drag handle lets the user
     * trade space between the manager and the pin list.
     */
    function PanelTagManager({ tags, countOf, onDelete, onToggleFilter, activeTags, title }) {
      const [height, setHeight] = React.useState(() => readPanelManagerHeight());

      React.useEffect(() => {
        writeJson(PANEL_HEIGHT_KEY, height);
      }, [height]);

      const startResize = (event) => {
        event.preventDefault();
        const body = event.currentTarget.parentElement?.querySelector('.tagmgr-body');
        if (!body) return;
        const from = event.clientY;
        const start = body.getBoundingClientRect().height;
        const move = (moveEvent) => setHeight(clampPanelManagerHeight(start + moveEvent.clientY - from));
        const stop = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', stop);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', stop);
      };

      return h(
        'div',
        { ...MGR_GUARD },
        h(TagManager, {
          title,
          tags,
          countOf,
          onDelete,
          onToggleFilter,
          activeTags,
          hint: '点右侧垃圾桶删除这个标签（只删标签，片段本身不会删）；点标签名可以筛选',
          bodyClass: 'tagmgr-scroll',
          style: { '--dsh-pins-mgr-height': `${Math.round(height)}px` },
          testId: 'panel-tag-manager',
        }),
        h('button', {
          type: 'button',
          className: 'tagmgr-resize',
          title: '上下拖动可以调整这块的高度',
          'aria-label': '调整标签管理区高度',
          onMouseDown: startResize,
          onClick: (event) => event.preventDefault(),
        }),
      );
    }

    //#endregion

    //#region sidebar panel

    /**
     * One pinned passage.
     *
     * Three states, and which click does what depends on them:
     *
     * - `idle` (three lines): clicking anywhere jumps back to the source, which keeps
     *   the muscle memory of the previous version.
     * - `preview` (expanded, scrollable): clicking toggles the tag editor, because
     *   inside an expanded card the useful next action is editing rather than leaving.
     * - `manage` (editor visible): sticky — moving the pointer away must not take the
     *   input out from under the user, so only leaving the card or pressing Esc ends it.
     *
     * The expanded body keeps a right gutter that belongs to the card rather than to
     * the inner scroller, so the wheel still scrolls the list when the pointer is over
     * that strip. `padding` would not do this: padding belongs to the scroller, so the
     * wheel would keep scrolling the text.
     */
    function PinCard({ sessionId, pin, current, taggable, onTagChange, context, cardState }) {
      const [draft, setDraft] = React.useState('');
      const rootRef = React.useRef(null);
      const open = cardState?.isOpen?.(pin.id) === true;
      const managing = cardState?.isManaging?.(pin.id) === true;

      React.useLayoutEffect(() => {
        // An expanded card near the bottom of the list would otherwise grow past the
        // viewport. Scrolling the list by exactly the overflow is instant on purpose:
        // a smooth scroll while the pointer rests on the card moves the card away from
        // the cursor and starts an open/close oscillation.
        if (!open) return;
        const root = rootRef.current;
        const scroller = root?.closest('.dsh-pins-root .scroll');
        if (!root || !scroller) return;
        const overflow = root.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
        if (overflow > 0) scroller.scrollTop += overflow;
      }, [open]);

      const submit = () => {
        const tag = normalizeTag(draft);
        setDraft('');
        if (tag === '') return;
        const added = onTagChange('add', tag);
        // Adding never removes, so say why nothing happened instead of toggling.
        if (added === false) announce(`已经有 #${tag} 这个标签了`);
      };

      const jump = () => {
        let verdict = 'missing';
        try {
          verdict = jumpToPin(pin, context);
        } catch (error) {
          console.error('[dsh-pins] 跳回原文失败', error);
        }
        if (verdict === 'missing') {
          PINS_EVENTS.dispatchEvent(
            new CustomEvent('notice', { detail: '这条消息还没加载进当前窗口：先向上滚动加载历史，再点一次。' }),
          );
          return;
        }
        PINS_EVENTS.dispatchEvent(new Event('jump'));
      };

      /**
       * The card's click surface.
       *
       * Clicking the passage always jumps back to the source. Toggling the tag editor
       * on a click anywhere was wrong in practice: the card expands on hover, so a
       * click almost never lands in the collapsed state the old rule assumed, and the
       * primary action — go to the source — became unreachable. The editor now has its
       * own controls (the `#` button, and the card's chrome around the passage), and
       * the passage keeps the one meaning it has everywhere else.
       */
      const onCardClick = (event) => {
        if (event.target.closest?.('.tagrow, .tagmgr, .ops, .tagrow-chips')) return;
        if (event.target.closest?.('.txt')) {
          jump();
          return;
        }
        if (open || managing) cardState?.toggleManage?.(pin.id);
        else jump();
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          if (managing) {
            event.preventDefault();
            cardState?.toggleManage?.(pin.id);
          }
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (event.target?.closest?.('.txt') || !open) jump();
          else cardState?.toggleManage?.(pin.id);
        }
      };

      const ops = [
        taggable
          ? h(
              'button',
              {
                key: 'tag',
                type: 'button',
                title: managing ? '收起标签编辑' : '加标签 / 编辑标签',
                onClick: (event) => {
                  event.stopPropagation();
                  cardState?.toggleManage?.(pin.id);
                },
              },
              '#',
            )
          : null,
        h(
          'button',
          {
            key: 'copy',
            type: 'button',
            title: '复制原文',
            onClick: (event) => {
              event.stopPropagation();
              try {
                // The raw form is what the user selected; the normalized anchor
                // would paste a code block as one line.
                void navigator.clipboard?.writeText(pin.anchor?.rawQuote ?? pin.text ?? '');
              } catch {
                /* best effort */
              }
            },
          },
          '⧉',
        ),
        h(
          'button',
          {
            key: 'remove',
            type: 'button',
            title: '取消固定',
            onClick: (event) => {
              event.stopPropagation();
              store.remove(sessionId, pin.id);
            },
          },
          '✕',
        ),
      ].filter(Boolean);

      const bodyClass = pin.anchor?.block === 'code' ? 'txt txt-code' : 'txt';
      const fullText = pin.text ?? '';

      return h(
        'div',
        {
          ref: rootRef,
          'data-dsh-pins': '',
          className: 'dsh-pins-card',
          'data-kind': pin.anchor?.kind ?? '',
          'data-block': pin.anchor?.block ?? 'prose',
          'data-truncated': pin.anchor?.partial === true || fullText.length > 600 ? '' : undefined,
          'data-lines': cardLines(fullText),
          'data-current': current ? '' : undefined,
          'data-open': open ? '' : undefined,
          'data-managing': managing ? '' : undefined,
          role: 'button',
          tabIndex: 0,
          // No `title`: the native tooltip would pop over the expanded body and fight it.
          ...CARD_GUARD,
          onMouseEnter: () => cardState?.requestOpen?.(pin.id),
          onMouseLeave: () => cardState?.requestClose?.(pin.id),
          onClick: onCardClick,
          onKeyDown,
        },
        h(
          'div',
          { className: 'meta' },
          h('span', { className: 'dot' }),
          h('span', null, sourceLabel(pin)),
          pin.anchor?.turn ? h('span', null, `第 ${pin.anchor.turn} 轮`) : null,
          pin.anchor?.block === 'code' ? h('span', null, `代码${pin.anchor.lang ? ` · ${pin.anchor.lang}` : ''}`) : null,
          (pin.anchor?.partial === true || fullText.length > 600) ? h('span', { className: 'warn' }, '已截断') : null,
          markerReport.get(pin.id) === 'miss'
            ? h('span', { className: 'warn', title: '这条消息在屏幕上，但没能定位到选中的文字：请点这条卡片，然后告诉我现象' }, '原文未找到')
            : null,
          h('span', { style: { marginLeft: 'auto' } }, relTime(pin.pinnedAt)),
        ),
        h('div', { className: `${bodyClass}${open ? ' is-open' : ''}` }, fullText),
        Array.isArray(pin.tags) && pin.tags.length > 0
          ? h(
              'div',
              { className: 'tags' },
              pin.tags.map((tag) =>
                h(
                  'span',
                  {
                    key: tag,
                    className: 'tag',
                    onClick: (event) => {
                      event.stopPropagation();
                      PINS_EVENTS.dispatchEvent(new CustomEvent('filter', { detail: tag }));
                    },
                  },
                  `#${tag}`,
                ),
              ),
            )
          : null,
        managing
          ? h(
              'div',
              {
                className: 'tagrow',
                onClick: (event) => event.stopPropagation(),
              },
              (pin.tags ?? []).length > 0
                ? h(
                    'div',
                    { className: 'tagrow-head' },
                    '点下面带 ✕ 的标签可以删除它',
                  )
                : null,
              (pin.tags ?? []).length > 0
                ? h(
                    'div',
                    { className: 'tagrow-chips' },
                    (pin.tags ?? []).map((tag) =>
                      h(
                        'button',
                        {
                          key: `edit-${tag}`,
                          type: 'button',
                          className: 'tag',
                          title: `删除 #${tag}`,
                          onClick: (event) => {
                            // Keep the editor's input focused while the chip handles
                            // its own click, so removal cannot be read as a blur.
                            event.preventDefault();
                            onTagChange('remove', tag);
                          },
                        },
                        `#${tag} ✕`,
                      ),
                    ),
                  )
                : null,
              h('input', {
                autoFocus: true,
                value: draft,
                placeholder: (pin.tags ?? []).length > 0 ? '再加标签，回车' : '标签，回车',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setDraft('');
                    cardState?.toggleManage?.(pin.id);
                  }
                },
              }),
              h(TagManager, {
                title: '管理这个片段的标签',
                tags: pin.tags ?? [],
                countOf: () => 0,
                onDelete: (tag) => onTagChange('remove', tag),
                hint: '点标签名或右侧垃圾桶都能删除这个标签',
                testId: 'pin-tag-manager',
              }),
            )
          : null,
        h('div', { className: 'ops' }, ops),
      );
    }

    /**
     * Hover-intent timings, in ms.
     *
     * The list is dense (cards are ~6px apart), so entering on pointer-over fires
     * while the pointer merely crosses a card on its way somewhere else. A short
     * dwell to open and a longer grace to close is what keeps a diagonal mouse move
     * from cascading through the list.
     */
    const HOVER_OPEN_DELAY = 120;
    const HOVER_CLOSE_DELAY = 160;
    /** After the list scrolls, hover is inert briefly: otherwise cards open and close under a resting pointer. */
    const HOVER_SCROLL_QUIET = 150;

    /**
     * Build the pin list.
     *
     * The hover behaviour lives here rather than in each card because "one expanded
     * card at a time" is a property of the list: the card that opens asks this owner
     * to open, and the owner closes whatever was open before.
     *
     * The context is closed over rather than read from props: the Sidebar's tab
     * body receives session-standard props only, and jumping back needs the Session
     * controller to page history when the target is not mounted yet.
     */
    function createPinsPanel(context) {
      return function PinsPanel(props) {
      const sessionId = props?.sessionId ?? null;
      const isCurrent = props?.current === true;
      const [tick, setTick] = React.useState(0);
      const [mode, setMode] = React.useState(() => store.getMode());
      const [query, setQuery] = React.useState('');
      const [tagFilter, setTagFilter] = React.useState(() => new Set());
      const [notice, setNotice] = React.useState('');

      // Which card is expanded, and which expanded card is in its tag editor. Two
      // ids rather than one "state" so the editor survives a re-render of the list.
      const [openId, setOpenId] = React.useState(null);
      const [manageId, setManageId] = React.useState(null);
      const [hoverInert, setHoverInert] = React.useState(false);
      const hovers = React.useRef({ open: null, close: null });

      const clearHoverTimers = React.useCallback(() => {
        if (hovers.current.open !== null) window.clearTimeout(hovers.current.open);
        if (hovers.current.close !== null) window.clearTimeout(hovers.current.close);
        hovers.current.open = null;
        hovers.current.close = null;
      }, []);

      const closeExpanded = React.useCallback(() => {
        clearHoverTimers();
        setOpenId(null);
        setManageId(null);
      }, [clearHoverTimers]);

      const cardState = React.useMemo(
        () => ({
          isOpen: (id) => openId === id,
          isManaging: (id) => manageId === id,
          /**
           * A card asks to open on hover. Refused while another card is being edited:
           * taking the editor away because the pointer travelled across the list is
           * exactly the failure the sticky rule exists to prevent.
           */
          requestOpen: (id) => {
            if (hoverInert || manageId !== null) return;
            if (hovers.current.close !== null) {
              window.clearTimeout(hovers.current.close);
              hovers.current.close = null;
            }
            if (openId === id || hovers.current.open !== null) return;
            hovers.current.open = window.setTimeout(() => {
              hovers.current.open = null;
              setOpenId(id);
            }, HOVER_OPEN_DELAY);
          },
          requestClose: (id) => {
            if (manageId === id) return;
            if (hovers.current.open !== null) {
              window.clearTimeout(hovers.current.open);
              hovers.current.open = null;
            }
            if (openId !== id || hovers.current.close !== null) return;
            hovers.current.close = window.setTimeout(() => {
              hovers.current.close = null;
              setOpenId((current) => (current === id ? null : current));
            }, HOVER_CLOSE_DELAY);
          },
          /** Click inside an expanded card alternates between reading and editing. */
          toggleManage: (id) => {
            clearHoverTimers();
            setOpenId(id);
            setManageId((current) => (current === id ? null : id));
          },
          /** Put the whole list back to its collapsed state; `Esc` and panel-level affordances use it. */
          collapseAll: () => {
            clearHoverTimers();
            setOpenId(null);
            setManageId(null);
          },
          manage: (id) => {
            clearHoverTimers();
            setOpenId(id);
            setManageId(id);
          },
          scrollQuiet: () => {
            clearHoverTimers();
            setHoverInert(true);
            window.setTimeout(() => setHoverInert(false), HOVER_SCROLL_QUIET);
          },
        }),
        [openId, manageId, hoverInert, clearHoverTimers],
      );

      React.useEffect(() => clearHoverTimers, [clearHoverTimers]);

      // The turn outline is how a jump pages history to a turn that is not loaded:
      // it carries each turn's `turn/start` seq. It arrives through the slot standard
      // kit, so it is published for the frame-wide jump code to use.
      const projection = typeof props?.useProjection === 'function' ? props.useProjection : null;
      const turnOutline = projection ? projection('turnOutline') : undefined;
      React.useEffect(() => {
        setTurnSeqProvider((id, turn) => {
          if (id !== sessionId || !Array.isArray(turnOutline)) return 0;
          const entry = turnOutline.find((row) => row?.turn === turn);
          return Number.isFinite(entry?.seq) && entry.seq > 0 ? entry.seq : 0;
        });
        return () => setTurnSeqProvider(null);
      }, [sessionId, turnOutline]);

      const toggleTagFilter = React.useCallback((tag) => {
        setTagFilter((current) => {
          const next = new Set(current);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          return next;
        });
      }, []);

      const matchesTags = React.useCallback(
        (pin) => {
          if (tagFilter.size === 0) return true;
          const carried = pin.tags ?? [];
          for (const tag of tagFilter) if (carried.includes(tag)) return true;
          return false;
        },
        [tagFilter],
      );

      React.useEffect(() => store.subscribe(() => setTick((value) => value + 1)), []);
      // Marking outcomes arrive from the frame-wide watcher, not from the store.
      React.useEffect(() => {
        const onMarkers = () => setTick((value) => value + 1);
        PINS_EVENTS.addEventListener('markers', onMarkers);
        return () => PINS_EVENTS.removeEventListener('markers', onMarkers);
      }, []);
      // Renaming a Session must land here: the title is a projection the Host
      // broadcasts, and `tick` re-reads it on the next render.
      React.useEffect(
        () => subscribeSessionTitle(context, sessionId, () => setTick((value) => value + 1)),
        [context, sessionId],
      );
      React.useEffect(() => {
        const onFilter = (event) => toggleTagFilter(String(event.detail ?? ''));
        const onNotice = (event) => {
          setNotice(String(event.detail ?? ''));
          window.setTimeout(() => setNotice(''), 3600);
        };
        PINS_EVENTS.addEventListener('filter', onFilter);
        PINS_EVENTS.addEventListener('notice', onNotice);
        return () => {
          PINS_EVENTS.removeEventListener('filter', onFilter);
          PINS_EVENTS.removeEventListener('notice', onNotice);
        };
      }, [toggleTagFilter]);

      // Manager order: most used first, so the labels worth curating are on top.
      // The counts are folded once per store version rather than per render, because
      // the overview scope spans every Session.
      const tags = React.useMemo(() => {
        const counts = new Map();
        const count = (tag) => counts.get(tag) ?? 0;
        if (mode === 'all') {
          for (const [id, entry] of store.sessions()) {
            for (const pin of entry.pins ?? []) {
              for (const tag of pin.tags ?? []) counts.set(tag, count(tag) + 1);
            }
          }
        } else if (sessionId) {
          for (const pin of store.list(sessionId)) {
            for (const tag of pin.tags ?? []) counts.set(tag, count(tag) + 1);
          }
        }
        return [...counts.keys()]
          .sort((left, right) => count(right) - count(left) || left.localeCompare(right, 'zh-Hans-CN'))
          .map((tag) => ({ tag, count: count(tag) }));
      }, [mode, sessionId, tick]);

      const visible = React.useMemo(() => {
        if (!sessionId) return [];
        return store.list(sessionId).filter((pin) => matchesQuery(pin, query) && matchesTags(pin));
      }, [sessionId, query, matchesTags, tick]);

      // The overview honours the same filters as the per-Session list: search and
      // tag both narrow it, and the counts shown are the surviving ones.
      const overview = React.useMemo(() => {
        if (mode !== 'all') return [];
        return store
          .sessions()
          .map(([id, entry]) => [id, entry, entry.pins.filter((pin) => matchesQuery(pin, query) && matchesTags(pin))])
          .filter(([, , pins]) => pins.length > 0);
      }, [mode, query, matchesTags, tick]);

      const overviewCount = React.useMemo(
        () => overview.reduce((total, [, , pins]) => total + pins.length, 0),
        [overview],
      );

      const switchMode = (next) => {
        setMode(next);
        store.setMode(next);
      };

      // A failed write leaves the panel saying so until a write succeeds: state in
      // memory looks perfectly healthy, so silence here is the difference between a
      // user noticing and a user losing a session's worth of pins on refresh.
      const storage = store.storageStatus();

      const header = h(
        'div',
        { className: 'hd' },
        storage.ok === false ? h('div', { className: 'storage-warn' }, storage.error) : null,
        h(
          'div',
          { className: 'tabs' },
          h('button', { type: 'button', 'data-on': mode === 'session' ? '' : undefined, onClick: () => switchMode('session') }, '本对话'),
          h('button', { type: 'button', 'data-on': mode === 'all' ? '' : undefined, onClick: () => switchMode('all') }, '全部'),
        ),
        h(
          'div',
          { className: 'search' },
          h('input', {
            value: query,
            placeholder: '搜索固定内容或标签',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
              }
            },
          }),
          query !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'clear',
                  title: '清除搜索',
                  'aria-label': '清除搜索',
                  onClick: () => setQuery(''),
                },
                '✕',
              )
            : null,
          h(
            'span',
            { className: 'count' },
            mode === 'all' ? `${overviewCount} 条` : `${sessionId ? store.count(sessionId) : 0} 条`,
          ),
        ),
        tags.length > 0
          ? h(
              'div',
              { className: 'tagbar' },
              h(
                'div',
                { className: 'tagbar-chips' },
                tags.map(({ tag, count }) =>
                  h(
                    'span',
                    {
                      key: tag,
                      className: 'tag',
                      'data-on': tagFilter.has(tag) ? '' : undefined,
                      title: `筛选：#${tag}（${count} 条）`,
                      onClick: () => toggleTagFilter(tag),
                    },
                    `#${tag}`,
                  ),
                ),
              ),
              // Unfiltering one pill at a time is the wrong gesture when several are
              // selected, so the row carries a reset for the whole selection.
              tagFilter.size > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'tagbar-clear',
                      title: '清除标签筛选',
                      onClick: () => setTagFilter(new Set()),
                    },
                    `清除筛选 (${tagFilter.size})`,
                  )
                : null,
            )
          : null,
        tags.length > 0
          ? h(PanelTagManager, {
              // Scope-aware: the overview manages tags of every Session, the
              // per-Session view only its own — deleting from here must not silently
              // reach into conversations the user is not looking at.
              title: mode === 'all' ? '管理全部标签' : '管理本对话标签',
              tags: tags.map((entry) => entry.tag),
              countOf: (tag) => tags.find((entry) => entry.tag === tag)?.count ?? 0,
              onDelete: (tag) => {
                const removed =
                  mode === 'all' ? store.removeTagEverywhere(undefined, tag) : sessionId ? store.removeTagEverywhere(sessionId, tag) : 0;
                setTagFilter((current) => {
                  if (!current.has(tag)) return current;
                  const next = new Set(current);
                  next.delete(tag);
                  return next;
                });
                announce(removed > 0 ? `已删除标签 #${tag}（涉及 ${removed} 条片段）` : `标签 #${tag} 已经不在了`);
              },
              onToggleFilter: toggleTagFilter,
              activeTags: Object.fromEntries([...tagFilter].map((tag) => [tag, true])),
            })
          : null,
        notice !== '' ? h('div', { className: 'note' }, notice) : null,
      );

      let body;

      if (mode === 'all') {
        body =
          overview.length === 0
            ? h(
                'div',
                { className: 'empty' },
                h('b', null, '还没有固定任何片段'),
                '在对话里划选一段文字，点浮出来的「固定」。',
              )
            : h(
                'div',
                { className: 'scroll', onScroll: () => cardState.scrollQuiet() },
                overview.map(([id, entry, pins]) =>
                  h(
                    'div',
                    { key: id },
                    h('div', { className: 'group' }, h('span', null, sessionLabel({ ...entry, liveTitle: readSessionTitle(context, id) })), ` · ${pins.length}`),
                    pins.map((pin) =>
                      h(PinCard, {
                        key: pin.id,
                        sessionId: id,
                        pin,
                        current: isCurrent && id === sessionId,
                        taggable: false,
                        cardState,
                        // The overview is for reading; a card there does not edit tags,
                        // and the panel-level manager above it is how one is removed.
                        onTagChange: () => false,
                        context,
                      }),
                    ),
                  ),
                ),
              );
      } else if (visible.length === 0) {
        body = h(
          'div',
          { className: 'empty' },
          h('b', null, query !== '' || tagFilter.size > 0 ? '没有匹配的固定片段' : '这一段还没固定过任何内容'),
          query !== '' || tagFilter.size > 0
            ? '换个关键词，或者清掉标签筛选。'
            : h(
                'span',
                null,
                '用鼠标划选一段文字，浮条里点「固定」；或用 ',
                h('kbd', null, 'Alt'),
                ' + ',
                h('kbd', null, 'P'),
                '。',
              ),
        );
      } else {
        body = h(
          'div',
          { className: 'scroll', onScroll: () => cardState.scrollQuiet() },
          visible.map((pin) =>
            h(PinCard, {
              key: pin.id,
              sessionId,
              pin,
              current: false,
              taggable: true,
              cardState,
              onTagChange: (action, tag) => {
                if (action === 'add') {
                  const added = store.addTag(sessionId, pin.id, tag);
                  if (added) announce(`已加标签 #${tag}`);
                  return added;
                }
                const removed = store.removeTag(sessionId, pin.id, tag);
                if (removed) announce(`已删除标签 #${tag}`);
                return removed;
              },
              context,
            }),
          ),
        );
      }

      return h('div', { 'data-dsh-pins': '', className: 'dsh-pins-root' }, header, body);
      };
    }

    //#endregion

    //#region registration

    /**
     * Contain a render failure to this plugin.
     *
     * A slot entry that throws during render is emptied by the slot runtime, and
     * an error that escapes the entry can take the whole application down with
     * it. Catching here turns either outcome into one small notice that names
     * what failed, while the rest of the page keeps working.
     *
     * The healthy path renders `children` with no wrapper element: in the
     * frame-wide overlay layer every direct child is made clickable by the host,
     * so an extra wrapper would become a click and scroll blocker. The fallback
     * notice is a single small fixed box for the same reason.
     */
    class Guard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { message: '' };
      }

      static getDerivedStateFromError(error) {
        return { message: String(error?.message ?? error ?? '未知错误') };
      }

      componentDidCatch(error, info) {
        console.error(`[dsh-pins] ${this.props?.label ?? '组件'}渲染失败`, error, info?.componentStack ?? '');
      }

      render() {
        if (this.state.message !== '') {
          return h('div', { className: 'dsh-pins-crash', role: 'status' }, `${this.props?.label ?? '固定片段'}渲染失败：${this.state.message}`);
        }
        return this.props?.children ?? null;
      }
    }

    function apply(context) {
      const disposers = [];
      const own = (dispose) => {
        if (typeof dispose === 'function') disposers.push(dispose);
      };

      try {
        own(registerStyles());
      } catch (error) {
        console.error('[dsh-pins] 样式注入失败', error);
      }

      own(startMarkerWatch());

      let slots = null;
      try {
        slots = context.get('slots') ?? null;
      } catch (error) {
        console.error('[dsh-pins] 取 slots 服务失败', error);
      }
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          own(
            slots.inject('shell.overlay', () =>
              slots.register({ name: 'shell.overlay', id: PKG, order: 30, label: 'Pinned passages' }, () =>
                // No wrapper element: the host's overlay layer makes every direct
                // child clickable (`overlayLayer > *`), so anything that spans the
                // frame here would swallow every click and every scroll in the
                // app. The bar and the pill carry their own hit area instead.
                h(Guard, { label: '浮条' }, h(FloatingActions, { context })),
              ),
            ),
          );
          own(
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) =>
                h(Guard, { label: '固定片段' }, h(createPinsPanel(context), props)),
              ),
            ),
          );
          own(
            slots.inject('sidebar.right.pane.tab.title', () =>
              slots.register(
                { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
                // A component, not a string: the count has to follow the store, or the
                // chip keeps showing a number that the panel below has already refuted.
                function PinsTabTitle(props) {
                  const [count, setCount] = React.useState(() =>
                    props?.sessionId ? store.count(props.sessionId) : 0,
                  );
                  React.useEffect(() => {
                    const sync = () => setCount(props?.sessionId ? store.count(props.sessionId) : 0);
                    sync();
                    return store.subscribe(sync);
                  }, [props?.sessionId]);
                  return count > 0 ? `固定片段 · ${count}` : '固定片段';
                },
              ),
            ),
          );
        } catch (error) {
          console.error('[dsh-pins] slot registration failed', error);
        }
      } else {
        console.error('[dsh-pins] the slots service is unavailable; the UI cannot register');
      }

      // The Sidebar's tab registry is provided after this package loads, so the
      // type registration retries on a short timer instead of holding a hard
      // dependency the browser half cannot express.
      let attempts = 0;
      let timer = null;
      const schedule = (callback, delay) => {
        try {
          return context.setTimeout(callback, delay);
        } catch {
          return window.setTimeout(callback, delay);
        }
      };
      const tryRegister = () => {
        let tabs = null;
        try {
          tabs = context.get('sidebarRightTabs') ?? null;
        } catch (error) {
          console.error('[dsh-pins] 取 sidebarRightTabs 失败', error);
          return;
        }
        if (tabs && typeof tabs.register === 'function') {
          try {
            own(
              tabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => '固定片段',
                // Keep the panel mounted when the user switches to the file tree and
                // back: the search term, the tag filter and the scroll position are
                // view state worth more than the memory the body costs.
                keepMounted: true,
              }),
            );
          } catch (error) {
            console.error('[dsh-pins] tab type registration failed', error);
          }
          return;
        }
        attempts += 1;
        if (attempts < 40) timer = schedule(tryRegister, 250);
        else console.error('[dsh-pins] sidebarRightTabs never appeared; the panel cannot be opened');
      };
      tryRegister();

      return () => {
        try {
          if (timer !== null) context.clearTimeout(timer);
        } catch {
          /* the timer may already be gone */
        }
        while (disposers.length > 0) {
          const dispose = disposers.pop();
          try {
            dispose();
          } catch (error) {
            console.error('[dsh-pins] disposer failed', error);
          }
        }
      };
    }

    return {
      inject: ['slots'],
      apply,
    };
  },
});
