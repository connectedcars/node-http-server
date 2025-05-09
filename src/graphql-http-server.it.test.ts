import { JwtVerifyError } from '@connectedcars/jwtutils'
import axios from 'axios'
import { GraphQLFieldConfig, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql'
import * as graphqlHttp from 'graphql-http'

import {
  BaseGraphQLResponse,
  GraphQLErrorContext,
  GraphQLServer,
  GraphQLServerEvents,
  GraphQLServerOptions
} from './graphql-http-server'
import { Request, ServerError } from './http-server'

interface ExtendedRequest extends Request {
  user?: { id: number | null }
}

interface ExtendedGraphQLErrorContext extends GraphQLErrorContext {
  userId: number | null
}

class TestServer extends GraphQLServer<ExtendedRequest, BaseGraphQLResponse, ExtendedGraphQLErrorContext> {
  public constructor(options: GraphQLServerOptions) {
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
      if (req.headers.authorization === 'Bearer 123') {
        return
      } else if (query?.token === '123') {
        return
      } else if (Array.isArray(query?.token) && query?.token.includes('123')) {
        return
      }

      throw new ServerError('Unauthorized', 401)
    })

    this.use(this.graphQLMiddleware.bind(this))
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
  let graphQLHandler: GraphQLServerOptions['graphQLHandler']

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

  beforeAll(async () => {
    graphQLHandler = graphqlHttp.createHandler({ schema })
    server = new TestServer({ listenPort: 0, graphQLHandler })

    server.on('client-request-failed', eventArgs => {
      events.push({ type: 'client-request-failed', eventArgs })
    })

    server.on('graphql-error', eventArgs => {
      events.push({ type: 'graphql-error', eventArgs })
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
    const query = `query TestQuery {
  testQuery {
    id
  }
}`

    const data = {
      operationName: 'TestQuery',
      query,
      variables: {}
    }

    await expect(axios.post(`${server.listenUrl}/graphql`, data)).resolves.toMatchObject({
      status: 200,
      data: {
        data: {
          testQuery: {
            id: '1'
          }
        }
      }
    })

    expect(events).toMatchObject([])
  })

  it('handles file upload via multipart form-data', async () => {})

  it('handles file upload which is too small via multipart form-data', async () => {
    const query = `query TestQuery {
  testQuery {
    id
  }
}`

    const data = {
      operationName: 'TestQuery',
      query,
      variables: {}
    }

    const formData = new FormData()

    formData.append('operationName', data.operationName)
    formData.append('query', data.query)
    formData.append('variables', JSON.stringify(data.variables))
    formData.append('file', new Blob([Buffer.from('this is file contents')]), 'file.jpg')

    await expect(axios.post(`${server.listenUrl}/graphql`, formData)).rejects.toMatchObject({
      status: 400,
      response: {
        data: {
          errors: [
            {
              type: 'multipart-parse-error',
              message: 'Invalid multipart form'
            }
          ]
        }
      }
    })

    expect(events).toMatchObject([
      {
        eventArgs: {
          context: {
            ip: '::1',
            operationName: undefined,
            referrer: undefined,
            url: '/graphql',
            userAgent: 'axios/1.9.0',
            userId: null
          },
          // error: [expect.any(Error)],
          errorMessage: 'Failed to parse form data from request'
        },
        type: 'graphql-error'
      }
    ])
  })

  it('fails to handle files when the file goes before the fields', async () => {})

  it('fails getting graphql with an unknown query', async () => {
    const query = `query TestQuery {
  nopeQuery {
    id
  }
}`

    const data = {
      operationName: 'TestQuery',
      query,
      variables: {}
    }

    await expect(axios.post(`${server.listenUrl}/graphql`, data)).rejects.toMatchObject({
      status: 500, // TODO: Should this be 500?
      message: 'Request failed with status code 500',
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

    await expect(axios.post(`${server.listenUrl}/graphql`, data)).rejects.toMatchObject({
      status: 500, // TODO: Should this be 500?
      message: 'Request failed with status code 500',
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
        type: 'graphql-error',
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
        type: 'graphql-error',
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
          errorMessage: 'unhandled-error',
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
