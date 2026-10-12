/**
 * dsh-pins — host half.
 *
 * Deliberately thin. The durable state of a pin (the selected text, its tags,
 * and where it came from) belongs to the browser that shows the conversation,
 * so the browser half owns it; this half exists so the bundle is a complete
 * Cordis plugin, gives the Client a package-private entry point to reach the
 * Host with later (an export command, an agent tool, a shared file), and keeps
 * one piece of always-available metadata.
 *
 * It registers no tools, injects no prompt text, and appends no session events,
 * so it has no effect on what the model sees.
 */

const PKG = 'dsh-pins';

/** Stable identity of this plugin's state, shared with the browser half when it needs it. */
const STATE_KEY = 'dsh-pins/v1';

class PinsHostService {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** Which plugin this service belongs to; the browser half uses it as a namespace. */
  identity() {
    return { package: PKG, stateKey: STATE_KEY };
  }

  /**
   * Echo one payload back over the Client/Host boundary.
   *
   * Used as a one-shot connectivity check: a browser half that receives its own
   * payload back knows the private Host channel works, and can report that
   * instead of failing silently when a later feature starts writing files.
   *
   * @param {unknown} payload - any JSON value.
   * @returns {Promise<{ ok: true, package: string, echoed: unknown }>} the echo.
   */
  async ping(payload) {
    return { ok: true, package: PKG, echoed: payload === undefined ? null : payload };
  }
}

module.exports = {
  name: PKG,
  apply(ctx) {
    ctx.effect(() => ctx.provide('pinsHost', new PinsHostService(ctx)), 'dsh-pins: host service');
  },
};
