import { JwtVerifyError } from '@connectedcars/jwtutils'
import http from 'http'

import type { HttpServerEvents, ServerOptions } from './http-server'
import { ErrorHandler, Server, ServerError } from './http-server'

export interface GraphQLErrorContext {
  ip?: string | string[]
  referrer?: string | string[]
  operationName?: string | null
  userAgent?: string | string[]
  cloudTrace?: string | string[]
  url?: string
}

interface GraphQLServerEvents extends HttpServerEvents {
  'graphql-error': [{ errorMessage: string; context: GraphQLErrorContext }]
}

export class GraphQLServer<
  Context extends GraphQLErrorContext = GraphQLErrorContext
> extends Server<GraphQLServerEvents> {
  // Regex that matches /graphql and /graphql/
  // /graphql/ is supported for backwards compatibility and using a redirect with 308 causes issues with some clients
  public static readonly GRAPHQL_ENDPOINT_REGEX = /^\/graphql\/?$/

  public constructor(options: ServerOptions) {
    super(options)
  }

  protected getErrorContext(req: Request): Context {
    const ip = getIp(req)
    const referrer = req.headers['referer']
    const userAgent = req.headers['user-agent']
    const traceInfo = parseTraceInfoFromHeaders(req)
    const url = req.url

    return {
      ip,
      referrer,
      os,
      operationName: tryGetOperationName(req),
      userAgent,
      url,
      ...traceInfo
    }
  }

  protected handleJwtVerifyError(
    error: JwtVerifyError,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): ReturnType<ErrorHandler> {
    let errorMessage = ''

    if (error.innerError) {
      errorMessage = `Failed with: ${error.innerError.message}`
    } else {
      errorMessage = `Failed with: ${error.message}`
    }

    // Try to emulate the error structure of formatTypeError
    const errors = { errors: [{ type: 'auth-error', message: errorMessage }] }

    this.emit('graphql-error', { errorMessage, context: this.getErrorContext(req) })

    return { statusCode: 401, result: errors }
  }

  protected handleUnhandledGraphQLError(
    error: JwtVerifyError,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): ReturnType<ErrorHandler> {
    this.emit('graphql-error', this.getErrorContext(req))

    return {
      statusCode: 500,
      result: {
        errors: [{ type: 'unknown-type', message: 'Something went wrong' }]
      }
    }
  }

  protected graphQLErrorHandler(
    error: Error,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): ReturnType<ErrorHandler> {
    // Check for auth error
    if (error instanceof JwtVerifyError) {
      this.handleJwtVerifyError(error, req, res)
    } else if (error instanceof ServerError) {
      return super.errorHandler(error, req, res)
    }

    return this.handleUnhandledGraphQLError(error, req, res)
  }
}
