// Minimal Foundry lifecycle harness. This is not Foundry itself.
const callbacks = new Map();
globalThis.Hooks = {
  on: (key, fn) => {
    const f = callbacks.get(key) ?? [];
    f.push(fn);
    callbacks.set(key, f);
  },
  once: (key, fn) => Hooks.on(key, fn),
  call: (key, ...args) => {
    for (const fn of callbacks.get(key) ?? []) fn(...args);
  },
};
class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
}
globalThis.fixtureErrors = [];
globalThis.ui = {
  notifications: {
    error: (message) => {
      fixtureErrors.push(message);
    },
    warn: (message) => {
      fixtureErrors.push(message);
    },
    info: () => {},
  },
};
const gm = { id: 'gm', name: 'Game Master', isGM: true, active: true },
  alice = { id: 'alice', name: 'Alice', isGM: false, active: true };
const settings = new Map(),
  users = new Collection([
    [gm.id, gm],
    [alice.id, alice],
  ]);
users.activeGM = gm;
globalThis.game = {
  user: gm,
  users,
  journal: new Collection(),
  messages: new Collection(),
  actors: new Collection(),
  combats: new Collection(),
  modules: new Map([['gurps-action-chases', {}]]),
  settings: {
    register: (id, key, data) => settings.set(`${id}.${key}`, data.default),
    get: (id, key) => settings.get(`${id}.${key}`),
    set: async (id, key, value) => settings.set(`${id}.${key}`, value),
    registerMenu: () => {},
  },
  keybindings: { register: () => {} },
};
class BaseApplication {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options };
    this.rendered = false;
  }
  render() {
    this.rendered = true;
    this.renderPromise = (this.renderPromise ?? Promise.resolve()).then(async () => {
      if (!this.rendered) return;
      if (!this.element) {
        this.element = document.createElement('section');
        this.element.className = `application ${this.options.classes?.join(' ') ?? ''}`;
        this.element.innerHTML =
          '<header class="window-header"><span></span><button class="close">×</button></header><div class="window-content"></div>';
        document.body.append(this.element);
        this.element.querySelector('.close').onclick = () => this.close();
      }
      this.element.querySelector('.window-header span').textContent =
        this.options.window?.title ?? 'Window';
      this._replaceHTML(
        await this._renderHTML(),
        this.element.querySelector('.window-content'),
        {},
      );
    });
    return this;
  }
  async close() {
    this.rendered = false;
    this.element?.remove();
    this.element = null;
  }
}
globalThis.foundry = {
  applications: {
    api: { ApplicationV2: BaseApplication, DialogV2: { confirm: async () => true } },
  },
  appv1: { api: { FormApplication: class {} } },
};
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };
globalThis.fromUuidSync = () => null;
globalThis.fromUuid = async () => null;
const getPath = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let target = obj;
  for (const k of keys.slice(0, -1)) target = target[k] ??= {};
  target[keys.at(-1)] = value;
};
globalThis.JournalEntry = {
  create: async (data) => {
    const doc = {
      ...data,
      id: crypto.randomUUID(),
      getFlag: (id, key) => getPath(doc, `flags.${id}.${key}`),
      testUserPermission: () => true,
      update: async (change) => {
        for (const [k, v] of Object.entries(change)) setPath(doc, k, v);
        Hooks.call('updateJournalEntry', doc, change, {}, game.user.id);
        return doc;
      },
    };
    game.journal.set(doc.id, doc);
    Hooks.call('createJournalEntry', doc, {}, game.user.id);
    return doc;
  },
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [gm],
  create: async (data) => {
    const message = {
      ...data,
      id: crypto.randomUUID(),
      getFlag: (id, key) => getPath(message, `flags.${id}.${key}`),
      update: async (change) => {
        for (const [k, v] of Object.entries(change)) setPath(message, k, v);
        Hooks.call('updateChatMessage', message, change, {}, game.user.id);
        return message;
      },
    };
    game.messages.set(message.id, message);
    Hooks.call('createChatMessage', message, {}, game.user.id);
    return message;
  },
};
globalThis.Roll = class {
  constructor(formula) {
    this.formula = formula;
  }
  async evaluate() {
    this.total = 10;
    return this;
  }
  async toMessage(data) {
    return ChatMessage.create(data);
  }
};
await import('../scripts/main.mjs');
Hooks.call('init');
Hooks.call('ready');
game.modules.get('gurps-action-chases').api.open();
