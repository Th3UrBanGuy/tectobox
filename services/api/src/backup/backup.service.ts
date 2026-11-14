import { Injectable, Inject, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

export const BACKUP_VERSION = 1;
export const MAX_BACKUP_ROWS = 50000;

@Injectable()
export class BackupService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async exportClientData(clientId: number) {
    const clientRes = await this.pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (clientRes.rows.length === 0) {
      throw new NotFoundException('Client not found');
    }
    const client = clientRes.rows[0];

    // L15: Row-count guard to prevent memory exhaustion / OOM on large exports
    const countRes = await this.pool.query(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE client_id = $1) +
         (SELECT COUNT(*) FROM knowledge WHERE client_id = $1) +
         (SELECT COUNT(*) FROM leads WHERE client_id = $1) +
         (SELECT COUNT(*) FROM orders WHERE client_id = $1) +
         (SELECT COUNT(*) FROM conversations WHERE client_id = $1 AND deleted_at IS NULL) +
         (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.client_id = $1 AND c.deleted_at IS NULL)
       AS total_rows`,
      [clientId]
    );
    const totalRows = parseInt(countRes.rows[0]?.total_rows || '0', 10);
    if (totalRows > MAX_BACKUP_ROWS) {
      throw new PayloadTooLargeException(
        `Backup export exceeds maximum allowed row count of ${MAX_BACKUP_ROWS} (found ${totalRows} rows). Contact support to export in chunks.`
      );
    }

    const productsRes = await this.pool.query('SELECT * FROM products WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const knowledgeRes = await this.pool.query('SELECT * FROM knowledge WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const leadsRes = await this.pool.query('SELECT * FROM leads WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    const ordersRes = await this.pool.query('SELECT * FROM orders WHERE client_id = $1 ORDER BY id ASC', [clientId]);
    // RC8: Only include non-deleted conversations
    const convsRes = await this.pool.query(
      `SELECT c.*, COALESCE(json_agg(m.* ORDER BY m.id ASC) FILTER (WHERE m.id IS NOT NULL), '[]'::json) as messages
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.client_id = $1 AND c.deleted_at IS NULL
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

    L.push(`# Workspace Backup: ${c.name || 'Untitled'}`);
    L.push(`- Exported: ${bundle.exported_at || new Date().toISOString()}`);
    L.push(`- Format: Markdown (Tectobox Portable Backup v${bundle.version || 1})`);
    L.push(`- Workspace ID: ${c.id || 'N/A'}`);
    L.push(`- Business Type: ${c.business_type || 'N/A'}`);
    L.push('');

    L.push('## Summary');
    L.push('| Entity | Count |');
    L.push('|---|---|');
    L.push(`| Products | ${(bundle.products || []).length} |`);
    L.push(`| Knowledge Items | ${(bundle.knowledge || []).length} |`);
    L.push(`| Leads | ${(bundle.leads || []).length} |`);
    L.push(`| Orders | ${(bundle.orders || []).length} |`);
    L.push(`| Conversations | ${(bundle.conversations || []).length} |`);
    const msgCount = (bundle.conversations || []).reduce(
      (acc: number, cv: any) => acc + (cv.messages || []).length,
      0
    );
    L.push(`| Messages | ${msgCount} |`);
    L.push('');

    // Products table
    L.push('## Products');
    if (!bundle.products || bundle.products.length === 0) {
      L.push('_No products recorded._');
    } else {
      L.push('| SKU | Name | Category | Price (BDT) | Stock |');
      L.push('|---|---|---|---|---|');
      for (const p of bundle.products) {
        L.push(`| ${p.sku || ''} | ${p.name || ''} | ${p.category || ''} | ${p.price_bdt ?? ''} | ${p.stock ?? ''} |`);
      }
    }
    L.push('');

    // Knowledge table
    L.push('## Knowledge Base');
    if (!bundle.knowledge || bundle.knowledge.length === 0) {
      L.push('_No knowledge base entries._');
    } else {
      L.push('| Category | Key | Content |');
      L.push('|---|---|---|');
      for (const k of bundle.knowledge) {
        const preview = String(k.content || '').replace(/\r?\n/g, ' ').slice(0, 120);
        L.push(`| ${k.category || ''} | ${k.key || ''} | ${preview} |`);
      }
    }
    L.push('');

    // Leads table
    L.push('## Leads');
    if (!bundle.leads || bundle.leads.length === 0) {
      L.push('_No leads recorded._');
    } else {
      L.push('| Name | Phone | Stage | Temperature | Score | Platform |');
      L.push('|---|---|---|---|---|---|');
      for (const ld of bundle.leads) {
        L.push(`| ${ld.name || ''} | ${ld.phone || ''} | ${ld.stage || ''} | ${ld.temperature || ''} | ${ld.score ?? ''} | ${ld.platform || ''} |`);
      }
    }
    L.push('');

    // Orders table
    L.push('## Orders');
    if (!bundle.orders || bundle.orders.length === 0) {
      L.push('_No orders recorded._');
    } else {
      L.push('| Order ID | Customer | Phone | Total (BDT) | Status | Date |');
      L.push('|---|---|---|---|---|---|');
      for (const o of bundle.orders) {
        L.push(`| ${o.id} | ${o.customer_name || ''} | ${o.customer_phone || ''} | ${o.total_bdt ?? ''} | ${o.status || ''} | ${o.created_at || ''} |`);
      }
    }
    L.push('');

    // Conversations overview
    L.push('## Conversations');
    if (!bundle.conversations || bundle.conversations.length === 0) {
      L.push('_No conversations recorded._');
    } else {
      for (const cv of bundle.conversations) {
        L.push(`### Conversation #${cv.id} (${cv.platform || 'webchat'})`);
        L.push(`- Customer: ${cv.customer_name || 'Anonymous'} (${cv.customer_phone || cv.platform_user_id || 'no phone'})`);
        L.push(`- Last active: ${cv.last_message_at || 'unknown'}`);
        L.push(`- Unread: ${cv.unread_count || 0}`);
        L.push('');
        const msgs = cv.messages || [];
        if (msgs.length === 0) {
          L.push('_No messages._');
        } else {
          for (const m of msgs) {
            const who = m.direction === 'in' ? 'Customer' : 'Bot/Agent';
            const when = m.created_at ? new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 19) : '';
            L.push(`- **[${when}] ${who}:** ${String(m.text || '').replace(/\r?\n/g, ' ')}`);
          }
        }
        L.push('');
      }
    }

    return L.join('\n');
  }

  async importClientData(clientId: number, bundle: any) {
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Invalid bundle format');
    }

    let productsCount = 0;
    if (Array.isArray(bundle.products)) {
      for (const p of bundle.products) {
        if (!p.sku || !p.name) continue;
        await this.pool.query(
          `INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (client_id, sku) DO UPDATE SET
             name = excluded.name,
             category = excluded.category,
             price_bdt = excluded.price_bdt,
             stock = excluded.stock,
             image_url = excluded.image_url`,
          [clientId, p.sku, p.name, p.category || null, p.price_bdt || 0, p.stock || 0, p.image_url || null]
        );
        productsCount++;
      }
    }

    let knowledgeCount = 0;
    if (Array.isArray(bundle.knowledge)) {
      for (const k of bundle.knowledge) {
        if (!k.key || !k.content) continue;
        await this.pool.query(
          `INSERT INTO knowledge (client_id, key, content, category)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id, key) DO UPDATE SET
             content = excluded.content,
             category = excluded.category`,
          [clientId, k.key, k.content, k.category || 'general']
        );
        knowledgeCount++;
      }
    }

    return {
      products: productsCount,
      knowledge: knowledgeCount,
    };
  }
}
