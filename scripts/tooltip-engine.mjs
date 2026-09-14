/** Small, dependency-free help controller. Each module ships its own copy. */
export const CONTROL_SELECTOR =
  'button, input:not([type="hidden"]), select, textarea, summary, a, [role="button"], [role="separator"], .context-item, [title], [data-tooltip], [data-help]';
export function createHelpController({ id, scope, resolve, exclude = '', delay = 450 }) {
  const documents = new WeakMap();
  const states = new Set();
  const bound = new WeakSet();
  const originals = new WeakMap();
  const enabled = () => {
    try {
      return globalThis.game?.settings?.get(id, 'helpTooltips') !== false;
    } catch {
      return true;
    }
  };
  function hide(state) {
    clearTimeout(state.timer);
    state.timer = null;
    if (state.bubble && state.target) {
      const ids = (state.target.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((x) => x && x !== state.bubble.id);
      if (ids.length) state.target.setAttribute('aria-describedby', ids.join(' '));
      else state.target.removeAttribute('aria-describedby');
    }
    state.bubble?.remove();
    state.bubble = null;
    state.target = null;
  }
  const hideAll = () => {
    for (const state of states) hide(state);
  };
  function stateFor(doc) {
    if (documents.has(doc)) return documents.get(doc);
    const state = { doc, bubble: null, target: null, timer: null, observer: null };
    documents.set(doc, state);
    states.add(state);
    doc.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || (!state.bubble && !state.timer)) return;
        hide(state);
        // First Escape dismisses help; a subsequent Escape belongs to the window.
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    doc.addEventListener('pointerdown', () => hide(state), true);
    doc.addEventListener('click', () => hide(state), true);
    doc.addEventListener('scroll', () => hide(state), true);
    doc.defaultView?.addEventListener('resize', () => hide(state));
    doc.addEventListener('gurps-module-help-open', (event) => {
      if (event.detail !== id) hide(state);
    });
    return state;
  }
  function show(node) {
    const state = stateFor(node.ownerDocument);
    hide(state);
    if (!enabled()) return;
    state.target = node;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!node.isConnected || !enabled()) {
        hide(state);
        return;
      }
      const message = resolve(node, originals.get(node) || '');
      if (!message) {
        hide(state);
        return;
      }
      const doc = node.ownerDocument;
      const Custom = doc.defaultView?.CustomEvent;
      if (Custom) doc.dispatchEvent(new Custom('gurps-module-help-open', { detail: id }));
      const bubble = doc.createElement('div');
      bubble.id = `${id}-help-${Math.random().toString(36).slice(2)}`;
      bubble.dataset.helpOwner = id;
      bubble.setAttribute('role', 'tooltip');
      bubble.textContent = message;
      // Inline styles keep packages self-contained, including settings-only modules.
      bubble.style.cssText =
        'position:fixed;z-index:2147483647;box-sizing:border-box;width:max-content;max-width:min(340px,calc(100vw - 16px));padding:9px 12px;border:1px solid #a8bacb;border-radius:6px;background:#18232e;color:#fff;box-shadow:0 3px 12px #0006;font:14px/1.45 system-ui,sans-serif;overflow-wrap:anywhere;pointer-events:none;';
      doc.body.append(bubble);
      const rect = node.getBoundingClientRect();
      const width = doc.documentElement.clientWidth || doc.defaultView?.innerWidth || 1024;
      const height = doc.documentElement.clientHeight || doc.defaultView?.innerHeight || 768;
      const bubbleWidth = bubble.offsetWidth || 340;
      const bubbleHeight = bubble.offsetHeight || 60;
      bubble.style.left = `${Math.max(8, Math.min(rect.left, width - bubbleWidth - 8))}px`;
      const top =
        rect.bottom + 6 + bubbleHeight > height - 8 ? rect.top - bubbleHeight - 6 : rect.bottom + 6;
      bubble.style.top = `${Math.max(8, Math.min(top, height - bubbleHeight - 8))}px`;
      state.bubble = bubble;
      node.setAttribute(
        'aria-describedby',
        [node.getAttribute('aria-describedby'), bubble.id].filter(Boolean).join(' '),
      );
    }, delay);
  }
  function prepare(node) {
    if (node.matches?.('[role="tooltip"]') || (exclude && node.closest(exclude))) return;
    if (node.dataset.helpOwner && node.dataset.helpOwner !== id) return;
    const original =
      node.getAttribute('title') || node.getAttribute('data-tooltip') || originals.get(node) || '';
    const message = resolve(node, original);
    if (!message) return;
    originals.set(node, original);
    // Preserve an icon-only control's accessible name before removing native help.
    if (
      !node.getAttribute('aria-label') &&
      !node.getAttribute('aria-labelledby') &&
      !node.textContent.trim() &&
      !node.labels?.length
    ) {
      node.setAttribute('aria-label', original || message);
    }
    node.removeAttribute('title');
    node.removeAttribute('data-tooltip');
    node.dataset.helpOwner = id;
    if (bound.has(node)) return;
    bound.add(node);
    const state = stateFor(node.ownerDocument);
    node.addEventListener('mouseenter', () => show(node));
    node.addEventListener('focus', () => show(node));
    node.addEventListener('mouseleave', () => {
      if (state.target === node) hide(state);
    });
    node.addEventListener('blur', () => {
      if (state.target === node) hide(state);
    });
  }
  function attach(root) {
    // HTML forms are indexable too: unwrap jQuery only after checking nodeType.
    root = root?.nodeType ? root : root?.[0];
    if (!root?.querySelectorAll) return () => {};
    if (root.matches?.(CONTROL_SELECTOR)) prepare(root);
    for (const node of root.querySelectorAll(CONTROL_SELECTOR)) prepare(node);
    return () => hide(stateFor(root.ownerDocument));
  }
  function scan(root) {
    if (!root?.querySelectorAll) return;
    if (root.matches?.(scope) || root.closest?.(scope)) attach(root);
    else for (const owned of root.querySelectorAll(scope)) attach(owned);
  }
  function start(doc = globalThis.document) {
    if (!doc?.body) return;
    const state = stateFor(doc);
    if (state.observer) return;
    scan(doc.body);
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (Observer) {
      state.observer = new Observer((records) => {
        if (state.target && !state.target.isConnected) hide(state);
        for (const record of records)
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && !node.matches?.('[role="tooltip"]')) scan(node);
          }
      });
      state.observer.observe(doc.body, { childList: true, subtree: true });
    }
  }
  function register() {
    game.settings.register(id, 'helpTooltips', {
      name: 'Show help tooltips',
      hint: 'Show short explanations when you hover or use keyboard focus. Applies only to this client; labels and important notices remain visible.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true,
      onChange: hideAll,
    });
  }
  return { attach, scan, start, register, enabled, hideAll };
}

