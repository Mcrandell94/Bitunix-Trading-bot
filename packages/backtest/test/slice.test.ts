import { expect, test } from 'vitest';
import { sliceList } from '../src/screen/slice';

test('--slice k/n: every n-th coin from the k-th, the reference coin in every slice, nothing lost or doubled', () => {
  const list = ['A', 'B', 'C', 'D', 'E', 'BTCUSDT'], keep = new Set(['BTCUSDT']);
  expect(sliceList(list, undefined, keep)).toEqual(list);
  expect(sliceList(list, '1/2', keep)).toEqual(['A', 'C', 'E', 'BTCUSDT']);
  expect(sliceList(list, '2/2', keep)).toEqual(['B', 'D', 'BTCUSDT']);
  const all = ['1/3', '2/3', '3/3'].flatMap((k) => sliceList(list, k, keep).filter((s) => s !== 'BTCUSDT')).sort();
  expect(all).toEqual(['A', 'B', 'C', 'D', 'E']);
  expect(() => sliceList(list, '3/2')).toThrow();
  expect(() => sliceList(list, 'x')).toThrow();
});
