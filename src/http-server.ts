import log from '@connectedcars/logutil'
import http from 'http'
import net from 'net'
import { URL } from 'url'
import EventEmitter from 'node:events'

const DEFAULT_MAX_BODY_IN_BYTES = 100 * 1024

export interface Request extends http.IncomingMessage {
  body?: Record<string, unknown>
}

export type Response = http.ServerResponse

export interface ServerResult {
  statusCode?: number
  result: unknown
  contentType?: 'application/json' | 'text/plain' | 'text/html'
}

export type Query = Record<string, string | string[] | undefined>

export interface RequestHandler<Req = Request, Res = Response> {
  (req: Req, res: Res, pathname?: string, query?: Query): Promise<ServerResult | undefined | void>
}

export interface ErrorHandler {
  (
    error: Error,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Omit<ServerResult, 'statusCode'> & {
    statusCode: number
  }
}

export interface ErrorResponse {
  error: string
  message: string
}

export interface ServerOptions {
  baseUrl?: string
  keepAliveTimeout?: number
  listenPort: number
  maxBodySize?: number
}

export class ServerError extends Error {
  public status?: number
  public constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export abstract class Server extends EventEmitter {
  public listenUrl = ''
  private listenPort: number
  private baseUrl: string
  private server: http.Server
  private handlerStack: {
    handler: RequestHandler
    url?: string | RegExp
    method?: string
  }[] = []

  public constructor(options: ServerOptions) {
    super()
    this.listenPort = options.listenPort
    this.baseUrl = options.baseUrl || 'http://localhost'
    const serverOptions = {}
    if (options.keepAliveTimeout != null) {
      // https://nodejs.org/api/http.html#serverkeepalivetimeout
      Object.assign(serverOptions, { keepAliveTimeout: options.keepAliveTimeout })
    }
    this.server = http.createServer(serverOptions, async (req, res) => {
      if (req.method && req.url) {
        let parsedUrl: URL
        try {
          parsedUrl = new URL(req.url, this.baseUrl)
        } catch (error) {
          this.emit('invalid-url', { url: req.url, error })
          // Response with 404 if URL is invalid
          const errorResponse: ErrorResponse = { error: 'not_found', message: 'Path not found' }
          return this.respond(res, 404, errorResponse)
        }
        const { pathname, searchParams } = parsedUrl
        const query: Record<string, string | string[] | undefined> = {}
        for (const [key, value] of searchParams.entries()) {
          // If the key already exists, make it an array
          const queryValue = query[key]
          if (queryValue) {
            if (Array.isArray(queryValue)) {
              queryValue.push(value)
            } else {
              query[key] = [queryValue as string, value]
            }
          } else {
            query[key] = value
          }
        }

        for (const handlerInfo of this.handlerStack) {
          if (this.matchHandler(req, pathname, handlerInfo)) {
            const { handler } = handlerInfo
            try {
              const handlerResult = await handler(req, res, pathname, query)
              // If result is undefined, continue to next handler
              if (handlerResult) {
                return this.respond(
                  res,
                  handlerResult.statusCode || 200,
                  handlerResult.result,
                  handlerResult.contentType
                )
              }
            } catch (e) {
              const errorHandler = this.resolveErrorHandler()
              const errorInfo = errorHandler(e, req, res)
              this.emit('client-request-failed', { status: errorInfo.statusCode, errorResponse: errorInfo.result, stack: e.stack })
              return this.respond(res, errorInfo.statusCode, errorInfo.result, errorInfo.contentType)
            }
          }
        }
      }
      const errorResponse: ErrorResponse = { error: 'not_found', message: 'Path not found' }
      this.respond(res, 404, errorResponse)
    })
  }

  public async start(): Promise<void> {
    this.server.on('listening', () => {
      const addressInfo = this.server.address() as net.AddressInfo
      this.listenPort = addressInfo.port
      this.listenUrl = `${this.baseUrl}:${this.listenPort}`
    })
    return new Promise(resolve => {
      this.server.listen(this.listenPort, resolve)
    })
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  public getListenPort(): number {
    return this.listenPort
  }

  protected get(pathname: string | RegExp, handler: RequestHandler): void {
    this.registerRequestHandler('GET', pathname, handler)
  }

  protected post(pathname: string | RegExp, handler: RequestHandler): void {
    this.registerRequestHandler('POST', pathname, handler)
  }

  protected patch(pathname: string | RegExp, handler: RequestHandler): void {
    this.registerRequestHandler('PATCH', pathname, handler)
  }

  protected put(pathname: string | RegExp, handler: RequestHandler): void {
    this.registerRequestHandler('PUT', pathname, handler)
  }

  protected delete(pathname: string | RegExp, handler: RequestHandler): void {
    this.registerRequestHandler('DELETE', pathname, handler)
  }

  protected use(urlOrHandler: string | RegExp, middleware: RequestHandler): void
  protected use(urlOrHandler: RequestHandler): void
  protected use(urlOrHandler?: string | RegExp | RequestHandler, middleware?: RequestHandler): void {
    if (typeof urlOrHandler === 'function') {
      this.addHandler(urlOrHandler)
    } else {
      if (!middleware) {
        throw new Error('Middleware must be defined')
      }
      this.addHandler(middleware, urlOrHandler)
    }
  }

  protected redirect(from: string, to: string, statusCode = 301): void {
    if (from === to) {
      throw new Error('Redirect from and to cannot be the same')
    }
    // Only support GET redirects for now
    this.get(from, async (_, res) => {
      res.setHeader('Location', to)
      return { statusCode, result: 'OK' }
    })
  }

  protected errorHandler(error: Error): ReturnType<ErrorHandler> {
    let status = 500
    const errorResponse: ErrorResponse = { error: 'server_error', message: 'Something went wrong' }
    if (error instanceof ServerError) {
      if (error.status) {
        status = error.status
      }
      errorResponse.message = error.message
    }
        
    return { statusCode: status, result: errorResponse }
  }

  private addHandler(handler: RequestHandler, url?: string | RegExp, method?: string): void {
    this.handlerStack.push({ handler, url, method })
  }

  private registerRequestHandler(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string | RegExp,
    handler: RequestHandler
  ): void {
    this.addHandler(handler, url, method)
  }

  private matchHandler(
    req: Request,
    pathname: string,
    handler: {
      handler: RequestHandler
      url?: string | RegExp
      method?: string
    }
  ): boolean {
    // Middleware matching all routes
    if (handler.url === undefined) {
      return true
    }

    // Method can be undefined for middlewares
    if (handler.method && req.method !== handler.method) {
      return false
    }

    if (handler.url instanceof RegExp && handler.url.test(pathname)) {
      return true
    }

    return typeof handler.url === 'string' && pathname === handler.url
  }

  private resolveErrorHandler(): ErrorHandler {
    return this.errorHandler
  }

  private respond(res: Response, statusCode: number, result: unknown, contentType?: ServerResult['contentType']): void {
    res.statusCode = statusCode

    if (contentType) {
      res.setHeader('Content-Type', contentType)
      if (contentType === 'application/json') {
        res.end(typeof result === 'string' ? result : JSON.stringify(result))
      } else {
        res.end(result)
      }
    } else if (typeof result === 'string') {
      res.setHeader('Content-Type', 'text/plain')
      res.end(result)
    } else {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    }
  }
}

function contentTypeDoesNotMatchBody(contentType: string, kind: 'JSON' | 'string' | 'buffer'): boolean {
  // https://www.rfc-editor.org/rfc/rfc9110#field.content-type
  const contentTypeParts = contentType.split(';')
  const contentTypeTrimmed = contentTypeParts[0].trim().toLowerCase()

  if (kind === 'JSON' && contentTypeTrimmed !== 'application/json') {
    return true
  }
  if (kind === 'string' && contentTypeTrimmed !== 'text/plain') {
    return true
  }
  if (kind === 'buffer' && contentTypeTrimmed !== 'application/octet-stream') {
    return true
  }
  return false
}

export async function parseBodyFromRequest(
  req: http.IncomingMessage,
  maxBodySize = DEFAULT_MAX_BODY_IN_BYTES,
  options: { kind: 'JSON' | 'string' | 'buffer' } = { kind: 'JSON' }
): Promise<Record<string, unknown> | string | Buffer> {
  // Check if body was already parsed or if request is readable
  if (!req.readable) {
    throw new ServerError('Request body was already parsed or request is not readable', 400)
  }

  // Check Content-Type
  const contentType = req.headers['content-type']
  if (contentType === 'multipart/form-data') {
    throw new ServerError('multipart/form-data is not supported', 415)
  }

  if (contentType && contentTypeDoesNotMatchBody(contentType, options.kind)) {
    log.warn('Content-Type mismatch with expected body type', { contentType, kind: options.kind })
  }

  return new Promise<Record<string, unknown> | string | Buffer>((resolve, reject) => {
    const body: Buffer[] = []
    let bodySize = 0
    req.on('data', chunk => {
      body.push(chunk)
      bodySize += chunk.length
      if (bodySize > maxBodySize) {
        req.destroy()
        reject(new ServerError('Request Entity Too Large', 413))
      }
    })
    req.on('error', error => {
      req.destroy()
      reject(error)
    })
    req.on('end', () => {
      try {
        // Handle different body types and default to JSON
        if (options.kind === 'string') {
          resolve(Buffer.concat(body).toString('utf8'))
        } else if (options.kind === 'buffer') {
          resolve(Buffer.concat(body))
        }
        resolve(body.length === 0 ? {} : JSON.parse(Buffer.concat(body).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
  })
}


