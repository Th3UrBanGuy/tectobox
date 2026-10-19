import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

export const BACKUP_VERSION = 1;

@Injectable()
export class BackupService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async exportClientData(clientId: number) {
    const clientRes = await this.pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (clientRes.rows.length === 0) {
      throw new NotFoundException('Client not found');
    }
    const client = clientRes.rows[0];

    const productsRes = await this.pool.query('SELECT * FROM products WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const knowledgeRes = await this.pool.query('SELECT * FROM knowledge WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const leadsRes = await this.pool.query('SELECT * FROM leads WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const ordersRes = await this.pool.query('SELECT * FROM orders WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const convsRes = await this.pool.query(
      `SELECT c.*, COALESCE(json_agg(m.* ORDER BY m.id ASC) FILTER (WHERE m.id IS NOT NULL), '[]'::json) as messages
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.client_id = $1
       GROUP BY c.id ORDER BY c.id ASC`,
      [clientId]
    );

    return {
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      app: 'tectonic-inbox',
      client: {
        id: client.id,
        name: client.name,
        business_type: client.business_type,
        created_at: client.created_at,
      },
      products: productsRes.rows,
      knowledge: knowledgeRes.rows,
      leads: leadsRes.rows,
      orders: ordersRes.rows,
      conversations: convsRes.rows,
      appearance: {
        title: client.wc_title,
        greeting: client.wc_greeting,
        color: client.wc_color,
        position: client.wc_position,
        avatar: client.wc_avatar,
        subtitle: client.wc_subtitle,
        require_intro: client.wc_require_intro,
      },
    };
  }

  bundleToMarkdown(bundle: any): string {
    const c = bundle.client || {};
    const L: string[] = [];
    L.push(`# Tectobox Backup — ${c.name || 'Workspace'}`);
    L.push(``);
    L.push(`- Exported: ${bundle.exported_at}`);
    L.push(`- Backup version: ${bundle.version}`);
    L.push(`- Business type: ${c.business_type || 'physical'}`);
    L.push(``);
    L.push(`## Contents`);
    L.push(``);
    L.push(`| Data | Count |`);
    L.push(`|------|-------|`);
    L.push(`| Products | ${(bundle.products || []).length} |`);
    L.push(`| Knowledge documents | ${(bundle.knowledge || []).length} |`);
    L.push(`| Leads | ${(bundle.leads || []).length} |`);
    L.push(`| Orders | ${(bundle.orders || []).length} |`);
    L.push(`| Conversations | ${(bundle.conversations || []).length} |`);
    const msgCount = (bundle.conversations || []).reduce(
      (n: number, cv: any) => n + (Array.isArray(cv.messages) ? cv.messages.length : 0),
      0
    );
    L.push(`| Messages | ${msgCount} |`);
    L.push(``);

    if (bundle.products?.length) {
      L.push(`## Products`);
      L.push(``);
      bundle.products.forEach((p: any) => {
        L.push(`- **${p.name}** (SKU: ${p.sku}) — ৳${p.price_bdt}, stock ${p.stock || 0}`);
      });
      L.push(``);
    }

    if (bundle.knowledge?.length) {
      L.push(`## Knowledge Base`);
      L.push(``);
      bundle.knowledge.forEach((k: any) => {
        L.push(`### ${k.title} [${k.category || 'general'}]`);
        L.push(``);
        L.push((k.content || '').slice(0, 2000));
        L.push(``);
      });
    }

    if (bundle.orders?.length) {
      L.push(`## Orders`);
      L.push(``);
      L.push(`| # | Customer | Total | Status | Date |`);
      L.push(`|---|----------|-------|--------|------|`);
      bundle.orders.slice(0, 100).forEach((o: any) => {
        L.push(`| ${o.id} | ${(o.customer_name || '').replace(/\|/g, ' ')} | ৳${o.total_bdt || 0} | ${o.payment_status || 'pending'} | ${String(o.created_at || '').slice(0, 10)} |`);
      });
      L.push(``);
    }

    L.push(`---`);
    L.push(`*Full machine-readable data is in the accompanying .json file.*`);
    L.push(``);
    return L.join('\n');
  }

  async importClientData(clientId: number, bundle: any) {
    if (!bundle || (!bundle.version && !bundle.app)) {
      throw new Error('Not a valid Tectobox backup file');
    }

    const counts = { products: 0, knowledge: 0, leads: 0, orders: 0 };

    if (Array.isArray(bundle.products)) {
      for (const p of bundle.products) {
        if (!p.sku || !p.name) continue;
        try {
          const res = await this.pool.query(
            `INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (client_id, sku) DO UPDATE
             SET name = EXCLUDED.name, price_bdt = EXCLUDED.price_bdt, stock = EXCLUDED.stock
             RETURNING id`,
            [clientId, p.sku, p.name, p.category || 'general', Number(p.price_bdt) || 0, Number(p.stock) || 0, p.image_url || null]
          );
          if (res.rows.length) counts.products++;
        } catch {}
      }
    }

    if (Array.isArray(bundle.knowledge)) {
      for (const k of bundle.knowledge) {
        if (!k.title || !k.content) continue;
        try {
          await this.pool.query(
            `INSERT INTO knowledge (client_id, title, content, category, source_url, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [clientId, k.title, k.content, k.category || 'general', k.source_url || null]
          );
          counts.knowledge++;
        } catch {}
      }
    }

    if (Array.isArray(bundle.leads)) {
      for (const l of bundle.leads) {
        if (!l.phone && !l.name) continue;
        try {
          await this.pool.query(
            `INSERT INTO leads (client_id, name, phone, address, platform, stage, score, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [clientId, l.name || 'Anonymous', l.phone || null, l.address || null, l.platform || 'webchat', l.stage || 'new', Number(l.score) || 50]
          );
          counts.leads++;
        } catch {}
      }
    }

    if (Array.isArray(bundle.orders)) {
      for (const o of bundle.orders) {
        try {
          await this.pool.query(
            `INSERT INTO orders (client_id, customer_name, customer_phone, delivery_address, items_json, total_bdt, payment_status, courier_status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [clientId, o.customer_name || 'Customer', o.customer_phone || '', o.delivery_address || '', JSON.stringify(o.items || o.items_json || []), Number(o.total_bdt) || 0, o.payment_status || 'paid', o.courier_status || 'pending']
          );
          counts.orders++;
        } catch {}
      }
    }

    return counts;
  }
}
