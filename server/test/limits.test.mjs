import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimits, isAllowedOrigin } from '../limits.mjs';

test('per-IP limit allows 30 a minute, then refuses, then recovers after 60 s', () => {
  let t = 1_000_000;
  const limits = createLimits({ now: () => t });
  for (let i = 0; i < 30; i++) assert.equal(limits.allowRequest('1.2.3.4'), true);
  assert.equal(limits.allowRequest('1.2.3.4'), false);
  assert.equal(limits.allowRequest('5.6.7.8'), true, 'another IP has its own budget');
  t += 60_001;
  assert.equal(limits.allowRequest('1.2.3.4'), true);
});

test('daily caps: 300 spec calls and 20,000 TTS characters', () => {
  const limits = createLimits();
  for (let i = 0; i < 300; i++) assert.equal(limits.takeSpec(), true);
  assert.equal(limits.takeSpec(), false);
  assert.equal(limits.takeTts(19_990), true);
  assert.equal(limits.takeTts(11), false);
  assert.equal(limits.takeTts(10), true);
  assert.deepEqual(limits.snapshot(), { per_minute: 30, spec_calls_today: 300, spec_calls_per_day: 300, tts_chars_today: 20_000, tts_chars_per_day: 20_000 });
});

test('origin check: local pages and listed origins only', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://localhost:4173'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('https://aftergrip.example', ['https://aftergrip.example']), true);
  assert.equal(isAllowedOrigin('http://localhost.evil.example'), false);
});
