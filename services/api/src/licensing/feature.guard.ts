import { CanActivate, ExecutionContext, Injectable, mixin, Type } from '@nestjs/common';

export function RequireFeature(featureName: string): Type<CanActivate> {
  @Injectable()
  class FeatureGuardMixin implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest();
      const user = request.user;
      if (user && user.role === 'admin') {
        return true;
      }
      // Features will be evaluated from active license or request.features
      const features: string[] = request.features || [];
      return features.includes(featureName);
    }
  }

  return mixin(FeatureGuardMixin);
}
