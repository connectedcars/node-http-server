import axios from 'axios'

import {
  parseBodyFromRequest,
  Query,
  Request,
  Response,
  Server,
  ServerError,
  ServerOptions,
  ServerResult
} from './http-server'

async function testGetHandler(_req: Request, _res: Response, pathname?: string, query?: Query): Promise<ServerResult> {
  return {
    statusCode: 200,
    result: { pathname, query }
  }
}

async function testPostHandler(req: Request, _res: Response, pathname?: string, query?: Query): Promise<ServerResult> {
  return {
    statusCode: 200,
    result: { pathname, query, body: req.body }
  }
}

async function testGetHandlerHTML(): Promise<ServerResult> {
  return {
    statusCode: 200,
    result: '<html><body>Test</body></html>',
    contentType: 'text/html'
  } as const
}

class TestServer extends Server {
  public constructor(options: ServerOptions) {
    super(options)

    // Health checks
    this.get('/readiness', async () => {
      return { statusCode: 200, result: 'OK' }
    })
    this.get('/liveness', async () => {
      return { statusCode: 200, result: 'OK' }
    })
    this.get('/startup', async () => {
      return { statusCode: 200, result: 'OK' }
    })

    this.redirect('/graphiql', '/graphiql/')

    this.get('/graphiql/', testGetHandlerHTML)

    this.use('/graphql', async () => {
      return {
        statusCode: 200,
        result: 'Middleware response'
      }
    })

    // Register authorization middleware
    this.use(async (req, res, pathname, query) => {
      if (req.headers.authorization === 'Bearer 123') {
        return
      } else if (query?.token === '123') {
        return
      } else if (Array.isArray(query?.token) && query?.token.includes('123')) {
        return
      }
      throw new ServerError('Unauthorized', 401)
    })

    this.get('/new-vehicle-shard', testGetHandler)

    this.get(/\/new-vehicle-shard\/(?<shardId>\d+)/, testGetHandler)
    this.get(/\/new-vehicle-shard\/(?<shardId>\d+)\/(?<vehicleId>\d+)/, testGetHandler)

    this.post('/logs', async (req, res, pathname, query) => {
      const body = await parseBodyFromRequest(req, 200 * 1024)
      // Check that its not an empty object
      if (!Object.keys(body).length) {
        throw new ServerError('No body found in request', 400)
      }
      Object.assign(req, {}, { body })
      return testPostHandler(req, res, pathname, query)
    })
    this.post('/double-parse', async (req, res, pathname, query) => {
      await parseBodyFromRequest(req, 200 * 1024)
      await parseBodyFromRequest(req, 200 * 1024)
      return testPostHandler(req, res, pathname, query)
    })
  }
}

