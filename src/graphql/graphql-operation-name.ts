import * as httpServer from '../http-server'

export function tryGetOperationName(req: httpServer.Request): string | null | undefined {
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
