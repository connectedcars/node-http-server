import { HttpServer, HttpServerOptions } from '@connectedcars/test'
import axios from 'axios'

import { getIp } from './get-ip'

class TestHttpServer extends HttpServer {
  public constructor(options: HttpServerOptions = {}) {
    super(options, async (req, res) => {
      res.end(getIp(req))
    })
  }
}

describe('get-ip', () => {
  const EXPECTED_IP = '146.148.21.22'
  const THREE_IP_STRING = '123.123.123.123, 146.148.21.22, 35.190.71.56'
  const TWO_IP_STRING = '146.148.21.22, 35.190.71.56'
  const THREE_IP_ARRAY = ['123.123.123.123', '146.148.21.22', '35.190.71.56']
  const TWO_IP_ARRAY = ['146.148.21.22', '35.190.71.56']

  const EXPECTED_IPv6 = '2001:0db8:ac10:fe03:0000:0000:0000:1000'
  const THREE_IPv6_STRING =
    '3001:0da8:75a3:0000:0000:8a2e:0370:7334, 2001:0db8:ac10:fe03:0000:0000:0000:1000, ::ffff:ac10:fe03:0000:0000:0000:1000'
  const TWO_IPv6_STRING = ' 2001:0db8:ac10:fe03:0000:0000:0000:1000, ::ffff:ac10:fe03:0000:0000:0000:1000'
  const THREE_IPv6_ARRAY = [
    '3001:0da8:75a3:0000:0000:8a2e:0370:7334',
    '2001:0db8:ac10:fe03:0000:0000:0000:1000',
    '::ffff:ac10:fe03:0000:0000:0000:1000'
  ]
  const TWO_IPv6_ARRAY = ['2001:0db8:ac10:fe03:0000:0000:0000:1000', '::ffff:ac10:fe03:0000:0000:0000:1000']

  const httpServer = new TestHttpServer()

  beforeAll(async () => {
    await httpServer.start()
  })

  afterAll(async () => {
    await httpServer.stop()
  })

  it.each([THREE_IP_STRING, TWO_IP_STRING, THREE_IP_ARRAY, TWO_IP_ARRAY])(
    'gets IP from `x-original-forwarded-for` %s',
    async (header): Promise<void> => {
      const result = await axios.get(httpServer.listenUrl, {
        headers: { 'x-original-forwarded-for': header }
      })
      expect(result.data.toString()).toEqual(EXPECTED_IP)
    }
  )

  it.each([THREE_IPv6_STRING, TWO_IPv6_STRING, THREE_IPv6_ARRAY, TWO_IPv6_ARRAY])(
    'gets IP from `x-original-forwarded-for` %s',
    async (header): Promise<void> => {
      const result = await axios.get(httpServer.listenUrl, {
        headers: { 'x-original-forwarded-for': header }
      })
      expect(result.data.toString()).toEqual(EXPECTED_IPv6)
    }
  )

  it.each([THREE_IP_STRING, TWO_IP_STRING, THREE_IP_ARRAY, TWO_IP_ARRAY])(
    'gets IP from `x-forwarded-for` %s',
    async (header): Promise<void> => {
      const result = await axios.get(httpServer.listenUrl, {
        headers: { 'x-original-forwarded-for': '', 'x-forwarded-for': header }
      })
      expect(result.data.toString()).toEqual(EXPECTED_IP)
    }
  )

  it.each([THREE_IPv6_STRING, TWO_IPv6_STRING, THREE_IPv6_ARRAY, TWO_IPv6_ARRAY])(
    'gets IP from `x-forwarded-for` %s',
    async (header): Promise<void> => {
      const result = await axios.get(httpServer.listenUrl, {
        headers: { 'x-original-forwarded-for': '', 'x-forwarded-for': header }
      })
      expect(result.data.toString()).toEqual(EXPECTED_IPv6)
    }
  )

  it('fallback to remoteAddress', async () => {
    const result = await axios.get(httpServer.listenUrl, {
      headers: { 'x-original-forwarded-for': '', 'x-forwarded-for': '' }
    })
    // Local IP can be either `::ffff:127.0.0.1` or `::1`
    expect(result.data.toString()).toMatch(/^(::ffff:127\.0\.0\.1)|(::1)$/)
  })
})
