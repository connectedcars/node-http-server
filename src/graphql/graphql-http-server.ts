import { utils } from '@connectedcars/backend'
import { JwtVerifyError } from '@connectedcars/jwtutils'
import { GraphQLFormattedError } from 'graphql'
import * as graphqlHttp from 'graphql-http'

import * as httpServer from '../http-server'
import { isClientsideError } from './format-graphql-error'

export interface GraphQLServerOptions<Request> extends httpServer.ServerOptions {
  graphQLHandler: graphqlHttp.Handler<Request>
}

export interface GraphQLErrorContext {
  ip?: string | string[]
  referrer?: string | string[]
  operationName?: string | null
  userAgent?: string | string[]
  cloudTrace?: string | string[]
  url?: string
}

export interface GraphQLServerEventValue<ErrorContext> {
  errorMessage: string
  context: ErrorContext
  error?: Error
}

export interface GraphQLServerEvents<ErrorContext> extends httpServer.HttpServerEvents {
  'graphql-error': GraphQLServerEventValue<ErrorContext>[]
  'graphql-jwt-error': GraphQLServerEventValue<ErrorContext>[]
}

interface CloudTraceInfo {
  trace?: string
  spanId?: string
  traceSampled?: boolean
}

function tryGetOperationName(req: httpServer.Request): string | null | undefined {
  if (req.body && req.body.operationName) {
    // From https://graphql.org/learn/serving-over-http/#post-request
    return req.body.operationName as string
  } else if (req.url) {
    // Fallback to checking url
    const opName = req.url.match(/\/graphql\?operationName=(\d+)/)
    if (opName) {
      return opName[0]
    }
  }
  return undefined
}

function parseTraceInfoFromHeaders(req: httpServer.Request): CloudTraceInfo {
  // https://cloud.google.com/trace/docs/trace-context#legacy-http-header
  // X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=OPTIONS
  // Example: X-Cloud-Trace-Context: 105445aa7843/505445aa7843;o=1
  // Another example: X-Cloud-Trace-Context: 105445aa7843/505445aa7843 // no options
  const cloudTrace = req.headers['x-cloud-trace-context']

  // According to node.js docs (https://nodejs.org/api/http.html#http_message_headers)
  // 'x-cloud-trace-context' cannot be an array of values.
  // set-cookie is always an array. Duplicates are added to the array.
  // For duplicate cookie headers, the values are joined together with ; .
  // For all other headers, the values are joined together with ,
  if (!cloudTrace || Array.isArray(cloudTrace)) {
    return {}
  }

  const [traceAndSpan, options] = cloudTrace.split(';')
  const [trace, spanId] = traceAndSpan.split('/')
  const traceSampled = options ? options === 'o=1' : false

  // https://cloud.google.com/logging/docs/structured-logging#special-payload-fields
  return { trace, spanId, traceSampled }
}

/**
 * A GraphQL http server implementation
 *
 * @template [GraphQLRequest=httpServer.Request]   The type of the GraphQL request passed through the later middleware and handlers
 * @template [GraphQLResponse=httpServer.Response] The type of GraphQL responses
 * @template [ErrorContext=GraphQLErrorContext]    A possibly extended error context to return from getErrorContext
 *
 * @emits GraphQLServer#graphql-error
 */
export abstract class GraphQLServer<
  GraphQLRequest extends httpServer.Request = httpServer.Request,
  GraphQLResponse extends httpServer.Response = httpServer.Response,
  ErrorContext extends GraphQLErrorContext = GraphQLErrorContext
