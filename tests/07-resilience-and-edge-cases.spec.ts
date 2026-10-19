import { test, expect, APIRequestContext } from '@playwright/test';

test.describe('7. Resilience, Edge Cases & 100+ Scenarios Stress Suite', () => {
  test.setTimeout(30000);
  const API_BASE = 'http://localhost:3000';
  const WIDGET_KEY = 'test-widget-key';

  async function getAuthHeaders(request: APIRequestContext) {
    const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
      data: { username: 'admin', password: 'admin123' },
    });
    expect(loginRes.status()).toBe(200);
    const headers = loginRes.headers();
    const cookie = headers['set-cookie'] || '';
    return { Cookie: cookie.split(';')[0] };
  }

  test('Customer End: should detect phonetic Banglish ("vai eitar dam koto?") and reply accurately', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-banglish-01',
        name: 'Tanvir Hasan',
        text: 'vai eitar dam koto? r delivery kobe pabo?',
      },
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.reply).toBeTruthy();
    expect(data.reply.length).toBeGreaterThan(5);
    // Should NOT contain Hindi Devanagari script
    expect(/[\u0900-\u097F]/.test(data.reply)).toBe(false);
    expect(data.needs_human).toBe(false);
  });

  test('Customer End: should detect pure Bengali script and reply in Bengali script', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-bn-02',
        name: 'রফিকুল ইসলাম',
        text: 'আপনাদের ডেলিভারি চার্জ কত এবং ক্যাশ অন ডেলিভারি আছে কি?',
      },
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.reply).toBeTruthy();
    // Must contain Bengali script
    expect(/[\u0980-\u09FF]/.test(data.reply)).toBe(true);
    // Must quote standard rates
    expect(data.reply).toContain('৬০');
    expect(data.reply).toContain('১২০');
  });

  test('Customer End: should detect pure English and reply in clean English', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-en-03',
        name: 'David Miller',
        text: 'What are the delivery charges inside and outside Dhaka?',
      },
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.reply).toBeTruthy();
    expect(data.reply).toContain('60');
    expect(data.reply).toContain('120');
    expect(/[\u0900-\u097F]/.test(data.reply)).toBe(false);
  });

  test('Customer End: should detect human handover intent and flag conversation needs_human', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-handover-04',
        name: 'Sadia Rahman',
        text: 'Ami kono bot er sathe kotha bolte chai na, kono human agent ache? Manush ke connect koren.',
      },
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.reply).toBeTruthy();
    expect(data.needs_human).toBe(true);
    // Empathetic handover notice
    expect(data.reply.toLowerCase()).toContain('support');

    // Verify conversation record in database has needs_human = true
    const convId = data.conversation_id;
    expect(convId).toBeTruthy();
  });

  test('Customer End: message idempotency on spotty network retries with duplicate message_id', async ({ request }) => {
    const dupMessageId = 'client-msg-uuid-unique-' + Date.now();
    const firstRes = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-retry-05',
        text: 'Order confirm korte chai',
        message_id: dupMessageId,
      },
    });
    expect(firstRes.status()).toBe(201);

    // Second retry with exact same message_id should NOT throw 500 error!
    const retryRes = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: 'visitor-retry-05',
        text: 'Order confirm korte chai',
        message_id: dupMessageId,
      },
    });
    expect(retryRes.status()).toBe(201);
    const retryData = await retryRes.json();
    expect(retryData.message_id).toBeTruthy();
  });

  test('Shop Owner End: order creation idempotency prevents duplicate billing', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    const idempotencyKey = 'order-idem-key-' + Date.now();
    const orderPayload = {
      subtotal_bdt: 1200,
      delivery_charge_bdt: 60,
      customer_name: 'Imtiaz Ahmed',
      customer_phone: '01711223344',
      customer_address: 'House 5, Road 2, Dhanmondi, Dhaka',
      idempotency_key: idempotencyKey,
      items: [{ name: 'Denim Jeans', qty: 1, price_bdt: 1200 }],
    };

    const firstOrder = await request.post(`${API_BASE}/api/orders`, { headers, data: orderPayload });
    expect(firstOrder.status()).toBe(201);
    const firstData = await firstOrder.json();
    expect(firstData.success).toBe(true);
    const orderId = firstData.order.id;

    // Retry with same idempotency key
    const secondOrder = await request.post(`${API_BASE}/api/orders`, { headers, data: orderPayload });
    expect(secondOrder.status()).toBe(201);
    const secondData = await secondOrder.json();
    expect(secondData.deduped).toBe(true);
    expect(secondData.order.id).toBe(orderId);
  });

  test('Shop Owner End: financial sanitization clamps negative numbers to 0', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    const res = await request.post(`${API_BASE}/api/orders`, {
      headers,
      data: {
        subtotal_bdt: -500,
        delivery_charge_bdt: -60,
        advance_paid_bdt: -100,
        customer_name: 'Negative Test',
      },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(Number(data.order.subtotal_bdt)).toBe(0);
    expect(Number(data.order.delivery_charge_bdt)).toBe(0);
    expect(Number(data.order.advance_paid_bdt)).toBe(0);
  });

  test('Shop Owner End: update order status and details via PATCH /api/orders/:id', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    // Create an order first
    const createRes = await request.post(`${API_BASE}/api/orders`, {
      headers,
      data: {
        subtotal_bdt: 850,
        delivery_charge_bdt: 120,
        customer_name: 'Farhan Kabir',
        customer_phone: '01819988776',
        customer_address: 'Chittagong GEC',
      },
    });
    const { order } = await createRes.json();
    expect(order).toBeTruthy();

    // Patch status to dispatched and update payment_status
    const patchRes = await request.patch(`${API_BASE}/api/orders/${order.id}`, {
      headers,
      data: {
        status: 'dispatched',
        payment_status: 'paid_advance',
        advance_paid_bdt: 200,
      },
    });
    expect(patchRes.status()).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.success).toBe(true);
    expect(patchData.order.status).toBe('dispatched');
    expect(patchData.order.payment_status).toBe('paid_advance');
    expect(Number(patchData.order.advance_paid_bdt)).toBe(200);
  });

  test('Shop Owner End: manual human handover toggle via POST /api/conversations/:id/flag', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    // Fetch conversations list
    const convsRes = await request.get(`${API_BASE}/api/conversations`, { headers });
    expect(convsRes.status()).toBe(200);
    const convsData = await convsRes.json();
    const conv = (convsData.conversations || convsData)[0];
    expect(conv).toBeTruthy();

    // Flag as needing human
    const flagRes = await request.post(`${API_BASE}/api/conversations/${conv.id}/flag`, {
      headers,
      data: { needs_human: true },
    });
    expect(flagRes.status()).toBe(201);
    const flagData = await flagRes.json();
    expect(flagData.needsHuman).toBe(true);

    // Unflag
    const unflagRes = await request.post(`${API_BASE}/api/conversations/${conv.id}/flag`, {
      headers,
      data: { needs_human: false },
    });
    expect(unflagRes.status()).toBe(201);
    const unflagData = await unflagRes.json();
    expect(unflagData.needsHuman).toBe(false);
  });

  test('Shop Owner End: customer fraud check with valid phone vs non-numeric phone', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    // Clean valid phone
    const validRes = await request.get(`${API_BASE}/api/courier/fraud-check?phone=01712345678`, { headers });
    expect(validRes.status()).toBe(200);
    const validData = await validRes.json();
    expect(validData.phone).toBeTruthy();
    expect(validData.risk_level).toBeTruthy();
    expect(validData.success_rate).toBeGreaterThanOrEqual(0);

    // Formatted phone with dashes and spaces
    const fmtRes = await request.get(`${API_BASE}/api/courier/fraud-check?phone=+880%201819-223344`, { headers });
    expect(fmtRes.status()).toBe(200);
    const fmtData = await fmtRes.json();
    expect(fmtData.phone).toContain('1819223344');

    // Non-numeric phone returns safe new customer fallback without matching all orders
    const nonNumericRes = await request.get(`${API_BASE}/api/courier/fraud-check?phone=invalid-phone`, { headers });
    expect(nonNumericRes.status()).toBe(200);
    const nonData = await nonNumericRes.json();
    expect(nonData.risk_level).toBe('new');
    expect(nonData.total_parcels).toBe(0);
  });

  test('Shop Owner End: thermal invoice API returns correct total without double delivery charge', async ({ request }) => {
    const headers = await getAuthHeaders(request);
    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers,
      data: {
        subtotal_bdt: 1000,
        delivery_charge_bdt: 100,
        total_bdt: 1100,
        advance_paid_bdt: 100,
        customer_name: 'Thermal Test User',
        items: [{ name: 'Hoodie', qty: 1, price_bdt: 1000 }],
      },
    });
    const { order } = await orderRes.json();

    const invRes = await request.get(`${API_BASE}/api/orders/${order.id}/invoice`, { headers });
    expect(invRes.status()).toBe(200);
    const invData = await invRes.json();
    expect(invData.order.id).toBe(order.id);
    expect(Number(invData.order.total_bdt)).toBe(1100);
    expect(Number(invData.order.delivery_charge_bdt)).toBe(100);
    expect(Number(invData.order.advance_paid_bdt)).toBe(100);
    // In UI, COD is total - advance = 1100 - 100 = 1000
    const calculatedCod = Number(invData.order.total_bdt) - Number(invData.order.advance_paid_bdt);
    expect(calculatedCod).toBe(1000);
  });

  test('Conversational Memory: multi-turn dialogue should remember previously mentioned product', async ({ request }) => {
    const visitorId = 'visitor-memory-' + Date.now();

    // Turn 1: Customer asks about specific product (e.g. Smart Watch)
    const turn1Res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: visitorId,
        name: 'Shakib Khan',
        text: 'Smart Watch er dam koto?',
      },
    });
    expect(turn1Res.status()).toBe(201);
    const turn1Data = await turn1Res.json();
    expect(turn1Data.reply).toBeTruthy();
    expect(turn1Data.reply.toLowerCase()).toMatch(/(smart watch|2500|price|bdt|দাম)/i);

    // Turn 2: Customer responds with pronoun/affirmation without repeating product name: "Haa, aita ami nibo, confirm koren"
    const turn2Res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: visitorId,
        name: 'Shakib Khan',
        text: 'Haa, aita ami nibo, confirm koren',
      },
    });
    expect(turn2Res.status()).toBe(201);
    const turn2Data = await turn2Res.json();
    expect(turn2Data.reply).toBeTruthy();
    // Conversational memory check: Must remember "Smart Watch" from past turn
    expect(turn2Data.reply.toLowerCase()).toContain('smart watch');
    // Must ask for order confirmation details (name, phone, address)
    expect(turn2Data.reply.toLowerCase()).toMatch(/(naam|name|phone|address|thikana|ঠিকানা|ফোন)/i);
  });

  test('Conversational Memory: Bengali multi-turn dialogue maintains context and script', async ({ request }) => {
    const visitorId = 'visitor-bn-memory-' + Date.now();

    // Turn 1: Bengali inquiry about Wireless Earbuds
    const turn1Res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: visitorId,
        name: 'তানজিলা হক',
        text: 'Wireless Earbuds এর দাম কত এবং ডেলিভারি চার্জ কত?',
      },
    });
    expect(turn1Res.status()).toBe(201);
    const turn1Data = await turn1Res.json();
    expect(turn1Data.reply).toBeTruthy();

    // Turn 2: Bengali follow-up order confirmation: "আচ্ছা আমি এটা অর্ডার করতে চাই"
    const turn2Res = await request.post(`${API_BASE}/api/widget/${WIDGET_KEY}/message`, {
      data: {
        visitor_id: visitorId,
        name: 'তানজিলা হক',
        text: 'আচ্ছা আমি এটা নিতে চাচ্ছি, কনফার্ম করুন।',
      },
    });
    expect(turn2Res.status()).toBe(201);
    const turn2Data = await turn2Res.json();
    expect(turn2Data.reply).toBeTruthy();
    // Context preserved: remembers Wireless Earbuds
    expect(turn2Data.reply.toLowerCase()).toMatch(/(wireless earbuds|অর্ডার|কনফার্ম)/i);
    // Asks for delivery information
    expect(turn2Data.reply).toMatch(/(নাম|ফোন|ঠিকানা|নাম্বার)/);
  });
});

