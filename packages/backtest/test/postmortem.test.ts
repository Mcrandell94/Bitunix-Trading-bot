import { describe, expect, test } from 'vitest';
import { classifyLoss } from '../src/screen/postmortem';

describe('loss post-mortem classification', () => {
  test('the four loser types and the winner', () => {
    expect(classifyLoss({ r: 1.5, how: 'target', open: false, mfe: 3, after2R: false, backToEntry: true })).toBe('winner');
    expect(classifyLoss({ r: -1, how: 'stop', open: false, mfe: 1.4, after2R: true, backToEntry: true })).toBe('gave it back');
    expect(classifyLoss({ r: -1, how: 'stop', open: false, mfe: 0.3, after2R: true, backToEntry: true })).toBe('noise stop');
    expect(classifyLoss({ r: -1, how: 'stop', open: false, mfe: 0.2, after2R: false, backToEntry: false })).toBe('wrong way');
    expect(classifyLoss({ r: -0.3, how: 'time', open: false, mfe: 0.6, after2R: false, backToEntry: true })).toBe('time / chop');
    expect(classifyLoss({ r: -0.5, how: 'open', open: true, mfe: 0.1, after2R: false, backToEntry: false })).toBe('open');
  });
});
