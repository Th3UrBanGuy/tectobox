async function verify() {
  const host = 'http://160.25.5.64';
  
  // 1. Healthz
  const hRes = await fetch(`${host}/healthz`);
  const hData = await hRes.json();
  console.log('1. Healthz check:', hRes.status, hData);

  // 2. Welcome page
  const wRes = await fetch(`${host}/welcome`);
  const wHtml = await wRes.text();
  console.log('2. Welcome page check:', wRes.status, 'Has Bengali text:', wHtml.includes('সব কাস্টমার চ্যাট'), 'Has AI simulator (.sim-container):', wHtml.includes('sim-container'));

  // 3. Login page
  const aRes = await fetch(`${host}/app`);
  const aHtml = await aRes.text();
  console.log('3. App page check:', aRes.status, 'Has 2FA modal:', aHtml.includes('id="profile-modal"'), 'Has Password toggle:', aHtml.includes('btn-toggle-login-pwd'));

  // 4. Test admin login and profile retrieval
  const lRes = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  console.log('4. Admin login status:', lRes.status);
  const cookie = lRes.headers.get('set-cookie');
  
  if (cookie) {
    const pRes = await fetch(`${host}/api/auth/profile`, {
      headers: { cookie }
    });
    const profile = await pRes.json();
    console.log('5. Profile endpoint response:', profile);

    // 6. Test 2FA status endpoint
    const s2fa = await fetch(`${host}/api/auth/profile/2fa/status`, {
      headers: { cookie }
    });
    console.log('6. 2FA Status response:', await s2fa.json());
  }

  // 7. Test Operator restrictions:
  const opLogin = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'operator123' })
  });
  console.log('7. Operator login status:', opLogin.status);
  const opCookie = opLogin.headers.get('set-cookie');
  if (opCookie) {
    const opProfileRes = await fetch(`${host}/api/auth/profile`, {
      headers: { cookie: opCookie }
    });
    console.log('8. Operator profile:', await opProfileRes.json());

    // Try to change username as operator -> Must return 403 Forbidden!
    const tryChangeUser = await fetch(`${host}/api/auth/profile/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: opCookie },
      body: JSON.stringify({
        current_password: 'operator123',
        new_username: 'hacker_operator'
      })
    });
    console.log('9. Operator username change attempt status (expect 403):', tryChangeUser.status);
    console.log('   Response error message:', (await tryChangeUser.json()).error);

    // Try to change password as operator -> Must succeed (200 OK)!
    const tryChangePass = await fetch(`${host}/api/auth/profile/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: opCookie },
      body: JSON.stringify({
        current_password: 'operator123',
        new_password: 'operatorNewPass123'
      })
    });
    console.log('10. Operator password change status (expect 200):', tryChangePass.status);
    console.log('    Response message:', (await tryChangePass.json()).message);

    // Verify login with new password
    const testNewLogin = await fetch(`${host}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'operatorNewPass123' })
    });
    console.log('11. Login with new password status (expect 200):', testNewLogin.status);
    const newCookie = testNewLogin.headers.get('set-cookie');

    // Restore original password
    if (newCookie) {
      await fetch(`${host}/api/auth/profile/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: newCookie },
        body: JSON.stringify({
          current_password: 'operatorNewPass123',
          new_password: 'operator123'
        })
      });
      console.log('12. Reverted operator password back to operator123');
    }
  }
}

verify().catch(console.error);
