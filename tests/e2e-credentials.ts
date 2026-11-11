// Shared e2e login credentials for the Playwright suites (C1).
//
// Passwords come from the environment only — no credential literal lives in
// any spec file. Required, depending on the suite:
//   E2E_ADMIN_PASSWORD, E2E_OPERATOR_PASSWORD, E2E_XYZ_PASSWORD
// The lookup is lazy (a function call at the login step), so merely
// collecting/listing the tests never throws.
export function e2ePassword(role: 'admin' | 'operator' | 'xyz'): string {
  const name =
    role === 'admin'
      ? 'E2E_ADMIN_PASSWORD'
      : role === 'operator'
        ? 'E2E_OPERATOR_PASSWORD'
        : 'E2E_XYZ_PASSWORD';
  const value = process.env[name];
  if (!value) {
    throw new Error(`[e2e] ${name} must be set in the environment to run the Playwright tests.`);
  }
  return value;
}
