/** 生成稳定且基本无碰撞的本地 id */
export function uid(prefix = 'id'): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return `${prefix}_${c.randomUUID().slice(0, 8)}`
  }
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rnd}`
}
