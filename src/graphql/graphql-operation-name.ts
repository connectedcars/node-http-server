import * as httpServer from '../http-server'

export function tryGetOperationName(req: httpServer.Request): string | null | undefined {
  if (req.body?.operationName) {
    // From https://graphql.org/learn/serving-over-http/#post-request
    return req.body.operationName as string
  } else if (req.url) {
    // Fallback to checking url
    const operationName = req.url.match(/\/graphql\?operationName=([a-zA-Z-_]+)/)

    if (operationName) {
      return operationName[1]
    }
  }

  return undefined
}
