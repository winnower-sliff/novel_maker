import { getPort } from './config.js'
import { lanAddresses } from './server.js'

/** 连接地址：Tailscale 优先（主场景），回退物理网卡。手机端手输一次即可。 */
export function connectHost(): { host: string; port: number } {
  const { primary, tailscale } = lanAddresses()
  return { host: tailscale ?? primary ?? '127.0.0.1', port: getPort() }
}
