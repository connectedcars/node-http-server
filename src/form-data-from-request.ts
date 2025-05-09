import * as BusBoy from 'busboy'
import { Request } from 'express'
import { IncomingMessage } from 'http'
import * as fileType from 'magic-bytes.js'
import { Readable } from 'stream'
import { TextDecoder } from 'util'

export interface FileSizeLimit {
  maxMegabytes: number
  maxBytes: number
}

export enum SupportedFileType {
  CSV = 'csv',
  JPEG = 'jpeg',
  JPG = 'jpg',
  GIF = 'gif',
  PDF = 'pdf',
  PNG = 'png',
  TXT = 'txt',
  XLS = 'xls',
  XLSX = 'xlsx'
}

type GuessedFileTypes = ReturnType<typeof fileType.filetypeinfo>

export type ParsedMultiPartData = {
  fileStream: Readable | null
  fileTypeInfo: GuessedFileTypes
  originalFileName: string
  operationName: string | null
  query: string | null
  variables: string | null
}

const decoder = new TextDecoder('UTF-8', { fatal: true })

export const TEXT_TYPES = ['text/html', 'text/plain', 'text/csv']

function toString(bytes: Buffer): string {
  const array = new Uint8Array(bytes)
  return decoder.decode(array, { stream: true })
}

function getSupportedFileType(chunk: Buffer): GuessedFileTypes | null {
  const fileGuessedTypes = fileType.filetypeinfo(chunk)

  if (!fileGuessedTypes.length) {
    return null
  }

  const supportedSet: Set<string> = new Set(Object.values(SupportedFileType))
  const supportedGuessedTypes = []

  for (const guessedType of fileGuessedTypes) {
    if (supportedSet.has(guessedType.typename)) {
      supportedGuessedTypes.push(guessedType)
    }
  }

  if (supportedGuessedTypes.length > 0) {
    return supportedGuessedTypes
  }

  // Not supported
  return null
}

export async function getFormDataFromRequest(
  req: Request | IncomingMessage,
  fileSizeLimit: FileSizeLimit
): Promise<ParsedMultiPartData> {
  return new Promise(function (resolve, reject) {
    const bb = BusBoy.default({
      headers: req.headers,
      limits: {
        fileSize: fileSizeLimit.maxBytes
      }
    })

    let operationName: string | null = null
    let query: string | null = null
    let variables: string | null = null

    // eslint-disable-next-line func-style
    const cleanup = (): void => {
      req.unpipe(bb)
      req.on('readable', req.read.bind(req))
      bb.removeAllListeners()
    }

    bb.on('field', function (fieldName, fieldValue) {
      // The body needs to be reconstructed from the form fields so that GraphQL can use it.
      // Body is only available in an express request
      if (fieldName === 'operationName') {
        operationName = fieldValue
      } else if (fieldName === 'query') {
        query = fieldValue
      } else if (fieldName === 'variables') {
        variables = fieldValue
      }
    })

    bb.on('file', function (fileName, fileStream, fileInfo) {
      if (!fileName) {
        fileStream.destroy()
        return reject(new Error('Filename is empty'))
      }

      if (!query) {
        fileStream.destroy()
        return reject(new Error('Form fields must go before file'))
      }

      let buffer = Buffer.alloc(0)

      // eslint-disable-next-line func-style
      const handleFileStreamData = (ended = false): void => {
        let fileTypeInfo = getSupportedFileType(buffer)

        // Plain text file types can't be validated using the first bytes
        // Instead we try to decode with utf-8
        if (TEXT_TYPES.includes(fileInfo.mimeType) && !fileTypeInfo) {
          const mimeParts = fileInfo.mimeType.split('/')
          const typename = mimeParts[1]
          fileTypeInfo = [{ mime: fileInfo.mimeType, typename }]

          try {
            toString(buffer)
          } catch (error) {
            reject(error as Error)
          }
        }

        if (!fileTypeInfo) {
          cleanup()
          reject(new Error(ended ? 'File is too small or file type is not supported' : 'File type not supported'))
        } else {
          fileStream.removeListener('data', validateFileStream)
          fileStream.pause()

          // Ended file streams cannot be unshifted
          if (!ended) {
            fileStream.unshift(buffer)
          }

          return resolve({
            fileStream: ended ? Readable.from(buffer) : fileStream,
            fileTypeInfo,
            originalFileName: fileName !== 'file' ? fileName : fileInfo.filename,
            query,
            operationName,
            variables
          })
        }
      }

      // eslint-disable-next-line func-style
      const validateFileStream = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length >= 100) {
          handleFileStreamData()
        }
      }

      fileStream.on('end', () => {
        // If fileStream ended and size was smaller then 100 we try to read the fileType
        if (buffer.length < 100) {
          handleFileStreamData(true)
        }
      })

      fileStream.on('data', validateFileStream)
    })

    bb.on('error', function (err) {
      cleanup()
      reject(err as Error)
    })

    bb.on('finish', function () {
      cleanup()
    })

    req.pipe(bb)
  })
}
