// Shared pieces of the file commands (build plan D.3 "Commands from the UI: files", D.5, BR-23, BR-29, BR-30,
// BR-35, BR-36): the rule messages, the repository checks before a gateway call, the mapping of gateway refusals to
// the D.3 answers, the scope root of a system, stored file names and version labels.
import type { BusinessRuleId, CommandResult, Messages, ObjectKind, ScopeRoot, StorageAdapter } from '@mscd/shared';
import { DependencyUnavailableError, ForbiddenError, NotFoundError, ProblemError } from '../../common/problems';
import type { RepositoryRow } from '../storage';
import { GatewayProblemError, GatewayUnavailableError } from '../storage';

export type Warning = NonNullable<CommandResult['warnings']>[number];

/** Rule texts of the spec digest (TS 8), in both languages. `{name}` is the repository name. */
const RULE_TEXT: Readonly<Partial<Record<BusinessRuleId, Messages>>> = {
  'BR-23': {
    en: 'This requirement is similar but not identical. Make sure this evidence really satisfies both.',
    id: 'Persyaratan ini mirip tetapi tidak identik. Pastikan bukti ini benar-benar memenuhi keduanya.',
  },
  'BR-29': {
    en: 'Repository {name} cannot be reached. Try again later or contact your administrator.',
    id: 'Repositori {name} tidak dapat dijangkau. Coba lagi nanti atau hubungi administrator Anda.',
  },
  'BR-30': {
    en: 'Files in personal storage can be lost when their owner leaves. Consider a shared library.',
    id: 'Berkas di penyimpanan pribadi dapat hilang ketika pemiliknya keluar. Pertimbangkan pustaka bersama.',
  },
  'BR-35': {
    en: "This file opens directly in {name} in line with your organisation's policy.",
    id: 'Berkas ini dibuka langsung di {name} sesuai kebijakan organisasi Anda.',
  },
  'BR-36': {
    en: 'The evidence date is later than the file creation date. Check the date again.',
    id: 'Tanggal bukti lebih lambat dari tanggal pembuatan berkas. Periksa kembali tanggalnya.',
  },
};

/** The rule text with the repository name filled in. */
export function ruleMessages(rule: BusinessRuleId, name = ''): Messages {
  const text = RULE_TEXT[rule];
  if (!text) throw new Error(`No text for ${rule}`);
  return { en: text.en.replace('{name}', name), id: text.id.replace('{name}', name) };
}

export function warning(rule: BusinessRuleId, name = ''): Warning {
  return { rule, messages: ruleMessages(rule, name) };
}

/** 422 BR-29: the repository cannot take or give files now (no silent fallback, TS 8.3). */
export function br29(repository: Pick<RepositoryRow, 'name'>, detail?: string): ProblemError {
  return new ProblemError('business-rule', {
    rule: 'BR-29',
    messages: ruleMessages('BR-29', repository.name),
    messageKey: 'files.repository_unavailable',
    ...(detail ? { detail } : {}),
  });
}

/** A 422 `business-rule` without a rule id, with a message key and both texts. */
export function refusal(messageKey: string, messages: Messages): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages, detail: messages.en });
}

/** 422: the item is not below the system's root folder of the repository (D.5 root enforcement). */
export function outsideRootError(): ProblemError {
  return refusal('files.outside_root', {
    en: "The file is not in this management system's folder of the repository.",
    id: 'Berkas tidak berada di folder sistem manajemen ini pada repositori.',
  });
}

/** 422: the provider item does not satisfy the upload intent (zero-transit checks of D.5). */
function itemRefused(): ProblemError {
  return refusal('files.item_refused', {
    en: 'The file in the repository does not match this upload: check the folder, the account and the file name.',
    id: 'Berkas di repositori tidak cocok dengan unggahan ini: periksa folder, akun, dan nama berkas.',
  });
}

/** What the api knows about the adapters of this installation and the licence (BR-29 inputs). */
export interface AdapterAvailability {
  enabled: readonly StorageAdapter[];
  isLicensed(adapter: StorageAdapter): Promise<boolean>;
}

/**
 * BR-29 before any gateway call: the repository's connection status is `ok`, it is not read-only (adapter left the
 * licence, TS 5.7), and its adapter is enabled in this installation and licensed.
 */
export async function assertRepositoryUsable(repository: RepositoryRow, adapters: AdapterAvailability): Promise<void> {
  if (repository.connection_status !== 'ok') throw br29(repository, `The repository connection is ${repository.connection_status}`);
  if (repository.read_only) throw br29(repository, 'The repository is read-only');
  if (!adapters.enabled.includes(repository.adapter)) throw br29(repository, `The ${repository.adapter} adapter is not enabled in this installation`);
  if (!(await adapters.isLicensed(repository.adapter))) throw br29(repository, `The licence does not include the ${repository.adapter} adapter`);
}

/**
 * Maps a failed gateway call to the D.3 answer: unreachable, throttled or an unusable credential is BR-29, an item
 * outside the system root is 422, a missing item 404 (or 422 where the caller asks), refusals of a zero-transit
 * registration 422, a file over the size limit 413. Everything else is passed on.
 */