> extends httpServer.Server<GraphQLServerEvents<ErrorContext>, GraphQLRequest, GraphQLResponse> {
  // Regex that matches /graphql and /graphql/
  // /graphql/ is supported for backwards compatibility and using a redirect with 308 causes issues with some clients
  public static readonly GRAPHQL_ENDPOINT_REGEX = /^\/graphql\/?$/

  private static readonly DEFAULT_MAX_BODY_SIZE = 750 * 1024

  private graphQLHandler: GraphQLServerOptions<GraphQLRequest>['graphQLHandler']
  private maxBodySize: number

  public constructor(options: GraphQLServerOptions<GraphQLRequest>) {
    super(options)

    this.graphQLHandler = options.graphQLHandler
    this.maxBodySize = options.maxBodySize ?? GraphQLServer.DEFAULT_MAX_BODY_SIZE
  }

  /**
   * GraphQL handler for post requests
   *
   * @emits GraphQLServer#graphql-error
   */
  public async graphQLPostHandler(req: httpServer.Request, res: httpServer.Response): httpServer.RequestHandlerResult {
    // Body could have been parsed by the upload handler if it was used (when Content-type is multipart/form-data)
    if (!req.body) {
      // Parse body if it is not already parsed
      const body = await httpServer.parseBodyFromRequest(req, this.maxBodySize)
      Object.assign(req, {}, { body })
    }

    // The spread syntax only copies enumerable properties and req.headers is
    // not an enumerable property
    const graphQLRequest = Object.assign(req, {
      method: req.method as string,
      url: req.url as string,
      body: req.body as Record<string, unknown>, // TODO: Make a type for this, we know what it is at this point
      raw: req,
      context: null
    }) as unknown as graphqlHttp.Request<GraphQLRequest, null>

    const [bodyInfo, init] = await this.graphQLHandler(graphQLRequest)
    const body = JSON.parse(bodyInfo as string)

    // Define out of GraphQL spec errors and status codes
    if (body?.errors) {
      return { statusCode: this.statusCodeForErrors(body.errors, req, res), result: body }
    }

    return { statusCode: init.status, result: body }
  }

  protected getBaseErrorContext(req: httpServer.Request): ErrorContext {
    const traceInfo = parseTraceInfoFromHeaders(req)

    const context = {
      ip: utils.getIp(req),
      referrer: req.headers['referer'],
      operationName: tryGetOperationName(req),
      userAgent: req.headers['user-agent'],
      url: req.url,
      ...traceInfo
    } as ErrorContext

    return context
  }

  protected graphQLErrorHandler(
    error: Error,
    req: GraphQLRequest,
    res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    if (error instanceof JwtVerifyError) {
      return this.handleJwtVerifyError(error, req, res)
    } else if (error instanceof httpServer.ServerError) {
      return super.errorHandler(error, req, res)
    }

    return this.handleUnhandledGraphQLError(error, req, res)
  }

  protected errorHandler(
    error: Error,
    req: GraphQLRequest,
    res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    return this.graphQLErrorHandler(error, req, res)
  }

  protected handleStatusCode(error: GraphQLFormattedError, _req: httpServer.Request, res: httpServer.Response): number {
    if (isClientsideError(error)) {
      return 400
    }

    return res.statusCode
  }

  private handleJwtVerifyError(
    error: JwtVerifyError,
    req: GraphQLRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    let errorMessage = ''

    if (error.innerError) {
      errorMessage = `Failed with: ${error.innerError.message}`
    } else {
      errorMessage = `Failed with: ${error.message}`
    }

    this.emit('graphql-jwt-error', { errorMessage, context: this.getErrorContext(req), error })

    // Try to emulate the error structure of formatTypeError
    return {
      statusCode: 401,
      result: {
        errors: [{ type: 'auth-error', message: errorMessage }]
      }
    }
  }

  private handleUnhandledGraphQLError(
    error: Error,
    req: GraphQLRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    this.emit('graphql-error', { errorMessage: 'unhandled-error', context: this.getErrorContext(req), error })

    return {
      statusCode: 500,
      result: {
        errors: [{ type: 'unknown-type', message: 'Something went wrong' }]
      }
    }
  }

  private statusCodeForErrors(
    errors: GraphQLFormattedError[],
    req: httpServer.Request,
    res: httpServer.Response
  ): number {
    let responseStatusCode = 500
    const statusCodes = []

    for (const err of errors) {
      const errorStatusCode = this.handleStatusCode(err, req, res)
      statusCodes.push(errorStatusCode)

      if (errorStatusCode >= 400) {
        responseStatusCode = errorStatusCode
      }
    }

    // Check if any error is 401 or 403 and return that
    for (const statusCode of statusCodes) {
      if ([401, 403].includes(statusCode)) {
        return statusCode
      }
    }

    return responseStatusCode
  }

  protected abstract getErrorContext(req: GraphQLRequest): ErrorContext
}
