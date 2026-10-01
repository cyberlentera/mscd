// Vitest global setup for the OIDC and SAML suites, enabled with MSCD_TEST_SSO=1 (build plan J.1, J.2).
// Stub from WP-03: WP-16 starts keycloak/keycloak:26.7.5 with the realm of deploy/compose/dev/keycloak here.
export async function setup(): Promise<void> {}

export async function teardown(): Promise<void> {}
