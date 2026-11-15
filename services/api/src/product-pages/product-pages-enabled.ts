import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Product pages module switch (2026-11-15, user-ordered OFF).
 * The module is OFF unless PRODUCT_PAGES_ENABLED=true. The cPanel host
 * (InfinityFree free hosting) blocks the VPS's server-to-server calls,
 * so the shareable page + image upload do not work end to end — the
 * module stays off until the hosting route changes. To turn it back on:
 * set PRODUCT_PAGES_ENABLED=true (VPS .env, api service) and re-upload
 * the PHP files from ~/workspace/vps-audit/product-pages/htdocs/.
 */
export function productPagesEnabled(): boolean {
  return process.env.PRODUCT_PAGES_ENABLED === 'true';
}

/** Throws 503 when the product pages module is switched off. */
export function assertProductPagesEnabled(): void {
  if (!productPagesEnabled()) {
    throw new ServiceUnavailableException('Product pages are disabled');
  }
}
