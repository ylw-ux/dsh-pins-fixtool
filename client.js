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
    const QUOTE_CONTEXT = 24;
    const TOOLBAR_HEIGHT = 40;
    const TOOLBAR_WIDTH = 220;

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
     * The Conversation's own title lives in a projection this plugin does not
     * read, so a Session is labelled by the first line of its newest pin — the
     * text the user chose most recently, which is what they will recognise.
     */
    function sessionLabel(entry) {
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

    /** Rough line count a card needs, so 1-line pins really render as one line. */
    function cardLines(text) {
      const length = (text ?? '').length;
      if (length <= 30) return '1';
      if (length <= 76) return '2';
      return '3';
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

      const commit = () => {
        writeJson(STATE_KEY, data);
        writeJson(MODE_KEY, data.mode);
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[dsh-pins] subscriber failed', error);
          }
        }
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
        getMode() {
          return data.mode === 'all' ? 'all' : 'session';
        },
        setMode(mode) {
          data.mode = mode === 'all' ? 'all' : 'session';
          commit();
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
          return [...entry.pins].sort((a, b) => (a.anchor?.seq ?? 0) - (b.anchor?.seq ?? 0));
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
        get(sessionId, id) {
          return sessionOf(sessionId, false)?.pins.find((pin) => pin.id === id);
        },
        /** The pin for one passage, if that exact passage is already pinned. */
        find(sessionId, anchor) {
          return sessionOf(sessionId, false)?.pins.find((pin) => sameAnchor(pin.anchor, anchor));
        },
        /** Tags across every Session that holds pins, for the overview filter. */
        allTags() {
          const seen = new Set();
          for (const [, entry] of api.sessions()) {
            for (const pin of entry.pins ?? []) {
              for (const tag of pin.tags ?? []) seen.add(tag);
            }
          }
          return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        },
        add(sessionId, pin, title) {
          const entry = sessionOf(sessionId, true);
          // One message holds many pins; only the same passage is a duplicate.
          const existing = entry.pins.find((each) => sameAnchor(each.anchor, pin.anchor));
          if (existing) return existing;
          const record = { ...pin, id: newId(), pinnedAt: Date.now() };
          entry.pins = [...entry.pins, record];
          touch(sessionId, title);
          commit();
          return record;
        },
        remove(sessionId, id) {
          const entry = sessionOf(sessionId, false);
          if (!entry) return;
          entry.pins = entry.pins.filter((pin) => pin.id !== id);
          if (Array.isArray(entry.order)) entry.order = entry.order.filter((each) => each !== id);
          entry.updatedAt = Date.now();
          if (entry.pins.length === 0) delete data.sessions[String(sessionId)];
          commit();
        },
        setTags(sessionId, id, tags) {
          const pin = api.get(sessionId, id);
          if (!pin) return;
          pin.tags = tags;
          const entry = sessionOf(sessionId, true);
          entry.updatedAt = Date.now();
          commit();
        },
        /** Add a tag, or remove it when the passage already carries it. */
        toggleTag(sessionId, id, tag) {
          const pin = api.get(sessionId, id);
          if (!pin) return;
          const current = pin.tags ?? [];
          pin.tags = current.includes(tag) ? current.filter((each) => each !== tag) : [...current, tag];
          const entry = sessionOf(sessionId, true);
          entry.updatedAt = Date.now();
          commit();
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

    /** Whitespace-normalized text of one DOM interval, matching `String.replace(/\s+/g, ' ')`. */
    function intervalText(range) {
      try {
        return String(range.toString()).replace(/\s+/g, ' ');
      } catch {
        return '';
      }
    }

    /**
     * Read a browser selection as a durable pin anchor.
     *
     * @returns a delivery-ready anchor, or `{ ok: false, reason }` when the
     *   selection is empty, outside a message node, or spans several messages.
     */
    function readAnchor(range) {
      if (!range) return { ok: false, reason: 'empty' };
      const text = intervalText(range);
      if (text.trim() === '') return { ok: false, reason: 'empty' };

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
      const quote = truncated ? text.slice(0, MAX_CHARS) : text;

      let offset = -1;
      try {
        const before = document.createRange();
        before.selectNodeContents(source);
        before.setEnd(range.startContainer, range.startOffset);
        offset = String(before.toString()).replace(/\s+/g, ' ').length;
      } catch {
        offset = -1;
      }

      return {
        ok: true,
        anchor: {
          sessionId: '',
          flowKey: sourceKey,
          node: source.getAttribute('data-chat-node-key') ?? sourceKey,
          kind: source.getAttribute('data-chat-flow-kind') ?? '',
          turn: Number(source.getAttribute('data-chat-turn') ?? 0) || 0,
          seq: 0,
          offset,
          quote,
          prefix: text.slice(0, QUOTE_CONTEXT),
          suffix: text.slice(-QUOTE_CONTEXT),
        },
        text: truncated ? `${quote}…` : quote,
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
     * Index a message node's rendered text the way the browser reports a selection.
     *
     * The index must agree with `Range.toString()` character for character, or a
     * stored quote lands a few characters off — which is exactly what happens when
     * a markdown block structure (paragraphs, list items, headings, breaks) is
     * reconstructed with separators the browser never emits. So the raw text is
     * the concatenation of its text nodes, with no separator inserted, and the
     * normalized form is the same `/\s+/g -> ' '` the selection reader applies.
     *
     * Every offset the plugin stores or resolves is in the normalized space, with
     * a one-to-one raw mapping for the blocks that boundary inserts whitespace
     * into (paragraphs, list items, code fences) and a proportional mapping inside
     * the rest, so a quote always resolves back to the text the user sees.
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

      // normalized text plus the raw offset each normalized offset came from.
      let packed = '';
      const map = [0];
      for (let at = 0; at < raw.length; ) {
        if (/\s/.test(raw[at])) {
          const from = at;
          while (at < raw.length && /\s/.test(raw[at])) at += 1;
          const spansNodes = nodes.some((entry) => from < entry.start && at > entry.start);
          const boundary = spansNodes || /\s/.test(raw[from - 1] ?? ' ') || /\s/.test(raw[at] ?? ' ');
          if (boundary) {
            map[map.length - 1] = from;
            packed += ' ';
            map.push(at);
          } else {
            map[map.length - 1] = from;
          }
          continue;
        }
        packed += raw[at];
        map.push(at + 1);
        at += 1;
      }

      return {
        raw,
        packed,
        nodes,
        /** Resolve an interval in normalized text back to a live DOM Range, or `null`. */
        rangeFor(start, end) {
          if (nodes.length === 0 || packed.length === 0) return null;
          const from = map[Math.max(0, Math.min(start, packed.length))];
          const to = map[Math.max(0, Math.min(end, packed.length))];
          if (from === undefined || to === undefined || to <= from) return null;
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
        },
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
    const markerState = { sessionId: null, refreshTimer: null, observer: null, indexCache: new WeakMap() };

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
     * Locate one stored quote inside an indexed row.
     *
     * An exact match wins; otherwise the stored relative offset is used as a hint
     * over a small window, which survives the whitespace differences that a
     * re-rendered markdown block can introduce. `widen` grows a short quote to the
     * surrounding word boundaries so a two-word pin is still findable by eye.
     *
     * @returns `{ range, verdict }` — `verdict` is `'exact'` for a quote match and
     *   `'message'` when only the hint found it.
     */
    function locateQuote(row, pin, widen) {
      try {
        const index = cachedIndex(row);
        const quote = pin?.anchor?.quote ?? '';
        if (quote === '') return { range: null, verdict: 'message' };
        let found = index.packed.indexOf(quote);
        let verdict = found >= 0 ? 'exact' : 'message';
        if (found < 0) {
          const at = typeof pin.anchor?.offset === 'number' ? pin.anchor.offset : -1;
          if (at < 0) return { range: null, verdict: 'message' };
          const from = Math.max(0, at - 24);
          const relative = index.packed.slice(from, at + quote.length + 24).indexOf(quote);
          if (relative < 0) return { range: null, verdict: 'message' };
          found = from + relative;
        }
        let length = quote.length;
        if (widen && length < 24) {
          const left = index.packed.lastIndexOf(' ', found);
          if (left >= 0 && found - left < 8) {
            length += found - left - 1;
            found = left + 1;
          }
          const right = index.packed.indexOf(' ', found + length);
          if (right >= 0 && right - (found + length) < 8) length = right - found;
        }
        return { range: index.rangeFor(found, found + length), verdict };
      } catch {
        return { range: null, verdict: 'message' };
      }
    }

    /** The marker pass widens short quotes; the jump pass does not. */
    function rangeForPin(row, pin) {
      return locateQuote(row, pin, true).range;
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

    function applyMarkers() {
      try {
        markerState.observer?.disconnect();
      } catch {
        /* the observer is optional */
      }
      try {
        const sessionId = markerState.sessionId;
        const registry = globalThis.CSS?.highlights;
        const canUseHighlight = Boolean(registry) && typeof globalThis.Highlight === 'function';

        const ranges = [];
        if (sessionId) {
          const rows = markedRows();
          for (const pin of store.list(sessionId)) {
            const row = rows.find(
              (candidate) =>
                candidate.getAttribute('data-chat-flow-key') === pin.anchor?.flowKey ||
                candidate.getAttribute('data-chat-anchor-key') === pin.anchor?.flowKey,
            );
            if (!row) continue;
            const range = rangeForPin(row, pin);
            if (range) ranges.push(range);
          }
        }

        if (canUseHighlight) {
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
        try {
          markerState.observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch {
          /* observing is best-effort */
        }
      }
    }

    function scheduleMarkers() {
      if (markerState.refreshTimer !== null) return;
      // The document changed, so every cached text index may be stale.
      markerState.indexCache = new WeakMap();
      markerState.refreshTimer = window.setTimeout(() => {
        markerState.refreshTimer = null;
        applyMarkers();
      }, 250);
    }

    function setMarkedSession(sessionId) {
      const next = sessionId === undefined || sessionId === null ? null : String(sessionId);
      if (markerState.sessionId === next) {
        scheduleMarkers();
        return;
      }
      markerState.sessionId = next;
      applyMarkers();
    }

    function startMarkerWatch() {
      try {
        markerState.observer = new MutationObserver(scheduleMarkers);
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
     * Ask the Session to page history back through one sequence number, then give
     * the Conversation a moment to mount the row.
     *
     * Best-effort by design: the jump API that would await this is not exported to
     * plugins, so a message outside the loaded window may still need one manual
     * scroll upward. The caller reports that outcome instead of pinning a guess.
     */
    function pageHistoryFor(pin, context) {
      const seq = pin?.anchor?.seq;
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
              scrollToRow(late);
              return;
            }
            if (frames < 120) window.requestAnimationFrame(retry);
          };
          window.requestAnimationFrame(retry);
        });
        return 'missing';
      }

      const located = locateQuote(row, pin, false);

      scrollToRow(row);
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
.dsh-pins-root .hd{display:flex;flex-direction:column;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-pins-root .tabs{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-pins-root .tabs button{flex:1;height:24px;border:none;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.dsh-pins-root .tabs button[data-on]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-pins-root .search{display:flex;align-items:center;gap:6px}
.dsh-pins-root .search input{flex:1;min-width:0;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dsh-pins-root .search input:focus{border-color:var(--dsw-alias-border-l2)}
.dsh-pins-root .count{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-pins-root .scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px}
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
.dsh-pins-card .txt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  font-size:12px;line-height:17px;word-break:break-word}
.dsh-pins-card[data-lines="1"] .txt{-webkit-line-clamp:1}
.dsh-pins-card[data-lines="2"] .txt{-webkit-line-clamp:2}
.dsh-pins-card .tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.dsh-pins-root .tag{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;
  border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:10px;cursor:pointer}
.dsh-pins-root .tag:hover{color:var(--dsw-alias-label-primary)}
.dsh-pins-root .tag[data-on]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-pins-card .ops{position:absolute;top:5px;right:5px;display:none;gap:2px}
.dsh-pins-card:hover .ops,.dsh-pins-card:focus-within .ops{display:flex}
.dsh-pins-card .ops button{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
  border:none;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer}
.dsh-pins-card .ops button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dsh-pins-card .tagrow{display:flex;gap:4px;margin-top:5px}
.dsh-pins-card .tagrow input{width:100%;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dsh-pins-root .empty{margin:22px 14px;color:var(--dsw-alias-label-tertiary);line-height:1.8;text-align:center}
.dsh-pins-root .empty b{display:block;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.dsh-pins-root .empty kbd{padding:1px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px}
.dsh-pins-root .note{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.6}
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
              onBlur: () => setTagging(false),
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
      React.useEffect(() => store.subscribe(scheduleMarkers), []);

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
              void navigator.clipboard?.writeText(current.anchor.quote);
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
            try {
              const existing = store.find(target, current.anchor);
              record =
                existing ??
                store.add(target, {
                  text: current.text,
                  tags: [],
                  anchor: { ...current.anchor, sessionId: String(target) },
                });
              if (action.type === 'tag') {
                store.toggleTag(target, record.id, action.tag);
              }
            } catch (error) {
              console.error('[dsh-pins] 保存固定失败', error);
              say(`保存失败：${String(error?.message ?? error)}`);
              return;
            }
            setState(null);
            scheduleMarkers();
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

    //#region sidebar panel

    function PinCard({ sessionId, pin, current, taggable, onToggleTag, context }) {
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');

      const submit = () => {
        const tag = normalizeTag(draft);
        setDraft('');
        if (tag !== '') onToggleTag(tag);
      };

      const open = () => {
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

      const ops = [
        taggable
          ? h(
              'button',
              {
                key: 'tag',
                type: 'button',
                title: '加标签',
                onClick: (event) => {
                  event.stopPropagation();
                  setEditing((value) => !value);
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
                void navigator.clipboard?.writeText(pin.anchor?.quote ?? pin.text ?? '');
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

      return h(
        'div',
        {
          'data-dsh-pins': '',
          className: 'dsh-pins-card',
          'data-kind': pin.anchor?.kind ?? '',
          'data-lines': cardLines(pin.text),
          'data-current': current ? '' : undefined,
          role: 'button',
          tabIndex: 0,
          title: pin.text ?? '',
          onClick: open,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          },
        },
        h(
          'div',
          { className: 'meta' },
          h('span', { className: 'dot' }),
          h('span', null, sourceLabel(pin)),
          pin.anchor?.turn ? h('span', null, `第 ${pin.anchor.turn} 轮`) : null,
          h('span', { style: { marginLeft: 'auto' } }, relTime(pin.pinnedAt)),
        ),
        h('div', { className: 'txt' }, pin.text ?? ''),
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
        editing
          ? h(
              'div',
              { className: 'tagrow', onClick: (event) => event.stopPropagation() },
              // Existing tags are listed here as removable chips, so a mistyped
              // label can be taken off without deleting the whole pin.
              (pin.tags ?? []).map((tag) =>
                h(
                  'span',
                  {
                    key: `edit-${tag}`,
                    className: 'tag',
                    title: '点击移除这个标签',
                    onClick: () => onToggleTag(tag),
                  },
                  `#${tag} ✕`,
                ),
              ),
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
                    setEditing(false);
                  }
                },
              }),
            )
          : null,
        h('div', { className: 'ops' }, ops),
      );
    }

    /**
     * Build the panel component for one plugin context.
     *
     * The context is closed over rather than read from props: the Sidebar's tab
     * body receives session-standard props only, and jumping back needs the
     * Session controller to page history when the target is not mounted yet.
     */
    function createPinsPanel(context) {
      return function PinsPanel(props) {
      const sessionId = props?.sessionId ?? null;
      const isCurrent = props?.current === true;
      const [tick, setTick] = React.useState(0);
      const [mode, setMode] = React.useState(() => store.getMode());
      const [query, setQuery] = React.useState('');
      const [tagFilter, setTagFilter] = React.useState('');
      const [notice, setNotice] = React.useState('');

      React.useEffect(() => store.subscribe(() => setTick((value) => value + 1)), []);
      React.useEffect(() => {
        const onFilter = (event) => setTagFilter(String(event.detail ?? ''));
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
      }, []);

      const tags = React.useMemo(
        () => (mode === 'all' ? store.allTags() : sessionId ? store.tags(sessionId) : []),
        [mode, sessionId, tick],
      );
      const visible = React.useMemo(() => {
        if (!sessionId) return [];
        return store
          .list(sessionId)
          .filter((pin) => matchesQuery(pin, query) && (tagFilter === '' || (pin.tags ?? []).includes(tagFilter)));
      }, [sessionId, query, tagFilter, tick]);

      // The overview honours the same filters as the per-Session list: search and
      // tag both narrow it, and the counts shown are the surviving ones.
      const overview = React.useMemo(() => {
        if (mode !== 'all') return [];
        return store
          .sessions()
          .map(([id, entry]) => [
            id,
            entry,
            entry.pins.filter(
              (pin) => matchesQuery(pin, query) && (tagFilter === '' || (pin.tags ?? []).includes(tagFilter)),
            ),
          ])
          .filter(([, , pins]) => pins.length > 0);
      }, [mode, query, tagFilter, tick]);

      const overviewCount = React.useMemo(
        () => overview.reduce((total, [, , pins]) => total + pins.length, 0),
        [overview],
      );

      const switchMode = (next) => {
        setMode(next);
        store.setMode(next);
      };

      const header = h(
        'div',
        { className: 'hd' },
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
          }),
          h(
            'span',
            { className: 'count' },
            mode === 'all' ? `${overviewCount} 条` : `${sessionId ? store.count(sessionId) : 0} 条`,
          ),
        ),
        tags.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
              tags.map((tag) =>
                h(
                  'span',
                  {
                    key: tag,
                    className: 'tag',
                    'data-on': tagFilter === tag ? '' : undefined,
                    onClick: () => setTagFilter(tagFilter === tag ? '' : tag),
                  },
                  `#${tag}`,
                ),
              ),
            )
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
                { className: 'scroll' },
                overview.map(([id, entry, pins]) =>
                  h(
                    'div',
                    { key: id },
                    h('div', { className: 'group' }, h('span', null, sessionLabel(entry)), ` · ${pins.length}`),
                    pins.map((pin) =>
                      h(PinCard, {
                        key: pin.id,
                        sessionId: id,
                        pin,
                        current: isCurrent && id === sessionId,
                        taggable: false,
                        onToggleTag: () => {},
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
          h('b', null, query !== '' || tagFilter !== '' ? '没有匹配的固定片段' : '这一段还没固定过任何内容'),
          query !== '' || tagFilter !== ''
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
          { className: 'scroll' },
          visible.map((pin) =>
            h(PinCard, {
              key: pin.id,
              sessionId,
              pin,
              current: false,
              taggable: true,
              onToggleTag: (tag) => store.toggleTag(sessionId, pin.id, tag),
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
              slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, (props) =>
                props?.sessionId ? `固定片段 · ${store.count(props.sessionId)}` : '固定片段',
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
            own(tabs.register({ id: TAB_ID, kind: TAB_KIND, title: () => '固定片段' }));
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
