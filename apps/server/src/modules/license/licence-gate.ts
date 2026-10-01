// The real `LICENCE_GATE` (D-15, BR-37): read-only mode after grace, the user and management system limits, licensed
// features and storage adapters. Every entitlement comes from the verified current licence; an organisation without
// a licence may write (nothing has expired) but has no entitlements, except that its first member can be added so
// a Tenant Admin exists to install the licence (`admin create-user` before the first upload).
import { Injectable } from '@nestjs/common';
import type { LicenceFeature, StorageAdapter } from '@mscd/shared';
import { BusinessRuleError, ReadOnlyModeError } from '../../common/problems';
import type { LicenceGate, Trx } from '../../common/tokens';
import { FEATURE_LABELS, LicenceService } from './licence.service';

/** Active members an organisation may have before any licence is installed (its first Tenant Admin). */
export const UNLICENSED_MEMBER_ALLOWANCE = 1;

@Injectable()
export class LicenceGateService implements LicenceGate {
  constructor(private readonly licences: LicenceService) {}

  /** 403 `read-only-mode` (BR-37) when the current licence is past grace or cannot be verified. */
  async assertWritable(orgId: string): Promise<void> {
    const evaluated = await this.licences.evaluateOrg(orgId);
    if (evaluated?.state === 'read_only') throw new ReadOnlyModeError();
  }

  /** 422 `LIC-USERS` when one more active non-guest member would exceed `max_users` (D-15). Locks the count. */
  async assertCanAddUser(trx: Trx, orgId: string): Promise<void> {
    await this.licences.lockLimit(trx, orgId, 'users');
    const evaluated = await this.licences.evaluate(trx, orgId);
    const count = await this.licences.countActiveUsers(trx, orgId);
    if (!evaluated) {
      if (count < UNLICENSED_MEMBER_ALLOWANCE) return;
      throw new BusinessRuleError('LIC-USERS', {
        en: 'No licence is installed for this organisation. Install a licence before adding more users.',
        id: 'Belum ada lisensi yang terpasang untuk organisasi ini. Pasang lisensi sebelum menambah pengguna.',
      }, undefined, { messageKey: 'licence.no_licence' });
    }
    const max = evaluated.verified && evaluated.document ? evaluated.document.max_users : 0;
    if (count >= max) {
      throw new BusinessRuleError('LIC-USERS', {
        en: `The licence allows ${max} active users and this organisation already has ${count}. Ask for a licence with more users.`,
        id: `Lisensi mengizinkan ${max} pengguna aktif dan organisasi ini sudah memiliki ${count}. Mintalah lisensi dengan lebih banyak pengguna.`,
      }, undefined, { messageKey: 'licence.max_users' });
    }
  }

  /** 422 `LIC-MS` when one more management system would exceed `max_management_systems` (D-15, A-15). */
  async assertCanAddMs(trx: Trx, orgId: string): Promise<void> {
    await this.licences.lockLimit(trx, orgId, 'management_systems');
    const evaluated = await this.licences.evaluate(trx, orgId);
    const max = evaluated?.verified && evaluated.document ? evaluated.document.max_management_systems : 0;
    const count = await this.licences.countManagementSystems(trx);
    if (count >= max) {
      throw new BusinessRuleError('LIC-MS', {
        en: evaluated
          ? `The licence allows ${max} management systems and this organisation already has ${count}.`
          : 'No licence is installed for this organisation, so no management system can be created.',
        id: evaluated
          ? `Lisensi mengizinkan ${max} sistem manajemen dan organisasi ini sudah memiliki ${count}.`
          : 'Belum ada lisensi yang terpasang untuk organisasi ini, sehingga sistem manajemen belum dapat dibuat.',
      }, undefined, { messageKey: 'licence.max_management_systems' });
    }
  }

  /** 422 `LIC-FEATURE` when the licence does not include the feature (D-15). */
  async assertFeature(orgId: string, feature: LicenceFeature, trx?: Trx): Promise<void> {
    const evaluated = trx ? await this.licences.evaluate(trx, orgId) : await this.licences.evaluateOrg(orgId);
    if (this.licences.featureLicensed(evaluated, feature)) return;
    const label = FEATURE_LABELS[feature];
    throw new BusinessRuleError('LIC-FEATURE', {
      en: `The licence does not include ${label.en}.`,
      id: `Lisensi tidak mencakup ${label.id}.`,
    }, undefined, { messageKey: `licence.feature.${feature}` });
  }

  /** Whether the licence includes a storage adapter (TS 5.7); false without a verified licence. */
  async isAdapterLicensed(orgId: string, adapter: StorageAdapter): Promise<boolean> {
    return this.licences.adapterLicensed(await this.licences.evaluateOrg(orgId), adapter);
  }
}
