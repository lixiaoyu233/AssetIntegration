/**
 * JSONP 加载器
 *
 * 天天基金的公开估值接口（fundgz.1234567.com.cn）与行情接口（push2.eastmoney.com）
 * 均不返回 `Access-Control-Allow-Origin`，浏览器里用 fetch/XHR 直连会被 CORS 拦截。
 * JSONP 通过 <script src> 绕过同源策略：脚本不受 CORS 限制，服务端把数据包在
 * `回调名({...})` 里返回，浏览器执行后即可拿到数据。
 *
 * 纯前端部署（GitHub Pages）下的注意点：
 * 1. 回调函数必须挂在 globalThis 上，且名字全局唯一，避免并发请求互相覆盖；
 * 2. 无论成功失败都必须清理 script 标签和全局函数，防止内存泄漏；
 * 3. 必须设置超时，否则网络挂起时 Promise 永远不 settle；
 * 4. JSONP 无法拿到 HTTP 状态码，出错通常表现为脚本解析失败 → onerror，或数据为空。
 */

export interface JsonpOptions {
  /** 查询参数中回调名所在的键，天天基金两个接口都用 `cb` */
  callbackKey?: string
  /** 自定义回调名前缀 */
  prefix?: string
  /** 超时毫秒数 */
  timeout?: number
  /** 额外查询参数 */
  params?: Record<string, string | number | undefined>
}

export class JsonpError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message)
    this.name = 'JsonpError'
  }
}

let seq = 0

function buildUrl(url: string, params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as Array<[string, string | number]>
  if (entries.length === 0) return url
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`
}

export function jsonp<T = unknown>(url: string, options: JsonpOptions = {}): Promise<T> {
  const { callbackKey = 'cb', prefix = '__acw_jsonp', timeout = 12_000, params = {} } = options

  return new Promise<T>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new JsonpError('当前环境不支持 JSONP（缺少 document）', url))
      return
    }

    seq += 1
    const cbName = `${prefix}_${Date.now().toString(36)}_${seq}`
    const script = document.createElement('script')
    const globalScope = globalThis as Record<string, unknown>
    let settled = false

    const cleanup = () => {
      window.clearTimeout(timer)
      try {
        delete globalScope[cbName]
      } catch {
        globalScope[cbName] = undefined
      }
      script.remove()
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const timer = window.setTimeout(() => {
      finish(() =>
        reject(new JsonpError('请求超时，可能是网络不通或被浏览器拦截（可尝试关闭广告拦截插件）', fullUrl)),
      )
    }, timeout)

    const fullUrl = buildUrl(url, { ...params, [callbackKey]: cbName })

    globalScope[cbName] = (data: T) => {
      finish(() => {
        if (data === null || data === undefined) {
          reject(new JsonpError('接口返回空数据（基金代码可能不存在）', fullUrl))
        } else {
          resolve(data)
        }
      })
    }

    script.src = fullUrl
    script.async = true
    script.charset = 'utf-8'
    script.onerror = () => {
      finish(() => reject(new JsonpError('脚本加载失败（域名不可达或已下线）', fullUrl)))
    }

    document.head.appendChild(script)
  })
}
