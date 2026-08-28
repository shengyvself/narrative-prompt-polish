/**
 * trust-fence.js — 浏览器信任围栏（Max-Null baseline 第 1 层）。
 * 行为对齐 DSH /api 网关围栏：Host 为 loopback 或连接行 trustedHosts 条目即放行；
 * sec-fetch-site: cross-site 与跨源 Origin 拒绝。这是 DNS-rebinding / 跨站防御，
 * 不是身份认证。（移植自 Max-Null dsh-draft-polish trust-fence.ts，MIT）
 */

/**
 * Host 头 authority 是否本机回环。
 * @param {string} hostname
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 解析 Host 头 authority 为 URL，失败返回 undefined。
 * @param {string} authority
 * @returns {URL | undefined}
 */
function parseAuthority(authority) {
  try {
    return new URL("http://" + authority)
  } catch {
    return undefined
  }
}

/**
 * 条目规范形：无端口写法返回 hostname，有端口返回 host:port。
 * @param {string} entry
 * @param {URL} entryUrl
 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== ''
    ? entryUrl.port
    : new URL("https://" + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/**
 * @param {URL} hostUrl
 * @param {readonly string[]} trustedHosts
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // 无端口条目按 hostname 匹配；带端口条目要求 host（含端口）全等。
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判定一个请求是否可进入插件路由。
 * @param {{ headers: Record<string, unknown> }} request
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const h = request.headers
  const header = (name) => (typeof h[name] === "string" ? /** @type {string} */ (h[name]) : undefined)
  const host = header('host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header('sec-fetch-site') === 'cross-site') return false
  const origin = header('origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}