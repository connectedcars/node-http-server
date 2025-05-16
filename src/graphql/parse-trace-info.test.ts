import * as httpServer from '../http-server'
import { parseTraceInfoFromHeaders } from './parse-trace-info'

describe('parse-trace-info', () => {
  it('parses trace info', () => {
    expect(
      parseTraceInfoFromHeaders({
        headers: { 'x-cloud-trace-context': 'TRACE_ID/SPAN_ID;o=OPTIONS' }
      } as unknown as httpServer.Request)
    ).toEqual({
      trace: 'TRACE_ID',
      spanId: 'SPAN_ID',
      traceSampled: false
    })
  })

  it('parses trace info with sampled trace', () => {
    expect(
      parseTraceInfoFromHeaders({
        headers: { 'x-cloud-trace-context': 'TRACE_ID/SPAN_ID;o=1' }
      } as unknown as httpServer.Request)
    ).toEqual({
      trace: 'TRACE_ID',
      spanId: 'SPAN_ID',
      traceSampled: true
    })
  })

  it('returns an empty result if no header', async () => {
    expect(parseTraceInfoFromHeaders({ headers: {} } as unknown as httpServer.Request)).toEqual({})
  })

  it('returns an empty result if header is an array', async () => {
    expect(
      parseTraceInfoFromHeaders({ headers: { 'x-cloud-trace-context': [] } } as unknown as httpServer.Request)
    ).toEqual({})
  })
})
