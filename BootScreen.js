/**
 * BootScreen.js
 *
 * A loading overlay that fails loudly. The previous version removed itself on
 * the last line of main.js, which meant any throw during boot left a frozen
 * splash and no explanation — the single worst failure mode for a page whose
 * startup does WASM loading, CDN resolution and geometry baking.
 *
 * Every stage reports itself, and anything thrown lands on screen.
 */

const el = (id) => document.getElementById(id);

let started = performance.now();
let watchdog = null;
let finished = false;

export const BootScreen = {
  stage(text) {
    if (finished) return;
    const node = el('boot-stage');
    if (node) node.textContent = text;
    console.info(`[boot] ${text} (+${((performance.now() - started) / 1000).toFixed(2)}s)`);
  },

  /**
   * @param {unknown} error
   * @param {string} [hint] actionable next step, shown above the raw message
   */
  fail(error, hint = '') {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);

    const root = el('boot');
    if (!root) {
      console.error(error);
      return;
    }
    root.classList.add('is-error');

    const title = el('boot-title');
    const stage = el('boot-stage');
    const detail = el('boot-detail');

    if (title) title.textContent = 'Startup failed';
    if (stage) stage.textContent = hint || 'See the message below and the browser console.';
    if (detail) {
      const message = error instanceof Error
        ? `${error.name}: ${error.message}\n\n${error.stack ?? ''}`
        : String(error);
      detail.textContent = message.trim();
      detail.hidden = false;
    }
    console.error('[boot] failed', error);
  },

  done() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    el('boot')?.remove();
    console.info(`[boot] ready in ${((performance.now() - started) / 1000).toFixed(2)}s`);
  },

  /** Catches the silent cases: a hung fetch, a promise that never settles. */
  armWatchdog(ms = 20000) {
    started = performance.now();
    watchdog = setTimeout(() => {
      if (finished) return;
      const stage = el('boot-stage');
      if (stage) {
        stage.textContent =
          'Still working after 20 seconds. Check the Network tab — a CDN request is probably blocked or very slow.';
      }
    }, ms);
  },
};
