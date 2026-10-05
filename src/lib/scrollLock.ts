/**
 * body 滚动锁（引用计数）
 *
 * 为什么不能用「各自保存上一次的值再还原」：
 * 面板可以叠加（分类详情 → 删除确认）。后开的面板读到的 `overflow` 已经是 `hidden`，
 * 把它当原值存下来后，关闭时又还原成 `hidden`——滚动就再也回不来了。
 *
 * 正确做法：只有第一个锁请求记录真实原值，最后一个释放时才还原。
 */

let lockCount = 0
let savedOverflow = ''
let savedPaddingRight = ''

/** 滚动条宽度补偿：锁定时若出现滚动条消失导致的横向跳动，用 padding 顶上 */
function scrollbarWidth(): number {
  if (typeof window === 'undefined') return 0
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth)
}

export function lockBodyScroll(): void {
  if (typeof document === 'undefined') return
  lockCount += 1
  if (lockCount > 1) return

  savedOverflow = document.body.style.overflow
  savedPaddingRight = document.body.style.paddingRight

  const gap = scrollbarWidth()
  document.body.style.overflow = 'hidden'
  if (gap > 0) document.body.style.paddingRight = `${gap}px`
}

export function unlockBodyScroll(): void {
  if (typeof document === 'undefined') return
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount > 0) return

  document.body.style.overflow = savedOverflow
  document.body.style.paddingRight = savedPaddingRight
}

/** 供测试与调试：当前锁了几层 */
export function bodyScrollLockCount(): number {
  return lockCount
}
