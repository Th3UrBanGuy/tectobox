import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (user.role !== 'admin' && (user.role as any) !== 'superadmin')) {
      throw new ForbiddenException('Access denied: Platform Administrator role required');
    }
    return true;
  }
}
