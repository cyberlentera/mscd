// SecretBox of the api and worker (build plan D-09, F.11): secrets sealed with `platform.key`, each bound by its
// additional authenticated data to a purpose and an owner: `mfa:<userId>` (TOTP secrets), `idp:<providerId>` (IdP
// client secrets), `pkce:<transactionId>` (PKCE verifiers). Token MACs (calendar feed, redirect tokens) use keys
// derived from the same KEK per purpose. Tenant data keys and repository credentials are sealed with
// `storage.key` by the storage gateway, never here.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type FileKeyProvider } from './file-key-provider';

/** Injection token of the `platform.key` provider (`FileKeyProvider`). */
export const PLATFORM_KEY_PROVIDER = Symbol.for('mscd.platformKeyProvider');

/** Additional data of the secrets sealed with `platform.key` (F.11). */
export type SecretBinding =
  | { purpose: 'mfa'; userId: string }
  | { purpose: 'idp'; providerId: string }
  | { purpose: 'pkce'; transactionId: string };

/** The additional authenticated data string of a binding: `<purpose>:<owner id>`. */
export function secretAad(binding: SecretBinding): string {
  switch (binding.purpose) {
    case 'mfa':
      return `mfa:${binding.userId}`;
    case 'idp':
      return `idp:${binding.providerId}`;
    case 'pkce':
      return `pkce:${binding.transactionId}`;
  }
}

@Injectable()
export class SecretBox {
  constructor(@Inject(PLATFORM_KEY_PROVIDER) private readonly keys: FileKeyProvider) {}

  /** Id of the current `platform.key`. */
  get kekId(): string {
    return this.keys.kekId;
  }

  async seal(plain: string | Buffer, binding: SecretBinding): Promise<string> {
    return this.keys.wrap(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain, secretAad(binding));
  }

  async open(sealed: string, binding: SecretBinding): Promise<Buffer> {
    return this.keys.unwrap(sealed, secretAad(binding));
  }

  async openText(sealed: string, binding: SecretBinding): Promise<string> {
    return (await this.open(sealed, binding)).toString('utf8');
  }

  /** True when the value was sealed with a previous `platform.key` (re-seal it with `keys rewrap`). */
  needsRewrap(sealed: string): boolean {
    return this.keys.needsRewrap(sealed);
  }

  /** HMAC-SHA256 of `data` (hex) with the key of a purpose, for example `calendar` or `redirect`. */
  mac(purpose: string, data: string): string {
    return createHmac('sha256', this.keys.macKey(purpose)).update(data, 'utf8').digest('hex');
  }

  /** Constant-time check of a MAC made by `mac`. */
  verifyMac(purpose: string, data: string, mac: string): boolean {
    const expected = Buffer.from(this.mac(purpose, data), 'hex');
    const given = /^[0-9a-f]{64}$/i.test(mac) ? Buffer.from(mac, 'hex') : Buffer.alloc(0);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
