import { JwtVerifyError } from '@connectedcars/jwtutils'
import { GraphQLFormattedError } from 'graphql'
import * as graphqlHttp from 'graphql-http'

import * as httpServer from '../http-server'
import { isClientsideError } from './format-graphql-error'
import { getIp } from './get-ip'
import { tryGetOperationName } from './graphql-operation-name'
import { parseTraceInfoFromHeaders } from './parse-trace-info'

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

/**
 * A GraphQL http server implementation
 *
 * @template [GraphQLRequest=httpServer.Request]   The type of the GraphQL request passed through the later middleware and handlers
 * @template [GraphQLResponse=httpServer.Response] The type of GraphQL responses
 * @template [ErrorContext=GraphQLErrorContext]    A possibly extended error context to return from getErrorContext
 *
 * @emits GraphQLServer#graphql-error
 * @emits GraphQLServer#graphql-jwt-error
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
   * GraphQL post request handler
   */
  public async graphQLPostHandler(req: GraphQLRequest, res: GraphQLResponse): httpServer.RequestHandlerResult {
    // Body could already have been parsed by middleware
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
      body: req.body as Record<string, unknown>,
      raw: req,
      context: null
    }) as unknown as graphqlHttp.Request<GraphQLRequest, null>

    const [bodyInfo, init] = await this.graphQLHandler(graphQLRequest)
    const body = JSON.parse(bodyInfo as string)

    if (body?.errors) {
      return { statusCode: this.statusCodeForErrors(body.errors, req, res), result: body }
    }

    return { statusCode: init.status, result: body }
  }

  /**
   * Get the base error context information to be extended by implementing classes
   */
  protected getBaseErrorContext(req: GraphQLRequest): ErrorContext {
    return {
      ip: getIp(req),
      referrer: req.headers['referer'],
      operationName: tryGetOperationName(req),
      userAgent: req.headers['user-agent'],
      url: req.url,
      ...parseTraceInfoFromHeaders(req)
    } as ErrorContext
  }

  protected handleStatusCode(error: GraphQLFormattedError, _req: GraphQLRequest, res: GraphQLResponse): number {
    if (isClientsideError(error)) {
      return 400
    }

    return res.statusCode
  }

  /**
   * Handle errors. To be extended by implementing classes
   */
  protected errorHandler(
    error: Error,
    req: GraphQLRequest,
    res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    return this.graphQLErrorHandler(error, req, res)
  }

  protected graphQLErrorHandler(
    error: Error,
    req: GraphQLRequest,
    res: httpServer.Response
  ): ReturnType<httpServer.ErrorHandler> {
    if (error instanceof JwtVerifyError) {
      return this.handleJwtVerifyError(error, req)
    } else if (error instanceof httpServer.ServerError) {
      return super.errorHandler(error, req, res)
    }

    return this.handleUnhandledGraphQLError(error, req)
  }

  private handleJwtVerifyError(error: JwtVerifyError, req: GraphQLRequest): ReturnType<httpServer.ErrorHandler> {
    let errorMessage = ''

    if (error.innerError) {
      errorMessage = `Failed with: ${error.innerError.message}`
    } else {
      errorMessage = `Failed with: ${error.message}`
    }

    this.emit('graphql-jwt-error', { errorMessage, context: this.getErrorContext(req), error })

    return {
      statusCode: 401,
      result: {
        errors: [{ type: 'auth-error', message: errorMessage }]
      }
    }
  }

  private handleUnhandledGraphQLError(error: Error, req: GraphQLRequest): ReturnType<httpServer.ErrorHandler> {
    this.emit('graphql-error', { errorMessage: 'Unhandled error', context: this.getErrorContext(req), error })

    return {
      statusCode: 500,
      result: {
        errors: [{ type: 'unknown-type', message: 'Something went wrong' }]
      }
    }
  }

  private statusCodeForErrors(errors: GraphQLFormattedError[], req: GraphQLRequest, res: GraphQLResponse): number {
    let responseStatusCode = 500
    const statusCodes = []

    for (const error of errors) {
      const errorStatusCode = this.handleStatusCode(error, req, res)
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

  /**
   * Abstract method for getting the error context. To be extended by implementing classes
   */
  protected abstract getErrorContext(req: GraphQLRequest): ErrorContext
}
