import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogController } from './catalog.controller.js';

describe('CatalogController', () => {
  let controller: CatalogController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    controller = new CatalogController(mockPool);
  });

  it('queries products with tenant scoping', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          client_id: 10,
          sku: 'HOODIE-BLK-M',
          name: 'Black Hoodie (M)',
          category: 'Apparel',
          price_bdt: 1200,
          stock: 15,
          image_url: 'https://img.test/hoodie.jpg',
        },
      ],
    });

    const res = await controller.getProducts(10);
    expect(res.success).toBe(true);
    expect(res.tenantId).toBe(10);
    expect(res.products.length).toBe(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE client_id = $1'),
      [10]
    );
  });

  it('inserts product matching PostgreSQL schema columns without unsupported timestamp columns', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          client_id: 10,
          sku: 'CAP-RED',
          name: 'Red Cap',
          category: 'Accessories',
          price_bdt: 350,
          stock: 50,
          image_url: null,
        },
      ],
    });

    const res = await controller.createProduct(10, {
      sku: 'CAP-RED',
      name: 'Red Cap',
      category: 'Accessories',
      priceBdt: 350,
      stock: 50,
    });

    expect(res.success).toBe(true);
    expect(res.tenantId).toBe(10);
    expect(res.product.sku).toBe('CAP-RED');

    const [sqlQuery, sqlParams] = mockPool.query.mock.calls[0];
    expect(sqlQuery).toContain('INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url)');
    expect(sqlQuery).not.toContain('created_at');
    expect(sqlQuery).not.toContain('updated_at');
    expect(sqlParams).toEqual([10, 'CAP-RED', 'Red Cap', 'Accessories', 350, 50, null]);
  });
});
