import { describe, expect, it } from 'vitest';
import { isNonPublicAddress } from '../../../src/modules/identity/oidc/discovery';

// Issuer discovery in multi-tenant mode refuses these addresses (SSRF guard).
describe('isNonPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1'])('refuses %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });
  it.each(['8.8.8.8', '20.190.128.1', '2606:4700::1111', '::ffff:1.1.1.1'])('allows %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});
