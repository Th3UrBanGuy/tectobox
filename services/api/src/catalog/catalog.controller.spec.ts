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
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
      return {
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
      };
    });

    const res = await controller.getProducts(10);
    expect(res.success).toBe(true);
    expect(res.tenantId).toBe(10);
    expect(res.products.length).toBe(1);
    expect(res.total).toBe(1);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
  });

  it('M14: supports limit and offset pagination on getProducts', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 5 }] };
      return { rows: [{ id: 3, name: 'Product 3' }] };
    });

    const res = await controller.getProducts(10, undefined, '10', '20');
    expect(res.total).toBe(5);
    expect(res.limit).toBe(10);
    expect(res.offset).toBe(20);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2 OFFSET $3'),
      [10, 10, 20]
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
