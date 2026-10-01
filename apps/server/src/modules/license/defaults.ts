// Default provider of LICENCE_GATE (build plan B.4, WP-08): permissive. Every write is allowed, no user, system or
// feature limit applies and every storage adapter counts as licensed, until WP-12 registers the real gate (D-15,
// BR-37, LIC-USERS, LIC-MS, LIC-FEATURE).
import { Injectable } from '@nestjs/common';
import type { LicenceGate } from '../../common/tokens';

@Injectable()
export class PermissiveLicenceGate implements LicenceGate {
  async assertWritable(): Promise<void> {}

  async assertCanAddUser(): Promise<void> {}

  async assertCanAddMs(): Promise<void> {}

  async assertFeature(): Promise<void> {}

  async isAdapterLicensed(): Promise<boolean> {
    return true;
  }
}
