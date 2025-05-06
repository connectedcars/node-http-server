import log from '@connectedcars/logutil'
import { GraphQLError } from 'graphql'

export class GraphQLTypeError<ErrorType> extends GraphQLError {
  public type: ErrorType
  public context: Record<string, unknown>
  public isGraphQLTypeError: boolean

  public constructor(type: ErrorType, context: Record<string, unknown> = {}, message: string | undefined = undefined) {
    if (ErrorTypes[type]) {
      if (!message) {
        message = ErrorTypes[type]
      }
    } else {
      log.warn(`Unknown error type "${type}"`)
    }

    super(message)
    this.type = type
    this.context = context
    this.isGraphQLTypeError = true
  }

  public toString(): string {
    return `GraphQLTypeError: ${this.message} (${this.type})`
  }
}
