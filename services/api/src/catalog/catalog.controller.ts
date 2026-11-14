import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Inject, ParseIntPipe, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

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
    const dataSql = `SELECT id, client_id, sku, name, category, price_bdt, stock, image_url
                     FROM products
                     ${whereSql}
                     ORDER BY id ASC
                     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
    const result = await this.pool.query(dataSql, queryParams);

    const res: any = result.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.products = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Post('products')
  async createProduct(
    @CurrentTenant() tenantId: number,
    @Body() body: { sku: string; name: string; priceBdt?: number; price_bdt?: number; stock?: number; category?: string; imageUrl?: string; image_url?: string }
  ) {
    const price = body.priceBdt ?? body.price_bdt ?? 0;
    const img = body.imageUrl ?? body.image_url ?? null;

    const result = await this.pool.query(
      `INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, client_id, sku, name, category, price_bdt, stock, image_url`,
      [
        tenantId,
        body.sku,
        body.name,
        body.category || null,
        price,
        body.stock || 0,
        img,
      ]
    );

    const product = result.rows[0];
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
    @Body() body: { sku?: string; name?: string; priceBdt?: number; price_bdt?: number; stock?: number; category?: string; imageUrl?: string; image_url?: string }
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

    const result = await this.pool.query(
      `UPDATE products
       SET sku = $1, name = $2, category = $3, price_bdt = $4, stock = $5, image_url = $6
       WHERE id = $7 AND client_id = $8
       RETURNING id, client_id, sku, name, category, price_bdt, stock, image_url`,
      [sku, name, category, price, stock, img, id, tenantId]
    );

    const updated = result.rows[0];
    return {
      ...updated,
      success: true,
      tenantId,
      product: { ...updated },
    };
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

