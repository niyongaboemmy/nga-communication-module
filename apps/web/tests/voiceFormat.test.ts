import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVoiceFormat, voiceExtension } from '../src/lib/voiceFormat.ts';

test('Chromium (and Safari 18.4+): WebM/Opus', () => {
  assert.equal(pickVoiceFormat(() => true), 'audio/webm;codecs=opus');
});

test('older Safari / WKWebView: falls back to MP4/AAC instead of failing', () => {
  const safari = new Set(['audio/mp4', 'audio/mp4;codecs=mp4a.40.2']);
  assert.equal(pickVoiceFormat((m) => safari.has(m)), 'audio/mp4;codecs=mp4a.40.2');
});

test('nothing reported: let the engine choose', () => {
  assert.equal(pickVoiceFormat(() => false), undefined);
  assert.equal(pickVoiceFormat(() => { throw new Error('no isTypeSupported'); }), undefined);
});

test('file names follow the format', () => {
  assert.equal(voiceExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(voiceExtension('audio/mp4'), 'm4a');
  assert.equal(voiceExtension('audio/mp4;codecs=mp4a.40.2'), 'm4a');
  assert.equal(voiceExtension('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(voiceExtension(''), 'webm');
});
