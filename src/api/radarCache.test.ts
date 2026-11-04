/**
 * api/radarCache.test.ts —— LRU 缓存边界回归测试
 *
 * 覆盖条数淘汰、字节预算淘汰、命中后提升最近使用、至少保留 1 条。
 */
import { describe, expect, it } from 'vitest';
import { LruCache } from './radarCache';

interface Item {
  size: number;
}

/** 构造指定“字节数”的缓存值 */
const item = (size: number): Item => ({ size });

describe('LruCache', () => {
  it('按条数淘汰最久未使用项', () => {
    const cache = new LruCache<Item>({
      maxEntries: 2,
      maxBytes: 1_000_000,
      estimate: (v) => v.size
    });
    cache.set('a', item(100));
    cache.set('b', item(100));
    cache.set('c', item(100));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('命中后提升为最近使用，淘汰顺序随之后移', () => {
    const cache = new LruCache<Item>({
      maxEntries: 2,
      maxBytes: 1_000_000,
      estimate: (v) => v.size
    });
    cache.set('a', item(100));
    cache.set('b', item(100));
    cache.get('a'); // a 变为最近使用
    cache.set('c', item(100));

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('按字节预算淘汰，且至少保留 1 条', () => {
    const cache = new LruCache<Item>({
      maxEntries: 10,
      maxBytes: 250,
      estimate: (v) => v.size
    });
    cache.set('a', item(100));
    cache.set('b', item(100));
    cache.set('c', item(100));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();

    // 单条 500 字节 > 预算 250：仍保留这一条，不能刚写入就被自己挤掉
    cache.set('big', item(500));
    expect(cache.size).toBe(1);
    expect(cache.get('big')).toBeDefined();
  });

  it('同键重复写入只保留一份并更新字节数', () => {
    const cache = new LruCache<Item>({
      maxEntries: 2,
      maxBytes: 1_000_000,
      estimate: (v) => v.size
    });
    cache.set('a', item(100));
    cache.set('b', item(100));
    cache.set('a', item(200));
    cache.set('c', item(100));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('clear 清空全部条目', () => {
    const cache = new LruCache<Item>({
      maxEntries: 3,
      maxBytes: 1000,
      estimate: (v) => v.size
    });
    cache.set('a', item(10));
    cache.set('b', item(10));
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
