/**
 * Shapes the licence service payload into the access object the
 * frontend already consumes (active / mode / features / credits /
 * license) plus the enforcement fields (aiAllowed / aiReason /
 * suspended / aiPaused).
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Moved verbatim from the controller's private
 * `toAccessResponse`; both the licenses and access controllers use
 * this one function so the shape can never drift between them.
 */
export function toAccessResponse(access: {
  mode: string;
  features: string[];
  aiAllowed: boolean;
  aiReason: any;
  license: any | null;
  suspended: boolean;
  aiPaused: boolean;
}) {
  const lic = access.license;
  return {
    active: access.mode === 'licensed',
    mode: access.mode,
    licenseId: lic?.id ?? null,
    code: lic?.code ?? null,
    features: access.features,
    creditsTotal: lic?.credits_total ?? 0,
    creditsUsed: lic?.credits_used ?? 0,
    license: lic
      ? {
          id: lic.id,
          code: lic.code,
          status: lic.status,
          kind: lic.kind,
          plan_id: lic.plan_id ?? null,
          plan_name: lic.plan_name || null,
          starts_at: lic.starts_at,
          ends_at: lic.ends_at,
          credits_total: lic.credits_total,
          credits_used: lic.credits_used,
          validity_days: lic.validity_days ?? null,
          features: lic.features,
        }
      : null,
    aiAllowed: access.aiAllowed,
    aiReason: access.aiReason,
    suspended: access.suspended,
    aiPaused: access.aiPaused,
  };
}
