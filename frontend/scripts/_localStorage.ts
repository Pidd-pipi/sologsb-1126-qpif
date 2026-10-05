/**
 * node 测试环境补浏览器 localStorage（归并快照依赖）。
 * 必须作为 merge.test.ts 的第一条 import，先于其它模块完成挂载。
 */
const mem = new Map<string, string>()

const storage: Storage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    mem.set(k, String(v))
  },
  removeItem: (k: string) => {
    mem.delete(k)
  },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() {
    return mem.size
  }
}

;(globalThis as unknown as { localStorage: Storage }).localStorage = storage
;(globalThis as unknown as { window: { localStorage: Storage } }).window = {
  localStorage: storage
}

// fake-indexeddb 必须先于 Dexie（src/utils/db.ts）求值完成，故放在本注入模块里
import 'fake-indexeddb/auto'

// 自检（仅测试构建下输出）
storage.setItem('__selfcheck__', '1')
if (storage.getItem('__selfcheck__') !== '1' || globalThis.localStorage.getItem('__selfcheck__') !== '1') {
  console.error('[polyfill] localStorage self-check failed')
}
storage.removeItem('__selfcheck__')
