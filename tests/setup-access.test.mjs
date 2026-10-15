import test from 'node:test';
import assert from 'node:assert/strict';
import { canConfigureAdmin } from '../src/server/setup-access.mjs';
const token = 'a'.repeat(43);
test('публичная настройка администратора требует отдельный секрет, а не просто вход в Sites', () => {
  assert.equal(canConfigureAdmin(new Request('https://example.test/api/setup'), token), false);
  assert.equal(canConfigureAdmin(new Request('https://example.test/api/setup', { headers: { 'oai-authenticated-user-id': 'visitor' } }), token), false);
  assert.equal(canConfigureAdmin(new Request('https://example.test/api/setup', { headers: { 'X-Setup-Token': token } }), token), true);
  assert.equal(canConfigureAdmin(new Request('https://example.test/api/setup', { headers: { 'X-Setup-Token': 'b'.repeat(43) } }), token), false);
  assert.equal(canConfigureAdmin(new Request('https://example.test/api/setup', { headers: { 'X-Setup-Token': token } }), undefined), false);
});
