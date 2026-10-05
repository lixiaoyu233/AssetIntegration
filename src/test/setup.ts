/**
 * 测试环境准备
 *
 * Node 没有 IndexedDB / DOM，而 Dexie 两者都需要。这里注入 `fake-indexeddb`
 * （devDependency，不会进入生产包），让仓储层可以在单测里真实跑一遍
 * 事务、索引与幂等语义 —— 比用内存 mock 更有价值。
 *
 * 注意：`fake-indexeddb/auto` 会把 IndexedDB 挂到 globalThis，
 * 并且顺带提供 Dexie 需要的 `self` / `CustomEvent` 等浏览器全局。
 */

import 'fake-indexeddb/auto'

// Dexie 在部分代码路径会访问 window / navigator
const g = globalThis as unknown as Record<string, unknown>
if (typeof g.window === 'undefined') {
  g.window = g
}
if (typeof g.navigator === 'undefined') {
  g.navigator = { userAgent: 'node-test' }
}
