import * as httpServer from '../http-server'

interface CloudTraceInfo {
  trace?: string
  spanId?: string
  traceSampled?: boolean
}

export function parseTraceInfoFromHeaders(req: httpServer.Request): CloudTraceInfo {
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
