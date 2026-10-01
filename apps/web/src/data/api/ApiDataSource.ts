// API data source (BUILD-PLAN H.2, H.4): the DataSource of types.ts over the MSCD api. Snapshots come from
// `GET /me`, `GET /ui/org`, `GET /ui/ms/{ms}` for every system of the organisation where the user holds a role, and
// `GET /tasks` (stored tasks, D-29); every command maps to the route of the H.4 table and answers a `CommandResult`.
//
// The source never throws for an api error of a command: a problem becomes `{ok: false, error}` with the server's
// message pair, a network failure the status 0 with "Connection lost. Try again.". Snapshot loads reject with
// `ApiLoadError` (the controller shows the error and offers to try again). A 401 reaches the boot router through the
// shared `ApiClient` (`onUnauthenticated`), a 409 `reauth-required` of an organisation switch through
// `onReauthRequired`, so the controller has nothing to do for either.
import type {
  BackgroundTask, Me, PickerListing as WirePickerListing, TaskList, UiMsSnapshot, UiOrgSnapshot, UploadIntent,
} from '@mscd/shared';
import type {
  CommandResult, DataSource, Evidence, IsoDate, MsId, PageAction, Pair, PersonId, PickerFileChoice, PickerListing,
  RecordKey, RepositoryAction, Snapshot, UiRole,
} from '../types';
import { ApiClient, toApiError } from './ApiClient';
import type { ApiError, ApiResult, Lang } from './ApiClient';
import {
  API_ROUTES, NOT_APPLICABLE, NOT_FOUND, assembleSnapshot, findRef, localError, mergeReload, parseKey, systemsOf, toCommandResult,
} from './wire';
import type { ApiRouteName, ApiSnapshot } from './wire';

export type { ApiSnapshot };

/** A snapshot load that failed: the api error, and whether a new sign-in is needed (D-26). */
export class ApiLoadError extends Error {
  readonly error: ApiError;
  readonly reauth: boolean;
  constructor(error: ApiError) {
    super(error.message[0]);
    this.name = 'ApiLoadError';
    this.error = error;
    this.reauth = error.status === 409 && error.slug === 'reauth-required';
  }
}

export interface ApiDataSourceOptions {
  client: ApiClient;
  /** The `Me` the boot already read; the first `load()` reads `/me` again. */
  me?: Me;
  /** Opens a download or consent address (default: `window.location.assign`). */
  navigate?: (url: string) => void;
  /** Waits between polls of an export (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** How often and how long an export is polled before the source answers "queued" (default 20 times, 1.5 s). */
  exportPolls?: number;
  exportPollMs?: number;
  /** Sends upload content with XMLHttpRequest to report progress (default: when the browser has it). */
  useXhr?: boolean;
}

type Listener<T> = (value: T) => void;

const EXPORT_QUEUED: Pair = [
  'Export queued. You will get a notification when it is ready.',
  'Ekspor diantrekan. Anda akan menerima notifikasi saat siap.',
];
const EXPORT_FAILED: Pair = ['The export failed. Try again.', 'Ekspor gagal. Coba lagi.'];
const NO_FILE: Pair = ['Choose a file first.', 'Pilih berkas terlebih dahulu.'];
const NO_CONTENT_URL: Pair = [
  'This repository does not take uploads through MSCD. Link the file instead.',
  'Repositori ini tidak menerima unggahan melalui MSCD. Tautkan berkasnya.',
];
const NEED_EMAIL: Pair = ['Enter the auditor email address.', 'Masukkan alamat email auditor.'];
const NEED_PHASE: Pair = ['Choose a phase first.', 'Pilih fase terlebih dahulu.'];
const SNAPSHOT_MISSING = new Error('ApiDataSource: load() has not completed');

/** Integrity codes whose file can still be verified; any other code is relinked (H.4 `linkFile`). */
const VERIFIABLE = new Set(['ok', 'nohash', 'pending']);

