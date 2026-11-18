'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real client script against a small DOM adapter. No server or user data.
function page(initial = { session: { user: null }, view: 'history' }, configure = () => {}) {
  const nodes = new Map(), formatters = [], intervals = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', method: 'get', submissions: 0, handlers: {}, style: {}, dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      elements: { namedItem: () => null },
      addEventListener(type, callback) { this.handlers[type] = callback; },
      closest() { return this.form; },
      requestSubmit() { this.submissions++; },
    });
    return nodes.get(id);
  };
  node('smena-bootstrap').textContent = JSON.stringify(initial);
  for (const prefix of ['history', 'report']) {
    for (const suffix of ['from', 'to', 'status']) node(`${prefix}-${suffix}`).form = node(`${prefix}-filter-form`);
  }
  const document = { querySelector: selector => node(selector.slice(1)), querySelectorAll: () => [], addEventListener() {} };
  const context = { document, window: { addEventListener() {} }, location: { hash: '', search: '', pathname: '/', href: 'http://localhost/', reload() {} },
    Intl: { DateTimeFormat: function (...args) { const formatter = new Intl.DateTimeFormat(...args); formatters.push(formatter); return formatter; } },
    URL, URLSearchParams, setInterval(callback, delay) { intervals.set(delay, callback); }, setTimeout() {}, clearTimeout() {}, console,
  };
  configure({ context, document, node });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8'), context);
  const emit = async (id, type) => {
    const element = node(id), event = { target: element, currentTarget: element, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await element.handlers[type](event);
    return event;
  };
  return { node, emit, formatters, intervals };
}

module.exports = { page };
