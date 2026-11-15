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
    expect(sqlQuery).toContain('INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url, variants_json)');
    expect(sqlQuery).not.toContain('created_at');
    expect(sqlQuery).not.toContain('updated_at');
    expect(sqlParams).toEqual([10, 'CAP-RED', 'Red Cap', 'Accessories', 350, 50, null, '[]']);
  });

  it('stores cleaned variants on create, dropping malformed ones', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 6, client_id: 10, sku: 'TSH-M', name: 'T-Shirt', category: 'Apparel',
          price_bdt: 500, stock: 5, image_url: null,
          variants_json: [{ name: 'M', price_bdt: 550, stock: 2 }],
        },
      ],
    });

    const res = await controller.createProduct(10, {
      sku: 'TSH-M',
      name: 'T-Shirt',
      priceBdt: 500,
      stock: 5,
      variants: [{ name: 'M', price_bdt: 550, stock: 2 }, { name: '' }, { price_bdt: 1 }],
    });

    expect(res.product.variants).toEqual([{ name: 'M', price_bdt: 550, stock: 2 }]);
    const [, sqlParams] = mockPool.query.mock.calls[0];
    expect(sqlParams[7]).toBe(JSON.stringify([{ name: 'M', price_bdt: 550, stock: 2 }]));
  });

  it('keeps existing variants on update when none are sent', async () => {
    const current = {
      id: 6, client_id: 10, sku: 'TSH-M', name: 'T-Shirt', category: 'Apparel',
      price_bdt: 500, stock: 5, image_url: null,
      variants_json: [{ name: 'L', price_bdt: null, stock: null }],
    };
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM products')) return { rows: [current] };
      return { rows: [{ ...current, price_bdt: 600 }] };
    });

    const res = await controller.updateProduct(10, 6, { priceBdt: 600 });
    expect(res.product.price_bdt).toBe(600);
    expect(res.product.variants).toEqual([{ name: 'L', price_bdt: null, stock: null }]);
    const updateCall = mockPool.query.mock.calls.find((c: any[]) => c[0].includes('UPDATE products'));
    expect(updateCall[1][6]).toBe(JSON.stringify([{ name: 'L', price_bdt: null, stock: null }]));
  });

  it('forwards the image to the cPanel host and saves only the returned URL', async () => {
    const prevSecret = process.env.PRODUCT_PAGES_UPLOAD_SECRET;
    const prevFlag = process.env.PRODUCT_PAGES_ENABLED;
    process.env.PRODUCT_PAGES_UPLOAD_SECRET = 'test-secret';
    process.env.PRODUCT_PAGES_ENABLED = 'true';
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, url: 'https://tectobox.thsite.top/uploads/10/6/abc.jpg' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM products')) return { rows: [{ id: 6 }] };
      return { rows: [{ id: 6, image_url: 'https://tectobox.thsite.top/uploads/10/6/abc.jpg' }] };
    });

    try {
      const res = await controller.uploadProductImage(10, 6, {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimetype: 'image/jpeg', originalname: 'a.jpg', size: 4,
      });
      expect(res.ok).toBe(true);
      expect(res.product.image_url).toBe('https://tectobox.thsite.top/uploads/10/6/abc.jpg');
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://tectobox.thsite.top/api/upload.php');
      expect(opts.headers['X-Upload-Secret']).toBe('test-secret');
      const updateCall = mockPool.query.mock.calls.find((c: any[]) => c[0].includes('UPDATE products SET image_url'));
      expect(updateCall[1][0]).toBe('https://tectobox.thsite.top/uploads/10/6/abc.jpg');
    } finally {
      vi.unstubAllGlobals();
      if (prevSecret === undefined) delete process.env.PRODUCT_PAGES_UPLOAD_SECRET;
      else process.env.PRODUCT_PAGES_UPLOAD_SECRET = prevSecret;
      if (prevFlag === undefined) delete process.env.PRODUCT_PAGES_ENABLED;
      else process.env.PRODUCT_PAGES_ENABLED = prevFlag;
    }
  });

  it('refuses the image upload when the shared secret is not configured', async () => {
    const prevSecret = process.env.PRODUCT_PAGES_UPLOAD_SECRET;
    const prevFlag = process.env.PRODUCT_PAGES_ENABLED;
    process.env.PRODUCT_PAGES_ENABLED = 'true';
    delete process.env.PRODUCT_PAGES_UPLOAD_SECRET;
    try {
      await expect(
        controller.uploadProductImage(10, 6, { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'a.jpg', size: 4 }),
      ).rejects.toThrow('Product image upload is not configured');
    } finally {
      if (prevSecret !== undefined) process.env.PRODUCT_PAGES_UPLOAD_SECRET = prevSecret;
      if (prevFlag === undefined) delete process.env.PRODUCT_PAGES_ENABLED;
      else process.env.PRODUCT_PAGES_ENABLED = prevFlag;
    }
  });

  it('503s the image upload when the product pages module is switched off', async () => {
    const prevFlag = process.env.PRODUCT_PAGES_ENABLED;
    delete process.env.PRODUCT_PAGES_ENABLED;
    try {
      await expect(
        controller.uploadProductImage(10, 6, { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'a.jpg', size: 4 }),
      ).rejects.toThrow('Product pages are disabled');
    } finally {
      if (prevFlag !== undefined) process.env.PRODUCT_PAGES_ENABLED = prevFlag;
    }
  });
});
