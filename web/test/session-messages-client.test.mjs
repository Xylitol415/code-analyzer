import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as client from '../src/api/client.ts';
const config = { baseUrl: 'http://backend.test', token: 'secret' };
test('pending message requests preserve auth, encoded identities and server conflict details', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({url, ...options});
    if (requests.length === 3) return Response.json({error: 'already applied'}, {status: 409});
    return Response.json(requests.length === 1 ? {revision: 2, activeRequestId: 'run', pending: []} : {message: {id: 'steer'}, state: {revision: 3, activeRequestId: 'run', pending: []}});
  });
  assert.equal(typeof client.getSessionMessages, 'function');
  assert.equal((await client.getSessionMessages(config, 'session/a')).revision, 2);
  await client.steerSession(config, 'session/a', {question: 'Correction', requestId: 'steer', targetRequestId: 'run'});
  await assert.rejects(() => client.cancelSessionMessage(config, 'session/a', 'message/b'), /already applied/);
  assert.equal(requests[0].url, 'http://backend.test/sessions/session%2Fa/messages');
  assert.deepEqual(JSON.parse(requests[1].body), {question: 'Correction', requestId: 'steer', targetRequestId: 'run'});
  assert.equal(requests[2].url, 'http://backend.test/sessions/session%2Fa/messages/message%2Fb');
  assert.equal(requests[2].headers.Authorization, 'Bearer secret');
});
