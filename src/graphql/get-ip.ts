import { type Request } from 'express'
import http from 'http'

/**
 * Function that returns the `<client-ip>` if provided in `'x-original-forwarded-for'`
 * header by `ingress-ngnix` in https://github.com/kubernetes/ingress-nginx/blob/f1f90ef4954effb122412d9cd2d48e02063038a4/rootfs/etc/nginx/template/nginx.tmpl#L1144
 * If the version of ngninx is changed,  we should check that this header is still set by the controller
 */
function parseForwardedFor(request: http.IncomingMessage | Request): string | null {
  const header = request.headers['x-original-forwarded-for'] || request.headers['x-forwarded-for']
  if (header != null && header.length > 0) {
    // The default implementation of Request.headers joins the values with ", "
    // https://nodejs.org/api/http.html#messageheaders
    const ipParts = Array.isArray(header) ? header : header.split(',').map(el => el.trim())

    if (ipParts.length > 0) {
      // Get the <client-ip>
      const index = ipParts.length >= 2 ? ipParts.length - 2 : 0
      return ipParts[index]
    }
  }

  return null
}

function isExpressRequest(request: http.IncomingMessage | Request): request is Request {
  return 'ip' in request && request.ip != null
}

export function getIp(request: http.IncomingMessage | Request): string {
  const ip = parseForwardedFor(request)

  if (ip) {
    return ip
  }

  if (isExpressRequest(request)) {
    return request.ip as string
  }

  return request.connection.remoteAddress || request.socket.remoteAddress || ''
}
