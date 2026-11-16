import pg from 'pg';
import {
  DEFAULT_DELIVERY_CHARGE_BDT,
  buildOutOfStockReply,
  detectCustomerLanguage,
  extractCustomerDetails,
  findInStockAlternative,
  findProduct,
  parsePaymentConfig,
  paymentLineForConfirmation,
  toBengaliDigits,
} from '../ai/router.js';
import type { PaymentConfig, ProductItem } from '../ai/router.js';

export interface OrderAttemptContext {
  client: any;
  conv: any;
  text: string;
  /** Name/phone captured at widget identify time (may be null). */
  name: string | null;
  phone: string | null;
  products: ProductItem[];
  /** Prior messages, oldest first ({ role, content }); the current message is `text`. */
  history: Array<{ role: string; content: string }>;
}

export type OrderAttemptOutcome =
  | { status: 'created'; order: any; replyText: string; modelUsed: 'order:created' }
  | { status: 'already_exists'; order: any; replyText: string; modelUsed: 'order:already-exists' }
  | { status: 'out_of_stock'; product: ProductItem; replyText: string; modelUsed: 'order:out-of-stock' }
  | { status: 'not_applicable' }
  | { status: 'error' };

/**
 * Called once per genuinely created order, after the transaction
 * commits (item-3, 2026-11-15). The widget controller wires it to
 * the SSE broadcast (`ORDER_CREATED`); the service itself stays
 * decoupled from the event bus. Never called for a double confirm
 * (already_exists), a refusal, or a failure.
 */
export type OrderCreatedListener = (order: any) => Promise<void> | void;

/**
 * Widget order creation (W3, 2026-11-15): the order branch of the
 * template responder only ever produced a prompt asking for
 * name/phone/address — no code anywhere inserted an `orders` row
 * (5 full order flows in the audit, 0 orders in the DB). This service
 * owns that persistence and nothing else.
 *
 * When it creates:
 * - the customer CONFIRMS (an explicit confirm/yes in this message,
 *   or a complete order — intent + product + all details — in this
 *   one message), AND
 * - name + phone + address are present (pulled from this message and
 *   the conversation with Seg A's `extractCustomerDetails` — never
 *   re-asked for what was already given), AND
 * - a catalog product is identified (Seg A's matcher, `findProduct` —
 *   the same matcher the responder uses), AND
 * - stock covers the quantity (W4).
 * Then exactly ONE row is inserted in `orders` (payment_status
 * 'pending', status 'confirmed'). The reply confirms the order with
 * its total — and is only ever sent when a row exists.
 *
 * Security rules (this is a money path):
 * - Never create an order for a product the customer did not ask for
 *   (product comes from the matcher, never a products[0] fallback).
 * - Never invent a price: unit price comes from the catalog row.
 * - Never create without the customer's confirmation (see above).
 * - Idempotent: the key is deterministic
 *   (`webchat:<conversation_id>:<product>:qty:<n>`) and
 *   (client_id, idempotency_key) is UNIQUE in the DB, so a double
 *   confirm (or a retried message) returns the existing order instead
 *   of a second row. The INSERT itself is ON CONFLICT DO NOTHING, so
 *   a concurrent double-confirm cannot race a duplicate in either.
 *   A genuinely SECOND order of the same thing in the same
 *   conversation is the exception, not a duplicate: when the message
 *   carries a repeat word (আরেকটা / another / one more — see
 *   REPEAT_ORDER_RE) the key gains `:seq:<n>` with n = the
 *   conversation's order count + 1, so it becomes a new row. Without
 *   a repeat word the key is unchanged and a second confirm still
 *   returns the existing order.
 */
