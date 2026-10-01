// Shared pieces of the evidence pack build and its read paths (build plan E.7, A-09, A-10, TS 5.4, TS 5.6).
import type { EvidencePackView, LinkStatus } from '@mscd/shared';

/** Link statuses whose files are copied into a pack (E.7 step 3, A-10); everything else is an exception. */
export const COPYABLE_STATUSES: ReadonlySet<string> = new Set<LinkStatus>(['intact', 'moved']);

/** The exception reason of a link status (A-10: everything except intact and moved, with the reason, TS 5.6). */
export function exceptionReason(status: string | null): string {
  switch (status) {
    case 'missing':
      return 'File missing at the pinned location';
    case 'version_changed':
      return 'The file changed after its version was pinned';
    case 'pinned_version_lost':
      return 'The pinned version is no longer available';
    case 'hash_mismatch':
      return 'The file content does not match its recorded hash';
    case 'access_denied':
      return 'Access to the file is denied';
    case 'verification_pending':
      return 'The file could not be verified';
    case null:
      return 'Recorded as a system link; there is no file to copy';
    default:
      return `The file is not intact (${status})`;
  }
}

/** Folder name of a pack: the event short label or the build date, without characters providers refuse. */
export function packLabel(label: string): string {
  const cleaned = label
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"*:<>?/\\|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return (cleaned || 'pack').slice(0, 80);
}

/** The folder of the Managed Vault packs, as for provider repositories rooted at `Compliance` (TS 5.4). */
export const VAULT_PACK_ROOT = 'Compliance';

/** Joins folder segments with `/` (empty segments dropped). */
export function joinFolder(...parts: (string | null | undefined)[]): string {
  return parts
    .flatMap((part) => (part ?? '').split('/'))
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .join('/');
}

/** `/Compliance/_packs/<MS code>/<label>/` from the root path of a repository (TS 5.4). */
export function packFolderPath(rootPath: string, msCode: string, label: string): string {
  return joinFolder(rootPath, '_packs', msCode, label);
}

/** The download URLs of a pack (D.2 `EvidencePackView.manifestUrls`, `archiveUrl`). */
export function packUrls(ms: string, packId: string, hasArchive: boolean): Pick<EvidencePackView, 'manifestUrls' | 'archiveUrl'> {
  const base = `/api/v1/ms/${encodeURIComponent(ms)}/evidence-packs/${packId}/download?file=`;
  return {
    manifestUrls: { pdf: `${base}manifest_pdf`, csv: `${base}manifest_csv` },
    ...(hasArchive ? { archiveUrl: `${base}archive` } : {}),
  };
}

/** The file name of a pack download. */
export function downloadName(msCode: string, folder: string | null, file: 'manifest_pdf' | 'manifest_csv' | 'archive'): string {
  const label = folder ? (folder.split('/').filter((s) => s !== '').pop() ?? 'pack') : 'pack';
  const base = `${msCode}-evidence-pack-${label}`.replace(/\s+/g, '-');
  return file === 'manifest_pdf' ? `${base}-manifest.pdf` : file === 'manifest_csv' ? `${base}-manifest.csv` : `${base}.tar.gz`;
}

export const MANIFEST_PDF_NAME = 'manifest.pdf';
export const MANIFEST_CSV_NAME = 'manifest.csv';
export const ARCHIVE_NAME = 'evidence-pack.tar.gz';