export function mapGatewayError(error: unknown, repository: Pick<RepositoryRow, 'name'>, options: { notFound?: 'not-found' | 'business-rule'; forbidden?: 'br29' | 'business-rule' } = {}): unknown {
  if (error instanceof GatewayUnavailableError) return br29(repository, 'The storage gateway cannot be reached');
  if (!(error instanceof GatewayProblemError)) return error;
  switch (error.gatewaySlug) {
    case 'unreachable':
    case 'rate-limited':
      return br29(repository, error.gatewayDetail);
    case 'outside-root':
      return outsideRootError();
    case 'not-found':
      return options.notFound === 'business-rule'
        ? refusal('files.item_not_found', { en: 'The file was not found in the repository.', id: 'Berkas tidak ditemukan di repositori.' })
        : new NotFoundError('The file was not found in the repository');
    case 'forbidden':
      // The api's own token or certificate was refused: an installation fault, not the user's.
      if (error.reason === 'caller' || error.reason === 'token') return new DependencyUnavailableError('The storage gateway refused the api', { cause: error });
      // A credential that does not open for this repository (binding, kind, missing) cannot serve any file.
      if (error.reason) return br29(repository, error.gatewayDetail);
      // The provider refused the item: for a zero-transit registration the item fails the intent checks.
      if (options.forbidden === 'business-rule') return itemRefused();
      return br29(repository, error.gatewayDetail);
    case 'bad-request':
      return options.forbidden === 'business-rule' ? itemRefused() : error;
    default:
      return error;
  }
}

/** Runs a gateway call and maps its failure (see `mapGatewayError`). */
export async function viaGateway<T>(repository: Pick<RepositoryRow, 'name'>, call: () => Promise<T>, options?: Parameters<typeof mapGatewayError>[2]): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mapGatewayError(error, repository, options);
  }
}

/** A system root of a repository config (`config.roots[<ms>]`). */
interface RootConfig {
  folderId?: unknown;
  path?: unknown;
}

/**
 * The scope root of a system in a repository (D.5): provider repositories use `config.roots[<ms slug>]` (404 when the
 * repository has no folder for the system); the Managed Vault uses a folder label named after the system code.
 */
export function scopeRootOf(repository: RepositoryRow, ms: { slug: string; code: string }): ScopeRoot {
  if (repository.adapter === 'managed_vault') return { folderId: null, path: ms.code };
  const config = (repository.config ?? {}) as { roots?: Record<string, RootConfig> };
  const root = config.roots?.[ms.slug];
  if (!root || typeof root.folderId !== 'string' || root.folderId === '') {
    throw new NotFoundError(`The repository ${repository.slug} has no folder for this management system`);
  }
  return { folderId: root.folderId, path: typeof root.path === 'string' ? root.path : '' };
}

/** Joins folder segments with `/` (empty segments dropped). */
export function joinPath(...parts: (string | null | undefined)[]): string {
  return parts
    .flatMap((part) => (part ?? '').split('/'))
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .join('/');
}

/** Folder below the system root for new files (TS 5.4 folder convention, evidence by year and quarter). */
export function uploadFolder(kind: ObjectKind, today: string): string {
  if (kind === 'document') return 'Documents';
  const year = today.slice(0, 4);
  const quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  return `Evidence/${year}/Q${quarter}`;
}

/** The extension of a file name (lower case letters and digits, at most 10), or '' when it has none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** A file name safe for every adapter: no path separators, control characters or reserved characters. */
export function safeFileName(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = fileName.normalize('NFC').replace(/[\u0000-\u001f\u007f"*:<>?/\\|#%]/g, '_').replace(/\s+/g, ' ').trim();
  const cut = [...cleaned].slice(0, 200).join('').replace(/^[.\s]+|[.\s]+$/g, '');
  return cut === '' ? 'file' : cut;
}

/**
 * The name written to the repository (upload_intent.stored_name). With metadata minimisation (TS 4.5, 11.8) the
 * record code and the file sequence only, `<code>-<sequence>.<ext>`; otherwise the uploader's file name.
 */
export function storedFileName(input: { minimise: boolean; code: string; sequence: number; fileName: string }): string {
  if (!input.minimise) return safeFileName(input.fileName);
  const ext = extensionOf(input.fileName);
  return `${safeFileName(input.code)}-${input.sequence}${ext ? `.${ext}` : ''}`;
}

/** Correlation code of an intent: `MSCD-<code>-<8 hex>` (at most 40 characters, upload_intent.correlation_code). */
export function correlationCode(code: string, random: string): string {
  const head = code.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 26) || 'FILE';
  return `MSCD-${head}-${random.toUpperCase()}`;
}

/** A version label for document_version (at most 20 characters): provider labels without the leading `v`. */
export function documentVersionLabel(providerLabel: string | null): string | null {
  if (!providerLabel) return null;
  const label = providerLabel.replace(/^v(?=\d)/, '');
  return label.length <= 20 ? label : label.slice(0, 20);
}

/** The next major document version after the stored labels (`3.0` after `2.1`), as the sample does (A.4 5.7). */
export function nextDocumentVersion(labels: readonly string[]): string {
  let max = 0;
  for (const label of labels) {
    const n = Number.parseFloat(label.replace(/^v/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return (Math.floor(max) + 1).toFixed(1);
}

/** 403 for a record the caller may act on only as its owner (F.7 own grants). */
export function assertOwner(own: boolean, ownerUserId: unknown, userId: string): void {
  if (own && ownerUserId !== userId) throw new ForbiddenError('Only the owner of this record may do this');
}