export class OrderService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly onOrderCreated?: OrderCreatedListener
  ) {}

  async tryCreateOrder(ctx: OrderAttemptContext): Promise<OrderAttemptOutcome> {
    const { client, conv, text, products, history } = ctx;
    const userHistory = history.filter((h) => h.role === 'user');

    // 1. Details: this message first, then identify-time name/phone,
    // then the conversation row, then earlier user messages (newest
    // first). Quantity is read the same way (never from the bot's
    // own echoes).
    const currentDetails = extractCustomerDetails(text);
    const details = { ...currentDetails };
    if (!details.name) details.name = ctx.name || conv.customer_name || undefined;
    if (!details.phone) details.phone = ctx.phone || conv.customer_phone || undefined;
    for (const h of [...userHistory].reverse()) {
      if (details.name && details.phone && details.address && details.quantity) break;
      const older = extractCustomerDetails(h.content || '');
      if (!details.name && older.name) details.name = older.name;
      if (!details.phone && older.phone) details.phone = older.phone;
      if (!details.address && older.address) details.address = older.address;
      if (!details.quantity && older.quantity) details.quantity = older.quantity;
    }
    const quantity0 = details.quantity ?? 1;
    // "confirm 1" / "yes 2": a bare count after the confirm word
    // overrides the quantity carried from earlier messages. This is
    // what lets a customer accept the in-stock count after a
    // low-stock refusal instead of looping on the old quantity.
    let quantity = quantity0;
    const confirmQty = text.match(
      /(?:confirm|confirmed|yes|yeah|ok|okay|haa+|ha|done|thik|ঠিক|হ্যাঁ|হ্যা|হে|হুম|আচ্ছা|দাও|নিলাম)\D{0,10}?(\d{1,2})\s*$/iu
    );
    if (confirmQty) {
      const q = parseInt(confirmQty[1], 10);
      if (q >= 1 && q <= 99) quantity = q;
    }

    // 2. Confirmation. Explicit confirm ("confirm", "yes", "হ্যাঁ",
    // ...) with everything on file, OR a complete order placed in
    // this one message (intent + product + all details in `text`
    // itself — details supplied in an earlier turn do NOT count
    // here, or the bot's "reply confirm to place it" would be a lie).
    const explicitConfirm = CONFIRM_RE.test(text);
    const completeInOneMessage =
      ORDER_INTENT_RE.test(text) &&
      !!currentDetails.name &&
      !!currentDetails.phone &&
      !!currentDetails.address &&
      !!findProduct(text, products);
    if (!explicitConfirm && !completeInOneMessage) return { status: 'not_applicable' };

    // 3. Product: this message first, then earlier user messages
    // (newest first). No fallback — an unidentified product is never
    // an order (the responder asks for clarification instead).
    let product = findProduct(text, products);
    if (!product) {
      for (const h of [...userHistory].reverse()) {
        product = findProduct(h.content || '', products);
        if (product) break;
      }
    }
    if (!product) return { status: 'not_applicable' };

    // 4. Missing details: not an order yet — the responder asks for
    // what is missing.
    if (!details.name || !details.phone || !details.address) {
      return { status: 'not_applicable' };
    }

    // 5. Stock BEFORE creating (W4). Out of stock (or fewer in stock
    // than ordered): no row, and the reply is the responder's own
    // out-of-stock reply with its in-stock alternative — never a
    // confirmation.
    const stock = product.stock == null ? null : Number(product.stock);
    if (stock !== null && stock < quantity) {
      if (stock <= 0) {
        return {
          status: 'out_of_stock',
          product,
          replyText: buildOutOfStockReply(text, product, products),
          modelUsed: 'order:out-of-stock',
        };
      }
      return {
        status: 'out_of_stock',
        product,
        replyText: this.lowStockReply(text, product, stock, quantity, products),
        modelUsed: 'order:out-of-stock',
      };
    }

    // 6. Pricing from the catalog row only. A missing/non-positive
    // catalog price is never papered over with an invented number:
    // fail safe (no order, no confirmation) and let the normal reply
    // chain handle the message.
    const unitPrice = Number((product as any).price_bdt);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      console.warn('[widget-order] refusing order: catalog price missing/invalid for', product.name);
      return { status: 'error' };
    }
    const subtotal = unitPrice * quantity;
    const insideDhaka = this.isInsideDhaka(details.address, text, userHistory);
    const deliveryCharge = insideDhaka
      ? DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka
      : DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka;
    const total = subtotal + deliveryCharge;

    const productRef = (product as any).id ?? (product as any).sku ?? product.name;
    // 2026-11-16 scenario audit #4: the same conversation could not
    // place a second identical order — the key had no order sequence,
    // so "আরেকটা কিটক্যাট কিনতে চাই" returned the first order. A
    // repeat word opens a new order: the key gains :seq:<n>, where n
    // is the conversation's order count + 1. Without a repeat word
    // the key is unchanged, so a double confirm still returns the
    // existing order. The count is read before the insert; a race
    // between two repeats computes the same seq and ON CONFLICT still
    // leaves exactly one row. A repeat word on the FIRST order
    // (count 0) keeps the base key, so a later bare confirm dedupes
    // against it correctly.
    let idempotencyKey = `webchat:${conv.id}:${String(productRef).slice(0, 80)}:qty:${quantity}`;
    if (REPEAT_ORDER_RE.test(text)) {
      const existingCountRes = await this.pool.query(
        'SELECT COUNT(*) FROM orders WHERE client_id = $1 AND conversation_id = $2',
        [client.id, conv.id]
      );
      const existingCount = Number(existingCountRes.rows[0]?.count ?? 0);
      if (existingCount > 0) {
        idempotencyKey += `:seq:${existingCount + 1}`;
      }
    }
    // The shop's payment config (migration 007 columns on clients):
    // the advance the customer must pay, quoted in the confirmation
    // reply and stored on the order row.
    const paymentCfg = parsePaymentConfig(client);
    const itemsJson = [
      {
        product_id: (product as any).id ?? null,
        name: product.name,
        sku: (product as any).sku ?? null,
        quantity,
        unit_price_bdt: unitPrice,
        line_total_bdt: subtotal,
      },
    ];

    // 7. Insert the order AND decrement stock in ONE transaction, so
    // an order can never exist without its stock going down (and a
    // failed decrement can never leave a phantom order). The
    // decrement is guarded (stock >= quantity) so a concurrent order
    // cannot oversell: if the guard fails, the whole transaction
    // rolls back and the customer gets the REAL current stock in
    // the reply. A retried/double confirm (already_exists) never
    // decrements twice — the first order already took the stock.
    const productId = (product as any).id ?? null;
    let db: pg.PoolClient | null = null;
    try {
      db = await this.pool.connect();
      await db.query('BEGIN');
      const inserted = await db.query(
        `INSERT INTO orders (client_id, conversation_id, items_json, subtotal_bdt, delivery_charge_bdt, total_bdt, advance_required_bdt, customer_name, customer_phone, customer_address, payment_status, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'confirmed', $11)
         ON CONFLICT (client_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          client.id,
          conv.id,
          JSON.stringify(itemsJson),
          subtotal,
          deliveryCharge,
          total,
          paymentCfg.advanceBdt,
          details.name,
          details.phone,
          details.address,
          idempotencyKey,
        ]
      );
      let order = inserted.rows[0];
      let created = true;
      if (!order) {
        const existing = await db.query(
          'SELECT * FROM orders WHERE client_id = $1 AND idempotency_key = $2 LIMIT 1',
          [client.id, idempotencyKey]
        );
        order = existing.rows[0];
        created = false;
        if (!order) {
          await db.query('ROLLBACK');
          console.warn('[widget-order] idempotency conflict but no existing row for key', idempotencyKey);
          return { status: 'error' };
        }
        // Idempotent retry: nothing changed in this transaction
        // (the first order already decremented the stock), so end
        // it without committing anything.
        await db.query('ROLLBACK');
        const lang = detectCustomerLanguage(text);
        const replyText = this.confirmationReply(lang, order, product, quantity, total, true, paymentCfg);
        return { status: 'already_exists', order, replyText, modelUsed: 'order:already-exists' };
      }
      if (productId !== null && stock !== null) {
        const decremented = await db.query(
          `UPDATE products SET stock = stock - $1
           WHERE id = $2 AND client_id = $3 AND stock >= $1
           RETURNING stock`,
          [quantity, productId, client.id]
        );
        if (decremented.rowCount === 0) {
          // Stock moved under us between the snapshot check and the
          // insert (a concurrent order took it): roll the order back
          // and report the real current stock.
          const current = await db.query(
            'SELECT stock FROM products WHERE id = $1 AND client_id = $2',
            [productId, client.id]
          );
          const currentStock = current.rows[0] ? Number(current.rows[0].stock) : 0;
          await db.query('ROLLBACK');
          if (currentStock <= 0) {
            return {
              status: 'out_of_stock',
              product,
              replyText: buildOutOfStockReply(text, product, products),
              modelUsed: 'order:out-of-stock',
            };
          }
          return {
            status: 'out_of_stock',
            product,
            replyText: this.lowStockReply(text, product, currentStock, quantity, products),
            modelUsed: 'order:out-of-stock',
          };
        }
      }
      // Created path only: the visitor's lead becomes a confirmed
      // order — status 'confirmed', stage 'won' — so the leads board
      // reflects the sale at order time (the re-analyze mapping
      // status confirmed → stage won was unreachable via orders
      // before this). No matching lead row = a no-op update.
      if (conv.platform && conv.platform_user_id) {
        await db.query(
          `UPDATE leads SET status='confirmed', stage='won', updated_at=NOW()
           WHERE client_id=$1 AND platform=$2 AND platform_user_id=$3`,
          [client.id, conv.platform, conv.platform_user_id]
        );
      }
      await db.query('COMMIT');
      // ORDER_CREATED (item-3): emitted only for a genuinely created
      // order, after the commit — never for a double confirm.
      // Best-effort: a failed broadcast must never fail the order.
      if (this.onOrderCreated) {
        try {
          await this.onOrderCreated(order);
        } catch (err: any) {
          console.warn('[widget-order] ORDER_CREATED broadcast failed:', err?.message || err);
        }
      }
      const lang = detectCustomerLanguage(text);
      const replyText = this.confirmationReply(lang, order, product, quantity, total, false, paymentCfg);
      return { status: 'created', order, replyText, modelUsed: 'order:created' };
    } catch (err: any) {
      // A failed insert/decrement must never become a false
      // confirmation: no order, no "order placed" reply — the
      // normal reply chain handles the message and the customer can
      // confirm again (idempotency makes the retry safe).
      if (db) {
        try {
          await db.query('ROLLBACK');
        } catch {
          // Already rolled back / connection dead — nothing to do.
        }
      }
      console.warn('[widget-order] order insert failed:', err?.message || err);
      return { status: 'error' };
    } finally {
      if (db) db.release();
    }
  }

  /**
   * Dhaka zone for the delivery charge. `extractCustomerDetails`
   * stops an address at the first comma ("House 12, Road 5,
   * Dhanmondi, Dhaka" → "House 12"), so the zone is decided from
   * the full address as the customer typed it — the text after the
   * address keyword in the message the address came from — not from
   * the truncated extraction alone.
   */
  private isInsideDhaka(
    address: string,
    text: string,
    userHistory: Array<{ role: string; content: string }>
  ): boolean {
    const haystacks = [address, addressSnippet(text)];
    for (const h of [...userHistory].reverse()) {
      haystacks.push(addressSnippet(h.content || ''));
    }
    return haystacks.some((s) => /(dhaka|ঢাকা)/i.test(s));
  }

  private confirmationReply(
    lang: 'bn' | 'banglish' | 'en' | 'hi',
    order: any,
    product: ProductItem,
    quantity: number,
    total: number,
    alreadyExists: boolean,
    paymentCfg?: PaymentConfig
  ): string {
    const totalStr = lang === 'bn' ? `৳${toBengaliDigits(total)}` : `৳${total}`;
    const line = `${product.name} x ${quantity}`;
    // The payment step, quoted from the shop's real config: advance
    // amount + number, or nothing when the shop never configured it
    // (an empty line is never appended — no invented method).
    const payLine = paymentCfg
      ? paymentLineForConfirmation(paymentCfg, total, lang === 'hi' ? 'hiRoman' : lang)
      : '';
    const pay = payLine ? ` ${payLine}` : '';
    if (alreadyExists) {
      if (lang === 'bn') {
        return `আপনার অর্ডারটি ইতিমধ্যে কনফার্ম হয়েছে — অর্ডার নম্বর #${order.id} (${line}, মোট ${totalStr})। নতুন করে অর্ডার করা হয়নি।${pay}`;
      }
      if (lang === 'banglish') {
        return `Apnar order-ta agei confirm hoye geche — order number #${order.id} (${line}, mot ${totalStr}). Notun kore order kora hoy ni.${pay}`;
      }
      if (lang === 'hi') {
        return `Aapka order pehle se confirm hai — order number #${order.id} (${line}, kul ${totalStr})। Dobara order nahi kiya gaya hai.${pay}`;
      }
      return `Your order is already confirmed — order #${order.id} (${line}, total ${totalStr}). No duplicate order was placed.${pay}`;
    }
    if (lang === 'bn') {
      return `আপনার অর্ডারটি কনফার্ম হয়েছে! অর্ডার নম্বর #${order.id} — ${line}, মোট ${totalStr} (ডেলিভারি চার্জ সহ)। শীঘ্রই ডেলিভারি করা হবে।${pay}`;
    }
    if (lang === 'banglish') {
      return `Apnar order confirm hoye geche! Order number #${order.id} — ${line}, mot ${totalStr} (delivery charge shoho). Shighroi delivery kora hobe.${pay}`;
    }
    if (lang === 'hi') {
      return `Aapka order confirm ho gaya hai! Order number #${order.id} — ${line}, kul ${totalStr} (delivery charge sahit)। Jald hi delivery ki jayegi.${pay}`;
    }
    return `Your order is confirmed! Order #${order.id} — ${line}, total ${totalStr} (including delivery charge). It will be delivered soon.${pay}`;
  }

  /**
   * Fewer in stock than ordered (but not zero): the responder has no
   * branch for this, so the wording is new here — the count comes
   * from the catalog, never invented, and an in-stock alternative is
   * offered from the same source as the out-of-stock reply.
   */
  private lowStockReply(
    text: string,
    product: ProductItem,
    stock: number,
    quantity: number,
    products: ProductItem[]
  ): string {
    const lang = detectCustomerLanguage(text);
    const alt = findInStockAlternative(products, product);
    const altName = alt ? ` ${alt.name} (${alt.price_bdt} BDT)` : '';
    if (lang === 'bn') {
      return `দুঃখিত, ${product.name} মাত্র ${stock}টি স্টকে আছে — আপনি ${quantity}টি চেয়েছেন। ${stock}টি দিয়ে অর্ডার করতে চাইলে "confirm ${stock}" লিখুন, অথবা${altName ? ` এর বদলে ${altName} নিতে পারেন।` : ' অন্য কোনো প্রোডাক্ট বেছে নিন।'}`;
    }
    if (lang === 'banglish') {
      return `Dukkhito, ${product.name} matro ${stock}ta stock e ache — apni ${quantity}ta cheyechen. ${stock}ta diye order korte chaile "confirm ${stock}" likhun, othoba${altName ? ` er bodle ${altName} nite paren.` : ' onno kono product beche nin.'}`;
    }
    if (lang === 'hi') {
      return `Maaf kijiye, ${product.name} sirf ${stock} hi stock mein hai — aapne ${quantity} manga hai. ${stock} ke saath order karna ho to "confirm ${stock}" likhein, ya${altName ? ` iske bajay ${altName} le sakte hain.` : ' koi aur product chun lein.'}`;
    }
    return `Sorry, only ${stock} of ${product.name} ${stock === 1 ? 'is' : 'are'} in stock — you asked for ${quantity}. Reply "confirm ${stock}" to order ${stock}, or${altName ? ` take ${altName} instead.` : ' choose another product.'}`;
  }
}