export function createApiDataSource(options: ApiDataSourceOptions): ApiDataSource {
  return new ApiDataSource(options);
}

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;
  readonly client: ApiClient;
  private me: Me | null;
  private current: ApiSnapshot | null = null;
  private readonly navigate: (url: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exportPolls: number;
  private readonly exportPollMs: number;
  private readonly useXhr: boolean;
  private readonly progress = new Set<Listener<number | null>>();

  constructor(options: ApiDataSourceOptions) {
    if (!options || !options.client) throw new Error('ApiDataSource: a client is required');
    this.client = options.client;
    this.me = options.me ?? null;
    this.navigate = options.navigate ?? ((url) => { if (typeof window !== 'undefined') window.location.assign(url); });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.exportPolls = options.exportPolls ?? 20;
    this.exportPollMs = options.exportPollMs ?? 1500;
    this.useXhr = options.useXhr ?? typeof XMLHttpRequest !== 'undefined';
  }

  /** Interface language of every request (`Accept-Language`). */
  setLanguage(lang: Lang): void {
    this.client.setLanguage(lang);
  }

  /** Upload progress from 0 to 1 while content is sent, then null; returns the unsubscribe function. */
  onProgress(listener: Listener<number | null>): () => void {
    this.progress.add(listener);
    return () => this.progress.delete(listener);
  }

  /** The last snapshot the source assembled (null before the first load). */
  get snapshot(): ApiSnapshot | null {
    return this.current;
  }

  // ---------- snapshots ----------

  /** `GET /me`, then the organisation and every system. An `orgId` other than the session's switches first. */
  async load(orgId?: string): Promise<Snapshot> {
    let me = await this.read<Me>('me');
    if (orgId && me.org && me.org.slug !== orgId) me = await this.switchTo(orgId);
    return this.fetchAll(me);
  }

  /** `/ui/org`, the changed systems and `/tasks` again; the other systems keep their bundles. */
  async reload(snapshot: Snapshot, msIds: MsId[]): Promise<Snapshot> {
    const prev = (snapshot as ApiSnapshot).refs ? (snapshot as ApiSnapshot) : this.current;
    if (!prev) throw SNAPSHOT_MISSING;
    const org = await this.read<UiOrgSnapshot>('uiOrg');
    const systems = systemsOf(prev.me as unknown as Me, org);
    const wanted = [...new Set(msIds)].filter((id) => systems.includes(id));
    // A system of the organisation that the previous snapshot did not hold is loaded too.
    for (const id of systems) if (!prev.bundles[id] && !wanted.includes(id)) wanted.push(id);
    const [ms, tasks] = await Promise.all([
      Promise.all(wanted.map((id) => this.read<UiMsSnapshot>('uiMs', { ms: id }))),
      this.readTasks(),
    ]);
    const snap = mergeReload(prev, org, ms, tasks);
    this.current = snap;
    return snap;
  }

  private async fetchAll(me: Me): Promise<ApiSnapshot> {
    this.me = me;
    const org = await this.read<UiOrgSnapshot>('uiOrg');
    const systems = systemsOf(me, org);
    const [ms, tasks] = await Promise.all([
      Promise.all(systems.map((id) => this.read<UiMsSnapshot>('uiMs', { ms: id }))),
      this.readTasks(),
    ]);
    const snap = assembleSnapshot(me, org, ms, tasks);
    this.current = snap;
    return snap;
  }

  /** `GET /tasks`; My Tasks still shows the chain items of the bundles when it fails (other than with a 401). */
  private async readTasks(): Promise<TaskList | null> {
    const res = await this.send<TaskList>('tasks');
    if (res.ok) return res.data;
    if (res.status === 401) throw new ApiLoadError(res.error);
    return null;
  }

  private async read<T>(name: ApiRouteName, params?: Record<string, string | number>): Promise<T> {
    const res = await this.send<T>(name, { params });
    if (!res.ok) throw new ApiLoadError(res.error);
    return res.data;
  }

  // ---------- session ----------

  /** Demo persona switch (D-20): `POST /auth/demo/persona` answers the new `Me` (new session), then everything again. */
  async switchPersona(role: UiRole): Promise<Snapshot> {
    const res = await this.send<Me>('persona', { body: { role } });
    if (!res.ok) throw new ApiLoadError(res.error);
    return this.fetchAll(res.data);
  }

  /** `PUT /me/org` (D-26); a 409 `reauth-required` rejects with `ApiLoadError.reauth` (the boot shows the sign-in page). */
  async switchOrg(orgId: string): Promise<Snapshot> {
    const me = await this.switchTo(orgId);
    return this.fetchAll(me);
  }

  private async switchTo(org: string): Promise<Me> {
    const res = await this.send<Me>('switchOrg', { body: { org } });
    if (!res.ok) throw new ApiLoadError(res.error);
    return res.data;
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  /** Any 401 of a request made with the session (the client tells the boot router as well). */
  onUnauthenticated(listener: () => void): () => void {
    return this.client.onUnauthenticated(() => listener());
  }

  // ---------- commands ----------

  markComplete(key: RecordKey): Promise<CommandResult> {
    return this.transition(key, { req: 'complete', act: 'complete' });
  }

  verify(key: RecordKey, to: 'implemented' | 'verified'): Promise<CommandResult> {
    const k = parseKey(key);
    if (k && ((k.kind === 'req' && to !== 'implemented') || (k.kind === 'act' && to !== 'verified'))) return Promise.resolve(localError(422, NOT_APPLICABLE));
    return this.transition(key, { req: 'implemented', act: 'verified' });
  }

  private async transition(key: RecordKey, to: { req: string; act: string }): Promise<CommandResult> {
    const found = this.resolve(key, ['req', 'act']);
    if ('error' in found) return found.error;
    const { k, ref } = found;
    const name: ApiRouteName = k.kind === 'req' ? 'applicabilityTransition' : 'activityTransition';
    return this.command(name, { params: { ms: k.ms, id: ref.id }, body: { to: k.kind === 'req' ? to.req : to.act } });
  }

  /** Holder and due date of any record kind of a RecordKey; `If-Match` with the record's ETag (D.1). */
  async assign(key: RecordKey, h: PersonId, due: IsoDate | null): Promise<CommandResult> {
    const found = this.resolve(key, ['req', 'soa', 'doc', 'ev', 'act', 'x', 'prep', 'cycle', 'drift']);
    if ('error' in found) return found.error;
    const { k, ref } = found;
    const headers: Record<string, string> = ref.etag ? { 'If-Match': ref.etag } : {};
    return this.command('assign', {
      params: { ms: k.ms, entityType: ref.entityType, id: ref.id },
      body: { kind: k.kind, holder: h || 'none', dueAt: due || null },
      headers,
    });
  }

  /** `POST /reminders` with the record's ref, or with its key when the snapshot has no ref for it. */
  async remind(key: RecordKey, recipient: PersonId): Promise<CommandResult> {
    const k = parseKey(key);
    if (!k) return localError(404, NOT_FOUND);
    const ref = this.current ? findRef(this.current.refs, key) : null;
    const body = ref
      ? { ms: k.ms, ref: { module: ref.module, entityType: ref.entityType, id: ref.id, code: ref.code }, recipient }
      : { ms: k.ms, recordKey: key, recipient };
    return this.command('remind', { body });
  }

  remindAll(msId: MsId): Promise<CommandResult> {
    return this.command('remindBulk', { body: { ms: msId, scope: 'open_chain_items' } });
  }

  /** A stored task (`task`) completes through `/tasks/{id}/complete`; an explicit record or drift row its pending action. */
  async completeRecordAction(key: RecordKey): Promise<CommandResult> {
    const k = parseKey(key);
    if (!k) return localError(404, NOT_FOUND);
    if (k.kind === 'task') return this.command('taskComplete', { params: { id: k.id }, body: {} });
    const found = this.resolve(key, ['x', 'drift']);
    if ('error' in found) return found.error;
    return this.command('completeAction', { params: { ms: k.ms, entityType: found.ref.entityType, id: found.ref.id }, body: {} });
  }

  async startReview(key: RecordKey): Promise<CommandResult> {
    const found = this.resolve(key, ['doc']);
    if ('error' in found) return found.error;
    return this.command('documentTransition', { params: { ms: found.k.ms, id: found.ref.id }, body: { to: 'in_review' } });
  }

  /** Not called by the controller yet (no form, Appendix 1); maps to the activity transition `blocked`. */
  async recordBlocker(key: RecordKey, gateRef: string, reason: string): Promise<CommandResult> {
    const found = this.resolve(key, ['act']);
    if ('error' in found) return found.error;
    return this.command('activityTransition', {
      params: { ms: found.k.ms, id: found.ref.id },
      body: { to: 'blocked', blockerGateItemRef: gateRef, blockerReason: reason },
    });
  }

  /** Files of the system's default repository below its root, for the record (`GET /storage/repositories/{slug}/browse`). */
  async listPickerFiles(key: RecordKey): Promise<PickerListing> {
    const found = this.resolve(key, ['ev', 'doc']);
    if ('error' in found) throw new ApiLoadError({ status: found.error.error!.status, message: found.error.error!.message });
    const ms = this.current?.MS.find((m) => m.id === found.k.ms);
    if (!ms) throw new ApiLoadError({ status: 404, message: NOT_FOUND });
    const res = await this.send<WirePickerListing>('browse', {
      params: { slug: ms.loc },
      query: { ms: ms.id, kind: found.k.kind === 'ev' ? 'evidence' : 'document', recordId: found.ref.id },
    });
    if (!res.ok) throw new ApiLoadError(res.error);
    const data = res.data;
    return { path: data.path, files: data.files.map((f) => [...f] as PickerListing['files'][number]), refs: data.refs.map((r) => ({ ...r })) };
  }

  /** Links a file of the picker listing: new evidence file (relink when the pinned one is unverifiable) or document version. */
  async linkFile(key: RecordKey, file: PickerFileChoice): Promise<CommandResult> {
    const found = this.resolve(key, ['ev', 'doc']);
    if ('error' in found) return found.error;
    const { k, ref } = found;
    if (!file || !file.ref) return localError(422, NOT_FOUND);
    const { repositoryId, externalItemId } = file.ref;
    if (k.kind === 'doc') {
      return this.command('documentVersions', { params: { ms: k.ms, id: ref.id }, body: { source: 'link', repository: repositoryId, externalItemId } });
    }
    return this.command('evidenceFiles', {
      params: { ms: k.ms, id: ref.id },
      body: { source: 'link', repository: repositoryId, externalItemId, producedAt: this.current?.today, mode: this.fileMode(k.ms, k.id) },
    });
  }

  /** Upload intent, the content to `contentUrl`, then the evidence file or document version with `source: 'upload'`. */
  async uploadFile(key: RecordKey, file: File | null): Promise<CommandResult> {
    const found = this.resolve(key, ['ev', 'doc']);
    if ('error' in found) return found.error;
    const { k, ref } = found;
    if (!file) return localError(422, NO_FILE);
    const intentRes = await this.send<UploadIntent>('uploadIntent', {
      body: { ms: k.ms, kind: k.kind === 'ev' ? 'evidence' : 'document', recordId: ref.id, fileName: file.name, size: file.size },
    });
    if (!intentRes.ok) return toCommandResult(intentRes);
    const intent = intentRes.data;
    if (!intent.contentUrl) return localError(422, NO_CONTENT_URL);
    const put = await this.putContent(intent.contentUrl, file);
    if (!put.ok) return toCommandResult(put);
    if (k.kind === 'doc') {
      return this.command('documentVersions', { params: { ms: k.ms, id: ref.id }, body: { source: 'upload', uploadIntentId: intent.intentId } });
    }
    return this.command('evidenceFiles', {
      params: { ms: k.ms, id: ref.id },
      body: { source: 'upload', uploadIntentId: intent.intentId, producedAt: this.current?.today, mode: this.fileMode(k.ms, k.id) },
    });
  }

  /** Storage card actions by repository slug; the admin routes take the repository uuid (`REPOS[].ref`). */
  async repositoryAction(repoId: string, action: RepositoryAction, msId?: MsId): Promise<CommandResult> {
    const repo = this.current?.REPOS.find((r) => r.id === repoId);
    if (!repo || !repo.ref) return localError(404, NOT_FOUND);
    if (!(repo.actions ?? ['test']).includes(action)) return localError(422, NOT_APPLICABLE);
    if (action === 'test') return this.command('repositoryTest', { params: { id: repo.ref } });
    if (action === 'reauthorise') {
      const result = await this.command('repositoryReauthorize', { params: { id: repo.ref } });
      if (result.ok && result.redirectUrl) this.navigate(result.redirectUrl);
      return result;
    }
    const ms = msId ?? this.current?.systems[0];
    return this.command('repositoryMove', { params: { id: repo.ref }, body: { ms } });
  }

  /**
   * Page actions (UI 3.6, H.4). `arg` is the auditor email of `auditorAccess`, the `.pack` file of `importBundle`
   * and the phase number of `verifyPhase`.
   */
  async pageAction(msId: MsId, action: PageAction, arg?: unknown): Promise<CommandResult> {
    switch (action) {
      case 'exportBoard':
        return this.runExport({ type: 'portfolio_board', format: 'pdf' });
      case 'exportReadiness':
        return this.runExport({ type: 'readiness', ms: msId, format: 'pdf' });
      case 'exportSoa':
      case 'exportDocs': {
        const [, path] = API_ROUTES[action === 'exportSoa' ? 'exportSoa' : 'exportDocuments'];
        const url = path.replace(':ms', encodeURIComponent(msId)) + '?format=xlsx';
        this.navigate(url);
        return { ok: true, changed: [], downloadUrl: url };
      }
      case 'evidencePack':
        return this.command('evidencePack', { params: { ms: msId }, body: {} });
      case 'auditorAccess': {
        const email = typeof arg === 'string' ? arg.trim() : '';
        if (!email) return localError(400, NEED_EMAIL);
        return this.command('auditorAccess', { params: { ms: msId }, body: { email } });
      }
      case 'runCheck':
        return this.command('linkHealthRun', { params: { ms: msId } });
      case 'calendarFeed':
        return this.command('calendarFeed', { params: { ms: msId } });
      case 'checkUpdates':
        return this.command('packsCheckUpdates');
      case 'importBundle': {
        if (!arg || typeof arg !== 'object') return localError(422, NO_FILE);
        const form = new FormData();
        form.append('bundle', arg as Blob, (arg as File).name ?? 'bundle.pack');
        return this.command('packsImport', { body: form });
      }
      case 'verifyPhase': {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1) return localError(422, NEED_PHASE);
        return this.command('phaseVerify', { params: { ms: msId, n } });
      }
      default:
        return localError(422, NOT_APPLICABLE);
    }
  }

  // ---------- internals ----------

  private send<T>(name: ApiRouteName, options: { params?: Record<string, string | number>; query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
    const [method, path] = API_ROUTES[name];
    return this.client.request<T>(method, path, options);
  }

  private async command(name: ApiRouteName, options: Parameters<ApiDataSource['send']>[1] = {}): Promise<CommandResult> {
    return toCommandResult(await this.send(name, options));
  }

  /** The parsed key and record reference of a key of an allowed kind, or the failure to answer. */
  private resolve(key: RecordKey, kinds: string[]): { k: NonNullable<ReturnType<typeof parseKey>>; ref: NonNullable<ReturnType<typeof findRef>> } | { error: CommandResult } {
    const k = parseKey(key);
    if (!k) return { error: localError(404, NOT_FOUND) };
    if (!kinds.includes(k.kind)) return { error: localError(422, NOT_APPLICABLE) };
    const ref = this.current ? findRef(this.current.refs, key) : null;
    if (!ref) return { error: localError(404, NOT_FOUND) };
    return { k, ref };
  }

  /** `relink` when the evidence's pinned file cannot be verified (C.12), else `submit`. */
  private fileMode(ms: MsId, code: string): 'submit' | 'relink' {
    const ev = this.current?.bundles[ms]?.evs.find((e: Evidence) => e.code === code);
    return ev && !VERIFIABLE.has(ev.integ) ? 'relink' : 'submit';
  }

  /** `POST /exports`, then polls the task until it has a download address (opened at once) or the polls run out. */
  private async runExport(body: { type: string; ms?: MsId; format: string }): Promise<CommandResult> {
    const started = await this.command('exportCreate', { body });
    const taskId = (started as CommandResult & { taskId?: string }).taskId;
    if (!started.ok || !taskId) return started;
    for (let i = 0; i < this.exportPolls; i++) {
      await this.sleep(this.exportPollMs);
      const res = await this.send<BackgroundTask>('exportGet', { params: { taskId } });
      if (!res.ok) return toCommandResult(res);
      if (res.data.status === 'failed') return localError(500, EXPORT_FAILED);
      if (res.data.status === 'succeeded' && res.data.downloadUrl) {
        this.navigate(res.data.downloadUrl);
        return { ...started, downloadUrl: res.data.downloadUrl };
      }
    }
    return { ...started, message: started.message ?? EXPORT_QUEUED };
  }

  /** `PUT` of the raw file to the intent's content address, with upload progress when XMLHttpRequest is available. */
  private async putContent(url: string, file: File): Promise<ApiResult<unknown>> {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (!this.useXhr) {
      this.emitProgress(0);
      try {
        return await this.client.request('PUT', url, { body: file, headers });
      } finally {
        this.emitProgress(null);
      }
    }
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.withCredentials = false;
      xhr.setRequestHeader('Content-Type', headers['Content-Type']);
      xhr.setRequestHeader('Accept', 'application/json, application/problem+json');
      xhr.setRequestHeader('Accept-Language', this.client.language);
      if (this.client.csrfToken) xhr.setRequestHeader('X-CSRF-Token', this.client.csrfToken);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) this.emitProgress(e.loaded / e.total); };
      const done = (result: ApiResult<unknown>) => { this.emitProgress(null); resolve(result); };
      xhr.onerror = () => done({ ok: false, status: 0, error: { status: 0, message: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] } });
      xhr.onload = () => {
        let body: unknown;
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined; } catch { body = xhr.responseText; }
        if (xhr.status >= 200 && xhr.status < 300) done({ ok: true, status: xhr.status, data: body });
        else done({ ok: false, status: xhr.status, error: toApiError(xhr.status, body, { get: (n) => xhr.getResponseHeader(n) }) });
      };
      this.emitProgress(0);
      xhr.send(file);
    });
  }

  private emitProgress(value: number | null): void {
    for (const listener of [...this.progress]) {
      try { listener(value); } catch (e) { console.error('progress listener failed', e); }
    }
  }
}
