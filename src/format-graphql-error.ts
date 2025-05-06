import { GraphQLError } from 'graphql'

export function isGraphQLError(err: Error | GraphQLError): err is GraphQLError {
  return err instanceof GraphQLError
}

export function isClientsideError(err: Error): boolean {
  if (isGraphQLError(err)) {
    if (err.extensions.errorKind === 'GraphQLError' && err.extensions.originalError == null) {
      return true
    }

    if (err.originalError === undefined) {
      // Syntax error in query
      return true
    }
  }

  return false
}
