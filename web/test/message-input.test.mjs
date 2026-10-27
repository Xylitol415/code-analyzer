import assert from 'node:assert/strict';
import {test} from 'node:test';
import React, {act} from 'react';
import {create} from 'react-test-renderer';
import {MessageInput} from '../src/components/MessageInput.tsx';
const pending = {id: 'p1', question: 'Full pending message\nwith another line', mode: 'steer', createdAt: 1, status: 'unapplied', reuse: 'bypass'};
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise, resolve, reject}; }
function text(node) { if (!node) return ''; if (typeof node === 'string') return node; return (node.children ?? []).map(text).join(''); }
async function setup(t, initial = {}) {
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const originalError = console.error;
  t.mock.method(console, 'error', (...args) => {if (!String(args[0]).startsWith('react-test-renderer is deprecated')) originalError(...args);});
  let props = {disabled: false, streaming: true, onSend() {}, onStop() {}, pendingMessages: [pending], ...initial};
  let root; await act(async () => { root = create(React.createElement(MessageInput, props)); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct; });
  return { get root() {return root.root;}, get text() {return text(root.toJSON());}, get value() {return root.root.findByType('textarea').props.value;},
    async input(value) {await act(async () => root.root.findByType('textarea').props.onChange({target: {value}}));},
    async click(label) {const button = root.root.findAllByType('button').find(n => n.props['aria-label'] === label || text(n) === label); assert.ok(button, label); await act(async () => {void button.props.onClick();});},
    async update(next) { props = {...props, ...next}; await act(async () => root.update(React.createElement(MessageInput, props))); }
  };
}
test('busy input queues Enter, offers steering and retains failed submission draft', async t => {
  const sent = [], queued = [], steered = [];
  const h = await setup(t, {onSend: q => sent.push(q), onQueue: q => queued.push(q), onSteer: async q => {steered.push(q); throw new Error('task finished');}});
  await h.input('Next task');
  await act(async () => {void h.root.findByType('textarea').props.onKeyDown({key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault() {}});});
  assert.deepEqual(queued, ['Next task']); assert.deepEqual(sent, []); assert.equal(h.value, '');
  await h.input('Correction'); await h.click('引导');
  assert.deepEqual(steered, ['Correction']); assert.equal(h.value, 'Correction'); assert.match(h.text, /task finished/);
  assert.match(h.text, /停止当前/);
});
test('withdraw waits for backend and never overwrites existing or newly typed draft', async t => {
  const response = deferred(); let calls = 0;
  const h = await setup(t, {onCancelPending: () => {calls++; return response.promise;}});
  assert.match(h.text, /未采用/); assert.match(h.text, /with another line/);
  await h.input('Existing draft'); await h.click(`撤回编辑：${pending.question}`);
  assert.equal(calls, 0); assert.equal(h.value, 'Existing draft');
  await h.input(''); await h.click(`撤回编辑：${pending.question}`);
  assert.equal(h.value, ''); assert.match(h.text, /Full pending message/);
  await act(async () => {response.resolve(pending);});
  assert.equal(h.value, pending.question);
  assert.equal(h.root.findByType('input').props.checked, true);
});
test('failed removal keeps card and draft and shows server conflict', async t => {
  const h = await setup(t, {onCancelPending: async () => {throw new Error('already running');}});
  await h.input('Keep this'); await h.click(`删除：${pending.question}`);
  assert.match(h.text, /Full pending message/); assert.match(h.text, /already running/); assert.equal(h.value, 'Keep this');
});
test('withdraw locks draft while awaiting confirmation and ignores a replaced session reply', async t => {
  const response = deferred();
  const h = await setup(t, {scopeKey: 'first', onCancelPending: () => response.promise});
  await h.click(`撤回编辑：${pending.question}`);
  assert.equal(h.root.findByType('textarea').props.disabled, true);
  await h.update({scopeKey: 'next', pendingMessages: []});
  await h.input('New session draft');
  await act(async () => response.resolve(pending));
  assert.equal(h.value, 'New session draft');
});
