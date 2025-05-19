import { JwtVerifyError } from '@connectedcars/jwtutils'
import axios, { type AxiosRequestConfig } from 'axios'
import { GraphQLFieldConfig, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql'
import * as graphqlHttp from 'graphql-http'

import { type Request, type Response, ServerError } from '../http-server'
import {
  type GraphQLErrorContext,
  GraphQLServer,
  type GraphQLServerEvents,
  type GraphQLServerOptions
} from './graphql-http-server'

interface ExtendedRequest extends Request {
  user?: { id: number | null }
}

interface ExtendedGraphQLErrorContext extends GraphQLErrorContext {
  userId: number | null
}

class TestServer extends GraphQLServer<ExtendedRequest, Response, ExtendedGraphQLErrorContext> {
  public constructor(options: GraphQLServerOptions<ExtendedRequest>) {
    super(options)

    this.get('/readiness', async () => {
      return { statusCode: 200, result: 'OK' }
    })

    this.get('/jwt-verify', async () => {
      throw new JwtVerifyError('Failed to verify', new Error('Oh noes'))
    })

    this.get('/jwt-verify-no-inner-error', async () => {
      throw new JwtVerifyError('Failed to verify again')
    })

    this.get('/server-error', async () => {
      throw new ServerError('Server error occurred', 403)
    })

    this.get('/unhandled-error', async () => {
      throw new Error('Unhandled error occurred')
    })

    // Register authorization middleware
    this.use(async (req, _res, _pathname, query) => {
      if (req.headers.authorization?.split('.').length !== 3) {
        throw new JwtVerifyError('Token does not contain three dots')
      } else if (req.headers.authorization === 'Bearer 1.2.3') {
        return
      } else if (query?.token === '1.2.3') {
        return
      } else if (Array.isArray(query?.token) && query?.token.includes('1.2.3')) {
        return
      }

      throw new ServerError('Unauthorized', 401)
    })

    this.post(GraphQLServer.GRAPHQL_ENDPOINT_REGEX, this.graphQLPostHandler.bind(this))
  }

  protected getErrorContext(req: ExtendedRequest): ExtendedGraphQLErrorContext {
    return {
      ...this.getBaseErrorContext(req),
      userId: req.user?.id ?? null
    }
  }
}

describe('graphql-http-server', () => {
  let server: TestServer
  let events: {
    type: string
    eventArgs: GraphQLServerEvents<GraphQLErrorContext>[keyof GraphQLServerEvents<GraphQLErrorContext>][number]
  }[] = []
  let graphQLHandler: GraphQLServerOptions<ExtendedRequest>['graphQLHandler']

  const TestQueryOutputType = new GraphQLObjectType({
    name: 'TestOutput',
    fields: () => ({
      id: {
        type: new GraphQLNonNull(GraphQLID)
      }
    })
  })

  const testQuery: GraphQLFieldConfig<Record<string, unknown>, null> = {
    description: 'hello',
    type: TestQueryOutputType,
    resolve: () => {
      return { id: 1 }
    }
  }

  const query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      testQuery
    }
  })

  const schema = new GraphQLSchema({ query })

  const validQueryString = `query TestQuery {
    testQuery {
      id
    }
  }`

  const validAuthHeaders: AxiosRequestConfig['headers'] = {
    Authorization: 'Bearer 1.2.3'
  }

  beforeAll(async () => {
    graphQLHandler = graphqlHttp.createHandler({
      schema,
      parseRequestParams: req => {
        const parsedBody = req.body as Record<string, unknown>

        return {
          query: parsedBody.query as string,
          variables: typeof parsedBody.variables === 'string' ? JSON.parse(parsedBody.variables) : parsedBody.variables,
          operationName: parsedBody.operationName as string
        }
      }
    })

    server = new TestServer({ listenPort: 0, graphQLHandler })

    server.on('client-request-failed', eventArgs => {
      events.push({ type: 'client-request-failed', eventArgs })
    })

    server.on('graphql-error', eventArgs => {
      events.push({ type: 'graphql-error', eventArgs })
    })

    server.on('graphql-jwt-error', eventArgs => {
      events.push({ type: 'graphql-jwt-error', eventArgs })
    })

    server.on('invalid-url', eventArgs => {
      events.push({ type: 'invalid-url', eventArgs })
    })

    await server.start()
  })

  beforeEach(() => {
    events = []
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('gets /readiness', async () => {
    const response = axios.get(`${server.listenUrl}/readiness`)

    await expect(response).resolves.toMatchObject({
      status: 200,
      data: 'OK'
    })

    expect(events).toMatchObject([])
  })

  it('posts to graphql endpoint', async () => {
    const data = {
      operationName: 'TestQuery',
      query: validQueryString,
      variables: {}
    }

    await expect(axios.post(`${server.listenUrl}/graphql`, data, { headers: validAuthHeaders })).resolves.toMatchObject(
      {
        status: 200,
        data: {
          data: {
            testQuery: {
              id: '1'
            }
          }
        }
      }
    )

    expect(events).toMatchObject([])
  })

  it('posts to graphql endpoint with invalid token', async () => {
    const data = {
      operationName: 'TestQuery',
      query: validQueryString,
      variables: {}
    }

    await expect(
      axios.post(`${server.listenUrl}/graphql`, data, { headers: { Authorization: 'Bearer 4.5.6' } })
    ).rejects.toMatchObject({
      status: 401,
      response: {
        data: {
          error: 'server_error',
          message: 'Unauthorized'
        }
      }
    })

    expect(events).toMatchObject([
      {
        eventArgs: {
          message: 'Unauthorized',
          response: {
            error: 'server_error',
            message: 'Unauthorized'
          },
          stack: expect.any(String),
          statusCode: 401
        },
        type: 'client-request-failed'
      }
    ])
  })

  it('posts to graphql endpoint with invalid token (missing dots)', async () => {
    const data = {
      operationName: 'TestQuery',
      query: validQueryString,
      variables: {}
    }

    await expect(
      axios.post(`${server.listenUrl}/graphql?operationName=TestQuery`, data, {
        headers: { Authorization: 'Bearer 1.23' }
      })
    ).rejects.toMatchObject({
      status: 401,
      response: {
        data: {
          errors: [
            {
              message: 'Failed with: Token does not contain three dots',
              type: 'auth-error'
            }
          ]
        }
      }
    })

    expect(events).toMatchObject([
      {
        type: 'graphql-jwt-error',
        eventArgs: {
          errorMessage: 'Failed with: Token does not contain three dots',
          context: {
            ip: '::1',
            referrer: undefined,
            operationName: 'TestQuery',
            userAgent: expect.stringMatching(/^axios\//),
            url: '/graphql?operationName=TestQuery'
          }
        }
      },
      {
        type: 'client-request-failed',
        eventArgs: {
          statusCode: 401,
          response: { errors: [{ type: 'auth-error', message: 'Failed with: Token does not contain three dots' }] },
          message: 'Token does not contain three dots',
          stack: expect.any(String)
        }
      }
    ])
  })

  it('fails getting graphql with an unknown query', async () => {
    const queryWithSyntaxError = `query TestQuery {
  nopeQuery {
    id
  }
}`

    const data = {
      operationName: 'TestQuery',
      query: queryWithSyntaxError,
      variables: {}
    }

    await expect(axios.post(`${server.listenUrl}/graphql`, data, { headers: validAuthHeaders })).rejects.toMatchObject({
      status: 400,
      message: 'Request failed with status code 400',
      response: {
        data: {
          errors: [
            {
              message: 'Cannot query field "nopeQuery" on type "Query". Did you mean "testQuery"?',
              locations: [{ line: 2, column: 3 }]
            }
          ]
        }
      }
    })

    expect(events).toMatchObject([])
  })

  it('handles syntax error in graphql query', async () => {
    const query = `query TestQuery {
  testQuery
    id
  }
}`

    const data = {
      operationName: 'TestQuery',
      query,
      variables: {}
    }

    await expect(axios.post(`${server.listenUrl}/graphql`, data, { headers: validAuthHeaders })).rejects.toMatchObject({
      status: 400,
      message: 'Request failed with status code 400',
      response: {
        data: {
          errors: [
            {
              message: 'Syntax Error: Unexpected "}".',
              locations: [{ line: 5, column: 1 }]
            }
          ]
        }
      }
    })

    expect(events).toMatchObject([])
  })

  it('handles jwt verification errors', async () => {
    const response = axios.get(`${server.listenUrl}/jwt-verify`)

    await expect(response).rejects.toMatchObject({
      message: 'Request failed with status code 401',
      response: {
        data: {
          errors: [{ type: 'auth-error', message: 'Failed with: Oh noes' }]
        }
      }
    })

    expect(events).toMatchObject([
      {
        type: 'graphql-jwt-error',
        eventArgs: {
          errorMessage: 'Failed with: Oh noes',
          context: {
            ip: '::1',
            referrer: undefined,
            operationName: undefined,
            userAgent: expect.stringMatching(/^axios\//),
            url: '/jwt-verify'
          }
        }
      },
      {
        type: 'client-request-failed',
        eventArgs: {
          statusCode: 401,
          response: { errors: [{ type: 'auth-error', message: 'Failed with: Oh noes' }] },
          message: 'Failed to verify',
          stack: expect.any(String)
        }
      }
    ])
  })

  it('handles jwt verification errors without inner errors', async () => {
    const response = axios.get(`${server.listenUrl}/jwt-verify-no-inner-error`)

    await expect(response).rejects.toMatchObject({
      message: 'Request failed with status code 401',
      response: {
        data: {
          errors: [{ type: 'auth-error', message: 'Failed with: Failed to verify again' }]
        }
      }
    })

    expect(events).toMatchObject([
      {
        type: 'graphql-jwt-error',
        eventArgs: {
          errorMessage: 'Failed with: Failed to verify again',
          context: {
            ip: '::1',
            referrer: undefined,
            operationName: undefined,
            userAgent: expect.stringMatching(/^axios\//),
            url: '/jwt-verify-no-inner-error'
          }
        }
      },
      {
        type: 'client-request-failed',
        eventArgs: {
          statusCode: 401,
          response: { errors: [{ type: 'auth-error', message: 'Failed with: Failed to verify again' }] },
          message: 'Failed to verify again',
          stack: expect.any(String)
        }
      }
    ])
  })

  it('delegates server errors to base class', async () => {
    const response = axios.get(`${server.listenUrl}/server-error`)

    await expect(response).rejects.toMatchObject({
      message: 'Request failed with status code 403',
      response: {
        data: {
          error: 'server_error',
          message: 'Server error occurred'
        }
      }
    })

    expect(events).toMatchObject([
      {
        type: 'client-request-failed',
        eventArgs: {
          statusCode: 403,
          response: {
            error: 'server_error',
            message: 'Server error occurred'
          },
          message: 'Server error occurred',
          stack: expect.any(String)
        }
      }
    ])
  })

  it('handles unhandled graphql errors', async () => {
    const response = axios.get(`${server.listenUrl}/unhandled-error`)

    await expect(response).rejects.toMatchObject({
      message: 'Request failed with status code 500',
      response: {
        data: {
          errors: [{ type: 'unknown-type', message: 'Something went wrong' }]
        }
      }
    })

    expect(events).toMatchObject([
      {
        type: 'graphql-error',
        eventArgs: {
          errorMessage: 'Unhandled error',
          context: {
            ip: '::1',
            referrer: undefined,
            operationName: undefined,
            userAgent: expect.stringMatching(/^axios\//),
            url: '/unhandled-error'
          }
        }
      },
      {
        type: 'client-request-failed',
        eventArgs: {
          statusCode: 500,
          response: {
            errors: [
              {
                type: 'unknown-type',
                message: 'Something went wrong'
              }
            ]
          },
          message: 'Unhandled error occurred',
          stack: expect.any(String)
        }
      }
    ])
  })
})
