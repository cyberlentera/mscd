// Portfolio card counts of a system (build plan UI 2.8, UI 2.5 nav badges, UI 4.7 reference numbers).
import type { MsBundle } from '@mscd/shared';
import { isUnverifiable } from './integrity';

export interface PortfolioCounts {
  requirements: number;
  evidence: number;
  documents: number;
  chainItems: number;
  /** Chain items that are overdue or missing (the chain nav badge). */
  notPending: number;
  gateItems: number;
  /** Evidence in band `critical` (the freshness nav badge). */
  criticalEvidence: number;
  /** Evidence that cannot be verified (A.4 5.13, separate from critical evidence). */
  unverifiableEvidence: number;
  expiredDocuments: number;
  /** Chain items due after the next audit. */
  afterAudit: number;
}

/** Card statistics and nav counts of one system's bundle. */
export function portfolioCounts(bundle: Pick<MsBundle, 'reqs' | 'docs' | 'evs' | 'chain' | 'gates'>): PortfolioCounts {
  return {
    requirements: bundle.reqs.length,
    evidence: bundle.evs.length,
    documents: bundle.docs.length,
    chainItems: bundle.chain.items.length,
    notPending: bundle.chain.items.filter((i) => i.st !== 'pending').length,
    gateItems: bundle.gates.length,
    criticalEvidence: criticalEvidence(bundle.evs),
    unverifiableEvidence: unverifiableEvidence(bundle.evs),
    expiredDocuments: bundle.docs.filter((d) => d.st === 'expired').length,
    afterAudit: bundle.chain.items.filter((i) => i.after).length,
  };
}

/** A.4 5.13: evidence whose freshness band is `critical`. */
export function criticalEvidence(evs: MsBundle['evs']): number {
  return evs.filter((e) => e.fresh === 'critical').length;
}

/** A.4 5.13: evidence whose file cannot be verified (changed, moved, missing, revoked). */
export function unverifiableEvidence(evs: MsBundle['evs']): number {
  return evs.filter((e) => isUnverifiable(e.integ)).length;
}