/** Explicit confirmation words (word-boundaried, all 4 languages). */
const CONFIRM_RE =
  /(?:^|[^\p{L}\p{M}\p{N}_])(confirm|confirmed|yes|yeah|ok|okay|haa+|ha|done|thik|ঠিক|হ্যাঁ|হ্যা|হে|হুম|আচ্ছা|দাও|নিলাম|confirm korlam|kore dao|করে দিন)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;

/** Order-intent words (same vocabulary as the responder's order branch). */
const ORDER_INTENT_RE =
  /(?:^|[^\p{L}\p{M}\p{N}_])(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;

/**
 * Repeat-order words (2026-11-16 scenario audit #4): the customer
 * explicitly wants ANOTHER order of the same thing in the same
 * conversation ("আরেকটা কিটক্যাট কিনতে চাই"). Only these words open a
 * new order — a bare second confirm is a double-tap/retry and must
 * return the existing order, not a new row.
 */
const REPEAT_ORDER_RE =
  /(?:^|[^\p{L}\p{M}\p{N}_])(আরেকটা|আরেকটি|আরেকবার|আরো|আরও|আবার|another|one more|নতুন অর্ডার|new order)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;

/**
 * Text after the address keyword in one message (to end of line,
 * max 200 chars) — the customer's full address as typed, used only
 * for the Dhaka-zone decision. Empty when the message carries no
 * address keyword.
 */
function addressSnippet(message: string): string {
  const m = String(message || '').match(
    /(?:deliver to|address(?: is|:)?|ঠিকানা|thikana)\s*:?\s*([^\n।]{3,200})/i
  );
  return m ? m[1].trim() : '';
}
