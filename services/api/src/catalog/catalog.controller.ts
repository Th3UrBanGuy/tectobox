import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException, ServiceUnavailableException, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { cleanProductVariants } from '@tectonic/contracts';
import { assertProductPagesEnabled } from '../product-pages/product-pages-enabled.js';

/** Image types the cPanel upload endpoint accepts (mirrored there). */
const PRODUCT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The fields the image-upload proxy reads off the uploaded file.
 * FileInterceptor's default storage is memory, so the file arrives as a
 * buffer — there is no path on disk (readFile(file.path) 500s live). */
interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/**
 * Aliases (migration 007, 2026-11-16 audit Fix 3): alternate names for
 * a product — e.g. "কিটক্যাট" for "Kitkat" — that the catalog matcher
 * scores as a full phrase. Accepts an array or a comma-separated
 * string; drops empties/dupes, caps at 20 aliases, 80 chars each.
 */
function cleanAliases(v: unknown): string[] {
  const list: string[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  for (const a of list) {
    const s = String(a).trim().slice(0, 80);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

@Controller(['api', 'api/catalog'])
@UseGuards(TenantGuard)
export class CatalogController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Get('products')
  async getProducts(
    @CurrentTenant() tenantId: number,
    @Query('q') query?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    let whereSql = `WHERE client_id = $1`;
    const params: any[] = [tenantId];

    if (query && query.trim()) {
      params.push(`%${query.trim()}%`);
      whereSql += ` AND (name ILIKE $2 OR sku ILIKE $2 OR category ILIKE $2)`;
    }

    const countRes = await this.pool.query(`SELECT COUNT(*) AS total FROM products ${whereSql}`, params);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const queryParams = [...params, limit, offset];
    const dataSql = `SELECT id, client_id, sku, name, category, price_bdt, stock, image_url, variants_json, aliases_json
                     FROM products
                     ${whereSql}
                     ORDER BY id ASC
                     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
    const result = await this.pool.query(dataSql, queryParams);

    const products = result.rows.map((row: any) => this.toProduct(row));
    const res: any = products;
    res.success = true;
    res.tenantId = tenantId;
    res.products = products;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  /** One row → public shape: variants_json becomes the cleaned `variants`, aliases_json the cleaned `aliases`. */
  private toProduct(row: any) {
    const { variants_json, aliases_json, ...rest } = row;
    return { ...rest, variants: cleanProductVariants(variants_json), aliases: cleanAliases(aliases_json) };
  }

  @Post('products')
  async createProduct(
    @CurrentTenant() tenantId: number,
    @Body() body: { sku: string; name: string; priceBdt?: number; price_bdt?: number; stock?: number; category?: string; imageUrl?: string; image_url?: string; variants?: unknown; aliases?: unknown }
  ) {
    const price = body.priceBdt ?? body.price_bdt ?? 0;
    const img = body.imageUrl ?? body.image_url ?? null;
    const variants = cleanProductVariants(body.variants);
    const aliases = cleanAliases(body.aliases);

    const result = await this.pool.query(
      `INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url, variants_json, aliases_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, client_id, sku, name, category, price_bdt, stock, image_url, variants_json, aliases_json`,
      [
        tenantId,
        body.sku,
        body.name,
        body.category || null,
        price,
        body.stock || 0,
        img,
        JSON.stringify(variants),
        JSON.stringify(aliases),
      ]
    );

    const product = this.toProduct(result.rows[0]);
    return {
      ...product,
      success: true,
      tenantId,
      product: { ...product },
    };
  }

  @Patch('products/:id')
  async updateProduct(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { sku?: string; name?: string; priceBdt?: number; price_bdt?: number; stock?: number; category?: string; imageUrl?: string; image_url?: string; variants?: unknown; aliases?: unknown }
  ) {
    const check = await this.pool.query(
      'SELECT * FROM products WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundException('Product not found');
    }

    const current = check.rows[0];
    const sku = body.sku ?? current.sku;
    const name = body.name ?? current.name;
    const category = body.category !== undefined ? body.category : current.category;
    const price = body.priceBdt ?? body.price_bdt ?? current.price_bdt;
    const stock = body.stock ?? current.stock;
    const img = body.imageUrl ?? body.image_url ?? current.image_url;
    const variants = body.variants !== undefined
      ? cleanProductVariants(body.variants)
      : cleanProductVariants(current.variants_json);
    const aliases = body.aliases !== undefined
      ? cleanAliases(body.aliases)
      : cleanAliases(current.aliases_json);

    const result = await this.pool.query(
      `UPDATE products
       SET sku = $1, name = $2, category = $3, price_bdt = $4, stock = $5, image_url = $6, variants_json = $7, aliases_json = $8
       WHERE id = $9 AND client_id = $10
       RETURNING id, client_id, sku, name, category, price_bdt, stock, image_url, variants_json, aliases_json`,
      [sku, name, category, price, stock, img, JSON.stringify(variants), JSON.stringify(aliases), id, tenantId]
    );

    const updated = this.toProduct(result.rows[0]);
    return {
      ...updated,
      success: true,
      tenantId,
      product: { ...updated },
    };
  }

  /**
   * Product image upload (product pages, 2026-11-15). The bytes never land
   * on this VPS: the file is forwarded to the cPanel PHP host, which stores
   * it and returns a public URL — only that URL is saved in image_url.
   * The shared secret lives in PRODUCT_PAGES_UPLOAD_SECRET (VPS .env) and
   * in the cPanel secret.php; it is never logged or returned.
   * OFF by default (PRODUCT_PAGES_ENABLED) — see product-pages-enabled.ts.
   */
  @Post('products/:id/image')
  @UseInterceptors(FileInterceptor('image', {
    limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (PRODUCT_IMAGE_MIMES.includes(file.mimetype)) cb(null, true);
      else cb(new BadRequestException('Only JPG, PNG or WebP images are allowed'), false);
    },
  }))
  async uploadProductImage(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file?: UploadedImage,
  ) {
    assertProductPagesEnabled();
    if (!file) throw new BadRequestException('No image uploaded');
    const secret = process.env.PRODUCT_PAGES_UPLOAD_SECRET;
    const host = process.env.PRODUCT_PAGES_HOST || 'tectobox.thsite.top';
    if (!secret) throw new ServiceUnavailableException('Product image upload is not configured');

    const check = await this.pool.query(
      'SELECT id FROM products WHERE id = $1 AND client_id = $2',
      [id, tenantId],
    );
    if (check.rows.length === 0) throw new NotFoundException('Product not found');

    // Memory storage: the file is already a buffer; nothing on disk to read
    // or clean up. (Earlier code read file.path — undefined with memory
    // storage — and 500d on the first live upload.)
    const buffer: Buffer = file.buffer;
    if (!buffer || buffer.length === 0) throw new BadRequestException('No image uploaded');

    const form = new FormData();
    form.append('client_id', String(tenantId));
    form.append('product_id', String(id));
    form.append('image', new Blob([new Uint8Array(buffer)], { type: file.mimetype }), file.originalname);

    let upRes: Response;
    try {
      upRes = await fetch(`https://${host}/api/upload.php`, {
        method: 'POST',
        headers: { 'X-Upload-Secret': secret },
        body: form,
      });
    } catch {
      throw new ServiceUnavailableException('Image host did not answer');
    }
    const up: any = await upRes.json().catch(() => null);
    if (!upRes.ok || !up?.ok || typeof up?.url !== 'string') {
      throw new ServiceUnavailableException('Image upload failed');
    }

    const updated = await this.pool.query(
      'UPDATE products SET image_url = $1 WHERE id = $2 AND client_id = $3 RETURNING id, image_url',
      [up.url, id, tenantId],
    );
    return { ok: true, success: true, product: updated.rows[0] };
  }

  @Delete('products/:id')
  async deleteProduct(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const result = await this.pool.query(
      'DELETE FROM products WHERE id = $1 AND client_id = $2 RETURNING id',
      [id, tenantId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Product not found');
    }
    return { ok: true, success: true };
  }
}

