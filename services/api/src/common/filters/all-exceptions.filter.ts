import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorTrackingService } from '../errors/error-tracking.service.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly tracker = ErrorTrackingService.getInstance();

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

    const tenantId = (request as any).tenantId || (request as any).user?.clientId || null;
    const stackSnippet = exception instanceof Error ? exception.stack?.split('\n').slice(0, 5).join('\n') : undefined;

    // Track in ring-buffer & optional Sentry
    const errorRecord = this.tracker.track({
      method: request.method,
      path: request.url,
      statusCode: status,
      error: errorName,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      tenantId,
      userAgent: request.headers['user-agent'],
      ip: (request.headers['x-forwarded-for'] as string) || request.socket?.remoteAddress,
      stackSnippet,
      source: 'backend',
    });

    const errorResponse = {
      success: false,
      statusCode: status,
      error: errorName,
      message,
      errorId: errorRecord.id,
      timestamp: errorRecord.timestamp,
      path: request.url,
    };

    // PII-Safe logging
    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - Status ${status} [${errorRecord.id}] - Error: ${exception instanceof Error ? exception.message : 'Unknown'}`,
        exception instanceof Error ? exception.stack : undefined
      );
    } else {
      this.logger.warn(`[${request.method}] ${request.url} - Status ${status} [${errorRecord.id}] - Message: ${JSON.stringify(message)}`);
    }

    if (!response.headersSent) {
      response.status(status).json(errorResponse);
    }
  }
}

