// Document register commands (build plan D.3, C.13 `document.status`, A.4 5.7 and 5.8, K.2 WP-35): registration
// (doc_type lookup, 409 duplicate, NOT-A-MEMBER, linked systems), edits with the BR-22 confirmation of shared
// documents, review start by the owner (own grant), approval (BR-16: never by the author of the version in review;
// the version in review becomes current, the earlier one superseded, the review ends), return to draft with a note,
// 409, 412, 403 and 404 paths, and the audit chain after the run.
import { CommandResult, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditOf, createApp, grantRole, rowsOf, sessionFor, TODAY, userId, verifyChain, type Client, type CommandsApp } from './helpers';

const NEW_DOC = {
  docCode: 'PRC-21',
  title: 'Secure Development Procedure',
  docType: 'procedure',
  ownerHandle: 'bagus',
  approverHandle: 'rina',
  nextReviewAt: '2027-10-01',
  classification: 'internal',
  orgWide: false,
  linkedMs: ['isms'],
} as const;

describe('document commands', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let hendra: Client;
  let rinaNdt: Client;

  beforeAll(async () => {
    ctx = await createApp(db);
    // A second approver (Programme Owner holds document.approve, A.4).
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const snapshot = async (client: Client = rina, ms = 'isms') => (await client.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`)).body;
  const docRef = async (code: string, client: Client = rina, ms = 'isms') => (await snapshot(client, ms)).refs[`${ms}:doc:${code}`]!;
  const doc = async (code: string, client: Client = rina, ms = 'isms') => (await snapshot(client, ms)).bundle.docs.find((d) => d.id === code);
  const transition = (id: string, ms = 'isms') => `/api/v1/ms/${ms}/documents/${id}/transitions`;

  describe('registration', () => {
    it('registers a draft document linked to the path system (201), replays with the same key, refuses a duplicate code (409)', async () => {
      const response = await rina.post('/api/v1/ms/isms/documents', NEW_DOC, { 'idempotency-key': 'doc-create-1' });
      expect(response.status).toBe(201);
      expect(CommandResult.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ changed: ['isms'], ref: { entityType: 'document', code: 'PRC-21' } });
      const replay = await rina.post('/api/v1/ms/isms/documents', NEW_DOC, { 'idempotency-key': 'doc-create-1' });
      expect(replay.status).toBe(201);
      expect(replay.body.ref!.id).toBe(response.body.ref!.id);
      expect(await doc('PRC-21')).toMatchObject({ st: 'draft', owner: 'bagus', title: 'Secure Development Procedure' });
      const audit = await auditOf(db, 'tst', response.body.ref!.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'document.created', actor: 'rina', after: expect.objectContaining({ doc_type: 'procedure', systems: ['isms'] }) });
      const duplicate = await rina.post('/api/v1/ms/isms/documents', NEW_DOC);
      expect(duplicate.status).toBe(409);
    });

    it('answers 422 for an unknown doc_type, a non-member owner, a path system missing from linkedMs; 403 for a Domain Owner', async () => {
      const unknownType = await rina.post('/api/v1/ms/isms/documents', { ...NEW_DOC, docCode: 'PRC-22', docType: 'memo' });
      expect(unknownType.status).toBe(422);
      expect(unknownType.body.messageKey).toBe('documents.unknown_doc_type');
      const stranger = await rina.post('/api/v1/ms/isms/documents', { ...NEW_DOC, docCode: 'PRC-22', ownerHandle: 'staff01' });
      expect(stranger.status).toBe(422);
      expect(stranger.body.rule).toBe('NOT-A-MEMBER');
      const notLinked = await rinaNdt.post('/api/v1/ms/isms/documents', { ...NEW_DOC, docCode: 'PRC-22', linkedMs: ['qms'] });
      expect(notLinked.status).toBe(422);
      expect((await bagus.post('/api/v1/ms/isms/documents', { ...NEW_DOC, docCode: 'PRC-22' })).status).toBe(403);
    });

    it('links a new document to several systems of the organisation (primary link on the path system)', async () => {
      const response = await rinaNdt.post('/api/v1/ms/isms/documents', { ...NEW_DOC, docCode: 'IMS-09', title: 'Integrated Objectives', docType: 'policy', ownerHandle: 'rina', linkedMs: ['qms', 'isms'] });
      expect(response.status).toBe(201);
      expect(response.body.changed).toEqual(['isms', 'qms']);
      const links = await rowsOf<{ slug: string; is_primary: boolean }>(db, 'ndt', sql`
        select m.slug, l.is_primary from entity_ms_link l join management_system m on m.id = l.management_system_id
         where l.entity_id = ${response.body.ref!.id} order by m.slug`);
      expect(links).toEqual([{ slug: 'isms', is_primary: true }, { slug: 'qms', is_primary: false }]);
      expect(await doc('IMS-09', rinaNdt, 'qms')).toMatchObject({ st: 'draft' });
    });
  });

  describe('edits', () => {
    it('changes title, owner, approver, review date and classification in one audit entry; 412 with a stale If-Match', async () => {
      const ref = await docRef('PRC-12');
      const response = await rina.patch(`/api/v1/ms/isms/documents/${ref.id}`, { title: 'Logging and Monitoring Procedure', ownerHandle: 'yusuf', approverHandle: null, nextReviewAt: '2027-05-01', classification: 'confidential' }, { 'if-match': ref.etag! });
      expect(response.status).toBe(200);
      expect(await doc('PRC-12')).toMatchObject({ title: 'Logging and Monitoring Procedure', owner: 'yusuf', rev: '2027-05-01' });
      expect((await auditOf(db, 'tst', ref.id)).at(-1)).toMatchObject({
        action: 'document.updated',
        before: expect.objectContaining({ owner_user_id: 'dewi' }),
        after: expect.objectContaining({ owner_user_id: 'yusuf', classification: 'confidential', next_review_at: '2027-05-01' }),
      });
      const stale = await rina.patch(`/api/v1/ms/isms/documents/${ref.id}`, { title: 'Another title' }, { 'if-match': ref.etag! });
      expect(stale.status).toBe(412);
      expect((await rina.patch(`/api/v1/ms/isms/documents/${ref.id}`, { ownerHandle: 'staff01' })).body.rule).toBe('NOT-A-MEMBER');
    });

    it('asks for confirmation before changing a shared document (BR-22, affected systems), then applies it', async () => {
      const ref = await docRef('IMS-02', rinaNdt);
      const first = await rinaNdt.patch(`/api/v1/ms/isms/documents/${ref.id}`, { nextReviewAt: '2027-09-24' });
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ rule: 'BR-22', type: expect.stringMatching(/confirmation-required$/) });
      expect([...first.body.affected!].sort()).toEqual(['abms', 'bcms', 'qms']);
      expect(first.body.messages!.en).toMatch(/^This change also applies to: .+\. Continue\?$/);
      const confirmed = await rinaNdt.patch(`/api/v1/ms/isms/documents/${ref.id}`, { nextReviewAt: '2027-09-24', confirm: true });
      expect(confirmed.status).toBe(200);
      expect([...confirmed.body.changed].sort()).toEqual(['abms', 'bcms', 'isms', 'qms']);
      expect((await doc('IMS-02', rinaNdt, 'qms'))!.rev).toBe('2027-09-24');
    });
  });

  describe('transitions', () => {
    it('lets the owner start the review of an expired document (own grant), and refuses another Domain Owner', async () => {
      const ref = await docRef('PRC-11');
      const response = await bagus.post(transition(ref.id), { to: 'in_review' }, { 'if-match': ref.etag! });
      expect(response.status).toBe(200);
      expect(await doc('PRC-11')).toMatchObject({ st: 'review' });
      const [row] = await rowsOf<{ review_started_at: string | null }>(db, 'tst', sql`select review_started_at from document where id = ${ref.id}`);
      expect(row!.review_started_at).toBe(TODAY);
      const others = await docRef('PRC-15');
      expect((await bagus.post(transition(others.id), { to: 'in_review' })).status).toBe(403);
    });

    it('answers 409 for a pair C.13 does not list and 400 when a rejection has no note', async () => {
      const approved = await docRef('PRC-05');
      expect((await rina.post(transition(approved.id), { to: 'approved' })).status).toBe(409);
      const inReview = await docRef('PLN-02');
      expect((await rina.post(transition(inReview.id), { to: 'draft' })).status).toBe(400);
    });

    it('approves a version in review only by someone else than its author (BR-16): new current version, earlier superseded', async () => {
      // A version submitted by Rina is in review (as `POST .../versions` leaves it, A.4 5.7).
      const ref = await docRef('PRC-10');
      const rinaId = await userId(db, 'rina');
      const [{ storage_object_id: objectId }] = (await rowsOf<{ storage_object_id: string }>(db, 'tst', sql`
        select v.storage_object_id from document_version v where v.document_id = ${ref.id}`)) as [{ storage_object_id: string }];
      const [version] = await rowsOf<{ id: string }>(db, 'tst', sql`
        insert into document_version (document_id, version_label, storage_object_id, status, submitted_by, submitted_at)
        values (${ref.id}, '3.0', ${objectId}, 'in_review', ${rinaId}, now()) returning id`);
      await rowsOf(db, 'tst', sql`update document set status = 'in_review', review_started_at = ${TODAY} where id = ${ref.id} returning id`);

      const own = await rina.post(transition(ref.id), { to: 'approved' });
      expect(own.status).toBe(422);
      expect(own.body.rule).toBe('BR-16');
      expect(own.body.messages!.en).toBe('A document cannot be approved by its own author. Approval is always separate from creation.');

      const approved = await hendra.post(transition(ref.id), { to: 'approved' });
      expect(approved.status).toBe(200);
      const versions = await rowsOf<{ version_label: string; status: string; approved_by: string | null }>(db, 'tst', sql`
        select v.version_label, v.status, u.handle as approved_by from document_version v left join platform.app_user u on u.id = v.approved_by
         where v.document_id = ${ref.id} order by v.version_label`);
      expect(versions).toEqual([
        { version_label: '2.3', status: 'superseded', approved_by: expect.anything() },
        { version_label: '3.0', status: 'approved', approved_by: 'hendra' },
      ]);
      const [row] = await rowsOf<{ current_version_id: string; review_started_at: string | null; approved_at: string; status: string }>(db, 'tst', sql`
        select current_version_id, review_started_at, approved_at, status from document where id = ${ref.id}`);
      expect(row).toEqual({ current_version_id: version!.id, review_started_at: null, approved_at: TODAY, status: 'approved' });
      expect(await doc('PRC-10')).toMatchObject({ st: 'approved', ver: '3.0', appr: TODAY });
      expect((await auditOf(db, 'tst', ref.id)).at(-1)).toMatchObject({
        action: 'document.transition',
        actor: 'hendra',
        before: expect.objectContaining({ status: 'in_review', current_version: '2.3' }),
        after: expect.objectContaining({ status: 'approved', current_version: '3.0' }),
      });
    });

    it('returns a document in review to draft with a note (the version in review is rejected), and approval needs document.approve', async () => {
      const ref = await docRef('PLN-02');
      expect((await bagus.post(transition(ref.id), { to: 'approved' })).status).toBe(403);
      const response = await rina.post(transition(ref.id), { to: 'draft', note: 'Section 4 needs the new roles' });
      expect(response.status).toBe(200);
      const [version] = await rowsOf<{ status: string; rejection_note: string }>(db, 'tst', sql`
        select status, rejection_note from document_version where document_id = ${ref.id}`);
      expect(version).toEqual({ status: 'rejected', rejection_note: 'Section 4 needs the new roles' });
      expect(await doc('PLN-02')).toMatchObject({ st: 'draft' });
    });

    it('answers 404 for a document of another system or organisation', async () => {
      const ndtQmsDoc = (await snapshot(rinaNdt, 'qms')).bundle.docs.find((d) => !d.shared)!;
      const ref = (await snapshot(rinaNdt, 'qms')).refs[`qms:doc:${ndtQmsDoc.id}`]!;
      expect((await rinaNdt.post(transition(ref.id, 'isms'), { to: 'in_review' })).status).toBe(404);
      expect((await rina.post(transition(ref.id, 'isms'), { to: 'in_review' })).status).toBe(404);
    });
  });

  it('leaves verifiable audit chains', async () => {
    for (const org of ['tst', 'ndt'] as const) {
      const chain = await verifyChain(db, org);
      expect(chain.firstBroken).toBeNull();
    }
  });
});
