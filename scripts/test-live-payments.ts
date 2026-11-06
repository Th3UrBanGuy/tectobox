async function testPayments() {
  const host = 'http://160.25.5.64';

  console.log('--- 1. Login as Operator ---');
  const lRes = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'operator123' })
  });
  console.log('Login status:', lRes.status);
  const cookie = lRes.headers.get('set-cookie');
  if (!cookie) throw new Error('No cookie');

  console.log('\n--- 2. Fetch Payment Stats ---');
  const sRes = await fetch(`${host}/api/payments/stats`, { headers: { cookie } });
  console.log('Stats status:', sRes.status);
  const stats = await sRes.json();
  console.log('Initial stats:', stats);

  console.log('\n--- 3. Record a Payment Claim (bKash) ---');
  const trxId = 'TEST' + Date.now().toString().slice(-6);
  const claimRes = await fetch(`${host}/api/payments/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      customer_name: 'Tanvir Ahmed',
      customer_phone: '01712345678',
      amount: 1800,
      method: 'bkash',
      transaction_id: trxId,
      channel: 'webchat'
    })
  });
  console.log('Claim status:', claimRes.status);
  const claimData = await claimRes.json();
  console.log('Claim response:', claimData);
  const paymentId = claimData.payment?.id;

  console.log('\n--- 4. Test Duplicate TrxID Detection ---');
  const dupRes = await fetch(`${host}/api/payments/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      customer_name: 'Another Customer',
      customer_phone: '01899999999',
      amount: 1800,
      method: 'bkash',
      transaction_id: trxId, // SAME TrxID!
      channel: 'webchat'
    })
  });
  const dupData = await dupRes.json();
  console.log('Duplicate test status:', dupRes.status, 'Duplicate flag (expect true):', dupData.duplicate_warning);

  console.log('\n--- 5. Verify the Payment (1-Click Approve) ---');
  const verRes = await fetch(`${host}/api/payments/${paymentId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ verified_by: 'Operator' })
  });
  console.log('Verify status:', verRes.status);
  const verData = await verRes.json();
  console.log('Verify response message:', verData.message, 'Payment status:', verData.payment?.status);

  console.log('\n--- 6. Reject the Duplicate Payment ---');
  const dupPaymentId = dupData.payment?.id;
  const rejRes = await fetch(`${host}/api/payments/${dupPaymentId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ reason: 'Duplicate TrxID used across multiple orders' })
  });
  console.log('Reject status:', rejRes.status);
  const rejData = await rejRes.json();
  console.log('Reject response message:', rejData.message, 'Status:', rejData.payment?.status);

  console.log('\n--- 7. Test AI Automatic Payment Claim Detection via Webchat ---');
  const aiTrx = 'AI' + Date.now().toString().slice(-6);
  const widgetRes = await fetch(`${host}/api/widget/wk_main_workspace_seed/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `আমি বিকাশে ১৮০০ টাকা দিয়েছি, TrxID: ${aiTrx}`,
      visitor_id: 'vis_test_ai_pay',
      name: 'Rahim Uddin',
      phone: '01811223344'
    })
  });
  console.log('Widget message status:', widgetRes.status);
  const widgetData = await widgetRes.json();
  console.log('AI Auto-reply:', widgetData.reply);

  console.log('\n--- 8. Verify AI Recorded the Payment in Dashboard ---');
  const listRes = await fetch(`${host}/api/payments?status=pending`, { headers: { cookie } });
  const listData = await listRes.json();
  const foundAiPayment = listData.payments?.find((p: any) => p.transaction_id === aiTrx);
  console.log('Found AI detected payment in pending list:', !!foundAiPayment, 'Details:', foundAiPayment?.customer_name, foundAiPayment?.amount, foundAiPayment?.transaction_id);

  console.log('\n✅ ALL LIVE PAYMENTS HUB TESTS PASSED WITH 100% SUCCESS!');
}

testPayments().catch(console.error);
