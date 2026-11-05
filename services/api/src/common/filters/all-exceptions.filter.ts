import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: any = 'Internal server error';
    let errorName = 'InternalServerError';

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        message = (res as any).message || (res as any).error || message;
        errorName = (res as any).error || exception.name;
      }
    } else if (exception instanceof Error) {
      message = process.env.NODE_ENV === 'production' ? 'An unexpected system error occurred' : exception.message;
      errorName = exception.name;
    }

    const errorResponse = {
      success: false,
      statusCode: status,
      error: errorName,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    // PII-Safe logging
    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - Status ${status} - Error: ${exception instanceof Error ? exception.message : 'Unknown'}`,
        exception instanceof Error ? exception.stack : undefined
      );
    } else {
      this.logger.warn(`[${request.method}] ${request.url} - Status ${status} - Message: ${JSON.stringify(message)}`);
    }

    if (!response.headersSent) {
      response.status(status).json(errorResponse);
    }
  }
}