describe('TestServer', () => {
  let server: TestServer
  beforeAll(async () => {
    server = new TestServer({ listenPort: 0 })
    await server.start()
  })
  afterAll(async () => {
    await server.stop()
  })

  describe('Route registration', () => {
    it('GET /new-vehicle-shard', async () => {
      const response = await axios.get(`${server.listenUrl}/new-vehicle-shard?token=123`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        pathname: '/new-vehicle-shard',
        query: {
          token: '123'
        }
      })
    })

    it('GET /new-vehicle-shard handles query array', async () => {
      const response = await axios.get(`${server.listenUrl}/new-vehicle-shard?token=456&token=123`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        pathname: '/new-vehicle-shard',
        query: {
          token: ['456', '123']
        }
      })
    })

    it('GET /new-vehicle-shard/:shardId', async () => {
      const response = await axios.get(`${server.listenUrl}/new-vehicle-shard/123?token=123`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        pathname: '/new-vehicle-shard/123',
        query: {
          token: '123'
        }
      })
    })

    it('GET /new-vehicle-shard/:shardId/:vehicleId', async () => {
      const response = await axios.get(`${server.listenUrl}/new-vehicle-shard/123/456?token=123`)
      expect(response.status).toEqual(200)
      expect(response.headers).toMatchObject({
        connection: 'keep-alive',
        'content-length': '65',
        'content-type': 'application/json',
        date: expect.any(String)
      })
      expect(response.data).toEqual({
        pathname: '/new-vehicle-shard/123/456',
        query: {
          token: '123'
        }
      })
    })

    it('POST /logs', async () => {
      const response = await axios.post(
        `${server.listenUrl}/logs`,
        {
          message: 'Test message'
        },
        { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 123' } }
      )
      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        pathname: '/logs',
        query: {},
        body: {
          message: 'Test message'
        }
      })
      expect(response.headers).toMatchObject({
        connection: 'keep-alive',
        'content-length': '65',
        'content-type': 'application/json',
        date: expect.any(String)
      })
    })

    it('GET /readiness', async () => {
      const response = await axios.get(`${server.listenUrl}/readiness`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual('OK')
    })

    it('GET /liveness', async () => {
      const response = await axios.get(`${server.listenUrl}/liveness`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual('OK')
    })

    it('GET /startup', async () => {
      const response = await axios.get(`${server.listenUrl}/startup`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual('OK')
    })

    it('GET /new-vehicle-shard with authorization header', async () => {
      const response = await axios.get(`${server.listenUrl}/new-vehicle-shard`, {
        headers: {
          Authorization: 'Bearer 123'
        }
      })
      expect(response.status).toEqual(200)
      expect(response.data).toEqual({
        pathname: '/new-vehicle-shard',
        query: {}
      })
    })

    it('GET graphiql html and redirects', async () => {
      const response = await axios.get(`${server.listenUrl}/graphiql`)
      expect(response.status).toEqual(200)
      expect(response.headers).toMatchObject({
        connection: 'keep-alive',
        'content-length': '30',
        'content-type': 'text/html',
        date: expect.any(String)
      })
      expect(response.data).toEqual('<html><body>Test</body></html>')
    })

    it('POST /logs with authorization header exceeds max body size', async () => {
      await expect(
        axios.post(
          `${server.listenUrl}/logs`,
          {
            message: Buffer.alloc(1024 * 1024 * 2).toString('base64')
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer 123'
            }
          }
        )
        // Either 'write EPIPE' or 'read ECONNRESET' or 'socket hang up' can be thrown
      ).rejects.toThrow(/EPIPE|ECONNRESET|socket hang up/)
    })

    it('POST /logs without body', async () => {
      await expect(
        axios.post(`${server.listenUrl}/logs`, undefined, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer 123'
          }
        })
      ).rejects.toThrow(/Request failed with status code 400/)
    })

    it('POST /double-parse fails', async () => {
      await expect(
        axios.post(
          `${server.listenUrl}/double-parse?token=123`,
          {
            message: 'Test message'
          },
          { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )
      ).rejects.toThrow(/Request failed with status code 400/)
    })

    it('/graphql middleware', async () => {
      const response = await axios.get(`${server.listenUrl}/graphql`)
      expect(response.status).toEqual(200)
      expect(response.data).toEqual('Middleware response')

      const responsePost = await axios.post(`${server.listenUrl}/graphql`)
      expect(responsePost.status).toEqual(200)
      expect(responsePost.data).toEqual('Middleware response')
    })

    it('POST /new-vehicle-shard/:shardId/:vehicleId fails 404', async () => {
      await expect(axios.post(`${server.listenUrl}/new-vehicle-shard/123/456?token=123`)).rejects.toThrow(
        'Request failed with status code 404'
      )
    })

    it('GET /logs fails 404', async () => {
      await expect(axios.get(`${server.listenUrl}/logs?token=123`)).rejects.toThrow(
        'Request failed with status code 404'
      )
    })

    it('POST /logs/ with trailing slash fails', async () => {
      await expect(
        axios.post(`${server.listenUrl}/logs/?token=123`, {
          message: 'Test message'
        })
      ).rejects.toThrow('Request failed with status code 404')
    })

    it('GET with escaped backslashes doesnt throw error', async () => {
      await expect(axios.get(`${server.listenUrl}///%5cexample.com`)).rejects.toThrow(
        'Request failed with status code 404'
      )
    })
  })
})
