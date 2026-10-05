import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bodyScrollLockCount, lockBodyScroll, unlockBodyScroll } from './scrollLock'

/*
 * 这组测试盯的是「面板叠加后滚动锁没释放」这个真实缺陷：
 * 原先每个 Sheet 各自保存上一次的 overflow，后开的面板会把 'hidden' 当原值存下来，
 * 关闭后还原成 'hidden'，页面就再也滚不动了。
 *
 * 测试环境是 node（没有 DOM），这里用最小 stub 替代 jsdom，
 * 只实现被测代码用到的那几个属性。
 */
function installDomStub() {
  const bodyStyle: Record<string, string> = { overflow: '', paddingRight: '' }
  const doc = {
    body: { style: bodyStyle },
    documentElement: { clientWidth: 400 },
    addEventListener() {},
    removeEventListener() {},
  }
  ;(globalThis as unknown as { document: unknown }).document = doc
  ;(globalThis as unknown as { window: unknown }).window = { innerWidth: 400 }
}

function removeDomStub() {
  delete (globalThis as unknown as { document?: unknown }).document
  delete (globalThis as unknown as { window?: unknown }).window
}

describe('body 滚动锁（引用计数）', () => {
  let bodyStyle: Record<string, string>

  beforeEach(() => {
    installDomStub()
    bodyStyle = (globalThis as unknown as { document: { body: { style: Record<string, string> } } }).document.body.style
  })

  afterEach(() => {
    while (bodyScrollLockCount() > 0) unlockBodyScroll()
    removeDomStub()
  })

  it('单层面板：开锁 → 关锁后恢复原值', () => {
    bodyStyle.overflow = 'auto'
    lockBodyScroll()
    expect(bodyStyle.overflow).toBe('hidden')
    unlockBodyScroll()
    expect(bodyStyle.overflow).toBe('auto')
    expect(bodyScrollLockCount()).toBe(0)
  })

  it('两层叠加：只有最后一个释放才恢复', () => {
    bodyStyle.overflow = 'auto'
    lockBodyScroll() // 详情面板
    lockBodyScroll() // 删除确认
    expect(bodyStyle.overflow).toBe('hidden')

    unlockBodyScroll() // 关掉确认
    expect(bodyStyle.overflow).toBe('hidden')
    expect(bodyScrollLockCount()).toBe(1)

    unlockBodyScroll() // 关掉详情
    expect(bodyStyle.overflow).toBe('auto')
    expect(bodyScrollLockCount()).toBe(0)
  })

  it('顺序颠倒（先关外层）也能恢复', () => {
    bodyStyle.overflow = ''
    lockBodyScroll()
    lockBodyScroll()
    unlockBodyScroll()
    unlockBodyScroll()
    expect(bodyStyle.overflow).toBe('')
  })

  it('多层叠加后全部释放，不会残留 hidden', () => {
    bodyStyle.overflow = ''
    for (let i = 0; i < 5; i++) lockBodyScroll()
    for (let i = 0; i < 5; i++) unlockBodyScroll()
    expect(bodyScrollLockCount()).toBe(0)
    expect(bodyStyle.overflow).not.toBe('hidden')
  })

  it('多余的 unlock 不会把计数压成负数', () => {
    unlockBodyScroll()
    unlockBodyScroll()
    expect(bodyScrollLockCount()).toBe(0)
  })

  it('不覆盖原有的 paddingRight', () => {
    bodyStyle.paddingRight = '7px'
    lockBodyScroll()
    unlockBodyScroll()
    expect(bodyStyle.paddingRight).toBe('7px')
  })

  it('没有 DOM 时调用不报错（SSR / 测试环境）', () => {
    removeDomStub()
    expect(() => {
      lockBodyScroll()
      unlockBodyScroll()
    }).not.toThrow()
  })
})