/** Labels are fallbacks; actions with side effects have explicit help in each module. */
export function helpResolver({
  id,
  actions = {},
  fields = {},
  rules = [],
  actionAttributes = ['data-action'],
}) {
  return (node, original = '') => {
    if (node.dataset.help) return node.dataset.help;
    for (const [selector, message] of rules)
      if (node.matches(selector)) return typeof message === 'function' ? message(node) : message;
    const setting = node.getAttribute('name');
    if (setting?.startsWith(`${id}.`)) {
      const definition = globalThis.game?.settings?.settings?.get(setting);
      if (definition?.hint)
        return globalThis.game?.i18n?.localize?.(definition.hint) || definition.hint;
    }
    for (const attr of actionAttributes) {
      const action = node.getAttribute(attr);
      if (action && actions[action]) return actions[action];
    }
    const key =
      node.getAttribute('data-field') ||
      node.getAttribute('data-draft') ||
      node.getAttribute('name') ||
      node.id;
    if (fields[key]) return fields[key];
    if (original) return globalThis.game?.i18n?.localize?.(original) || original;
    const group = node.closest('.form-group, label');
    const hint = group?.querySelector('.hint, small');
    if (hint?.textContent.trim()) return hint.textContent.trim();
    if (node.tagName === 'SUMMARY')
      return 'Expand or collapse this section. Opening it does not apply changes.';
    if (node.matches('[data-action="close"], [data-action="cancel"], [data-cancel]'))
      return 'Close this window. Changes already applied are retained.';
    if (node.matches('[type="submit"], [data-action="ok"], [data-action="apply"]'))
      return 'Confirm the values in this form and perform the labelled action.';
    const label =
      node.getAttribute('aria-label') ||
      node.labels?.[0]?.textContent?.trim() ||
      group?.querySelector('label, span')?.textContent?.trim() ||
      node.textContent.trim();
    if (!label || label.length > 140) return '';
    if (node.tagName === 'SELECT') return `Choose ${label.replace(/:$/, '')}.`;
    if (node.matches('input[type="checkbox"]'))
      return `Enable or disable ${label.replace(/:$/, '')}.`;
    if (node.matches('input, textarea')) return `Enter ${label.replace(/:$/, '')}.`;
    return label;
  };
}
