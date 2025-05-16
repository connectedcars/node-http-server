import { GraphQLError, GraphQLFormattedError } from 'graphql'

export function isGraphQLFormattedError(error: Error | GraphQLFormattedError): error is GraphQLFormattedError {
  return error != null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
}

export function isGraphQLError(err: Error | GraphQLError | GraphQLFormattedError): err is GraphQLError {
  return err instanceof GraphQLError
}

export function isClientsideError(error: Error | GraphQLError | GraphQLFormattedError): boolean {
  if (isGraphQLError(error)) {
    if (error.extensions.errorKind === 'GraphQLError' && error.extensions.originalError == null) {
      return true
    }

    if (error.originalError === undefined) {
      // Syntax error in query
      return true
    }
  } else if (isGraphQLFormattedError(error)) {
    return true
  }

  return false
}

export function formatGenericError(err: Error | GraphQLError): GraphQLFormattedError {
  const isAGraphQLError = isGraphQLError(err)

  const error: GraphQLFormattedError = {
    //type: 'server-error',
    message: 'Something went wrong.',
    locations: isAGraphQLError ? err.locations : undefined,
    path: isAGraphQLError ? err.path : undefined,
    extensions: {
      errorKind: isGraphQLError(err) ? 'GraphQLError' : 'Error'
    }
  }

  return error
}
