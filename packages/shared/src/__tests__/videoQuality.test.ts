import { describe, it, expect } from 'vitest';
import { qualityForWidth } from '../meet.js';

/**
 * The simulcast rung a tile asks for.
 *
 * Getting this wrong is not a cosmetic fault: every change of rung is a real
 * unsubscribe and re-subscribe against the SFU, so a mapping that flips back
 * and forth tears the stream down and rebuilds it repeatedly, and almost no
 * video arrives.
 */

describe('rung mapping', () => {
  it('serves nothing to a tile that is not on screen', () => {
    expect(qualityForWidth(0)).toBe('off');
    expect(qualityForWidth(-1)).toBe('off');
  });

  it('matches the rung to the size actually rendered', () => {
    expect(qualityForWidth(160)).toBe('low');
    expect(qualityForWidth(320)).toBe('medium');
    expect(qualityForWidth(1280)).toBe('high');
  });

  it('takes the boundary itself as the higher rung', () => {
    expect(qualityForWidth(240)).toBe('medium');
    expect(qualityForWidth(640)).toBe('high');
  });
});

describe('hysteresis', () => {
  it('sharpens immediately when a tile grows', () => {
    // Stepping up needs no damping — it cannot oscillate, because the step
    // down is the half that is damped.
    expect(qualityForWidth(700, 'medium')).toBe('high');
    expect(qualityForWidth(300, 'low')).toBe('medium');
  });

  it('holds its rung for a tile resting on the boundary', () => {
    // The bug this pins: a two-up grid at a common window size renders tiles
    // at almost exactly 640px. Without hysteresis the tile alternated between
    // 'medium' and 'high' on every layout settle, and each flip re-subscribed.
    expect(qualityForWidth(639, 'high')).toBe('high');
    expect(qualityForWidth(600, 'high')).toBe('high');
    expect(qualityForWidth(239, 'medium')).toBe('medium');
  });

  it('gives up the rung once the tile is genuinely clear of the boundary', () => {
    // Held, not held forever — a tile that really has shrunk must stop paying
    // for pixels it cannot show.
    expect(qualityForWidth(560, 'high')).toBe('medium');
    expect(qualityForWidth(200, 'medium')).toBe('low');
  });

  it('still turns off entirely when the tile leaves the screen', () => {
    expect(qualityForWidth(0, 'high')).toBe('off');
  });

  it('is memoryless when no previous rung is supplied', () => {
    expect(qualityForWidth(639)).toBe('medium');
    expect(qualityForWidth(639, 'off')).toBe('medium');
  });
});
