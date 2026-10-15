// Derivations of the sample source (UI 2.2 to 2.7), moved from the controller without changing a rule. Every function
// takes the sample module `D` (the exports of mscd-data.js), the override store `ov` of the sample source (UI 3.1)
// and a management system or its derived records `d = {ms, reqs, docs, evs}`, so Node can run them too (export
// script, server parity tests). Imports nothing.
//
// Texts that depend on the interface language are returned as [en, id] pairs and the controller picks one with
// li(): chain item `title` and `act`, gate item `type` and `why`. The read model of the API returns pairs for the
// same fields (D.1 "Language"), so both sources give the controller the same shapes.

const STATUS_TEXT = {
  partial: ['Complete implementation', 'Selesaikan implementasi'],
  planned: ['Start implementation', 'Mulai implementasi'],
  ns: ['Assign and start', 'Tugaskan dan mulai'],
  blocked: ['Resolve blocking item: justification missing', 'Selesaikan item penghambat: justifikasi belum ada'],
};
const DOC_TEXT = {
  expired: ['Start review: review date passed', 'Mulai tinjauan: tanggal tinjauan terlewati'],
  review: ['Approve review', 'Setujui tinjauan'],
  draft: ['Continue draft and approve', 'Lanjutkan draf dan setujui'],
};
const GATE_TYPE = { risk: ['Risk', 'Risiko'], treatment: ['Treatment', 'Treatment'], soa: ['SoA', 'SoA'], bia: ['BIA', 'BIA'] };
// Sample fabrication (UI 2.15): activity owners rotate through a pool per system.
const OWNER_POOL = {
  isms: ['rina', 'hendra', 'bagus', 'dewi', 'fajar', 'yusuf', 'andi', 'lina'],
  qms: ['sari', 'yusuf', 'andi', 'dewi', 'maya', 'hendra'],
  bcms: ['tono', 'bagus', 'hendra', 'fajar', 'dewi'],
  abms: ['lina', 'andi', 'hendra', 'dewi'],
};
const UNVERIFIABLE = ['missing', 'revoked', 'changed', 'moved'];

const same = (s) => [s, s];
// Display name of a person in both languages; 'none' and unknown ids read as Unassigned.
const pname = (D, id) => (D.PEOPLE[id] && id !== 'none' ? same(D.PEOPLE[id][0]) : ['Unassigned', 'Belum ditugaskan']);

// Fields of UI 2.14 that replace hard-coded switches of the controller, filled with the controller's literals.
function docFields(ms) {
  return {
    approver: ms.approver,
    path: 'Compliance / ' + ms.short + ' / Documents',
    hashAlg: ms.loc === 'vault' ? 'SHA-256' : ms.loc === 'gd' ? 'SHA-256 (provider)' : 'quickXorHash',
  };
}
function evidenceFields(e) {
  // The fingerprint shortens to the literal the controller showed: <code letters>a91f...3c7e.
  const head = String(e.code || '').replace(/\W/g, '').toLowerCase() + 'a91f';
  const hash = head + '0'.repeat(Math.max(0, 60 - head.length)) + '3c7e';
  const lastCheck = e.integ === 'pending' ? '27 Sep 2026 06:00' : '29 Sep 2026 06:00';
  const lastGoodCheck = e.integ === 'pending' ? '27 Sep 2026 06:00' : e.integ === 'ok' || e.integ === 'nohash' ? lastCheck : undefined;
  return { ...(e.hashAlg === 'none' ? {} : { hash }), lastCheck, ...(lastGoodCheck ? { lastGoodCheck } : {}) };
}

/** Records of one system after the overrides (UI 2.2): `{ms, reqs, docs, evs}`. */
export function data(D, ov, ms) {
  const base = D.buildReqs(ms);
  const rov = (c) => ov[ms.id + ':req:' + c.id];
  const reqs = base.map((c) => {
    const o = rov(c); if (!o) return c;
    const c2 = { ...c }; if (o.st) c2.st = o.st; if (o.h) c2.owner = o.h; if (o.due) c2.due = o.due; c2.by = o.by; return c2;
  });
  const docs = D.buildDocs(ms).map((d) => { const o = ov[ms.id + ':doc:' + d.id]; return { ...(o ? { ...d, ...o } : d), ...docFields(ms) }; });
  // Evidence comes from what was submitted, so it is derived from the recorded control status:
  // marking a control complete or verifying it never creates or refreshes evidence. Only a new owner carries over.
  // Reassign stores {h,due}: for evidence that is the owner and the next due date.
  const evs = D.buildEvidence(ms, base.map((c) => { const o = rov(c); return o && o.h ? { ...c, owner: o.h } : c; })).map((e) => {
    const o = ov[ms.id + ':ev:' + e.code];
    let e2 = e;
    if (o) {
      e2 = { ...e, ...o };
      if (o.prod) { e2.next = e2.p ? D.addD(o.prod, e2.p) : null; e2.fresh = D.freshOf(o.prod, e2.p); }
      if (o.h) e2.owner = o.h;
      if (o.due) e2.next = o.due;
    }
    return { ...e2, ...evidenceFields(e2) };
  });
  return { ms, reqs, docs, evs };
}

/** Chain items and stage denominators (UI 2.3): `{items, recs}`. */
export function chain(D, ov, d) {
  const ms = d.ms, X = D.X[ms.id] || {}, stages = D.STAGES[ms.id], audit = ms.audit;
  const mk = (stage, kind, id, title, act, h, due, o = {}) => {
    const key = ms.id + ':' + kind + ':' + id; const v = ov[key] || {}; h = v.h || h; due = v.due !== undefined ? v.due : due;
    let st; if (o.missing || (!due && h === 'none')) st = 'missing'; else if (due && D.dd(due) < 0) st = 'overdue'; else st = 'pending';
    return { key, stage, kind, id, title, act, h, due, st, after: !!(due && audit && due > audit.date), gate: !!o.gate, up: o.up || [], down: o.down || [], ref: o.ref, q: o.q };
  };
  const items = [], recs = {};
  stages.forEach((s) => {
    if (s.src === 'req') {
      recs[s.id] = d.reqs.length;
      d.reqs.forEach((c, i) => {
        if (c.st === 'implemented' || c.st === 'na') return;
        let act = STATUS_TEXT[c.st];
        if (c.st === 'complete') { const by = pname(D, c.by || c.owner); act = ['Verify output (' + by[0] + ' marked complete)', 'Verifikasi hasil (ditandai selesai oleh ' + by[1] + ')']; }
        // Sample fabrication (UI 2.15): a requirement without a due date gets one spread over the next 95 days.
        const due = c.due || (c.st === 'blocked' ? null : D.addD('2026-10-01', (i * 9) % 95));
        items.push(mk(s.id, 'req', c.id, same(c.title), act, c.owner, due, { missing: c.st === 'blocked', gate: c.gate, up: c.risks, down: [c.doc], ref: c, q: s.q }));
      });
    } else if (s.src === 'soa') {
      recs[s.id] = s.rec;
      d.reqs.filter((c) => c.st === 'blocked').forEach((c) => items.push(mk(s.id, 'soa', c.id, ['Applicability entry: ' + c.title, 'Entri keberlakuan: ' + c.title], ['Add risk-based justification', 'Tambahkan justifikasi berbasis risiko'], c.owner, null, { missing: true, gate: true, down: [c.id], q: s.q })));
      (X.soa || []).forEach((x) => items.push(mk(s.id, 'x', x.id, same(x.t), same(x.act), x.h, x.due, { gate: x.gate, up: x.up, down: x.down, q: s.q })));
    } else if (s.src === 'doc') {
      recs[s.id] = d.docs.length;
      d.docs.forEach((doc) => {
        if (doc.st === 'approved') return;
        items.push(mk(s.id, 'doc', doc.id, same(doc.title + ', v' + doc.ver), DOC_TEXT[doc.st], doc.owner, doc.rev, { ref: doc, up: d.reqs.filter((c) => c.doc === doc.id).slice(0, 3).map((c) => c.id), q: s.q }));
      });
    } else if (s.src === 'ev') {
      recs[s.id] = d.evs.length;
      d.evs.forEach((e) => {
        const bad = UNVERIFIABLE.includes(e.integ); const stale = e.fresh === 'expired' || e.fresh === 'critical';
        if (!bad && !stale) return;
        const act = bad
          ? ['Re-link file in repository (' + D.INTEG[e.integ][0] + ')', 'Tautkan ulang berkas di repositori (' + D.INTEG[e.integ][1] + ')']
          : ['Submit ' + D.FREQ[e.freq][0].toLowerCase() + ' evidence', 'Serahkan evidence ' + D.FREQ[e.freq][1].toLowerCase()];
        items.push(mk(s.id, 'ev', e.code, same(e.title + ', ' + e.ctrl), act, e.owner, e.next, { missing: e.integ === 'missing' || e.integ === 'revoked', ref: e, up: [e.ctrl], q: s.q }));
      });
    } else {
      recs[s.id] = s.rec;
      (X[s.id] || []).forEach((x) => items.push(mk(s.id, 'x', x.id, same(x.t), same(x.act), x.h, x.due, { gate: x.gate, up: x.up, down: x.down, q: s.q })));
    }
  });
  return { items: items.filter((i) => !(ov[i.key] || {}).done), recs };
}

/** Gate items (UI 2.4): blocked requirements, then every explicit record holding a gate. Overrides are not applied (UI 5.11). */
export function gateItems(D, d) {
  const X = D.X[d.ms.id] || {};
  const out = d.reqs.filter((c) => c.st === 'blocked').map((c) => ({
    id: c.id, type: d.ms.unit === 'ctrl' ? ['Control', 'Kontrol'] : ['Requirement', 'Persyaratan'],
    why: c.note ? same(c.note) : D.T.blocked, h: c.owner, due: null, key: 'req:' + c.id,
  }));
  Object.keys(X).forEach((k) => (X[k] || []).forEach((x) => {
    if (x.gate) out.push({ id: x.id, type: GATE_TYPE[k] || same(k), why: same(x.act), h: x.h, due: x.due, key: 'x:' + x.id });
  }));
  return out;
}

/** Explicit chain record with this id in any stage of the system, with its stage key; null when there is none. */
export function findX(D, ms, id, anyCase) {
  const X = D.X[ms.id] || {};
  const eq = (x) => (anyCase ? x.id.toLowerCase() === String(id).toLowerCase() : x.id === id);
  for (const k in X) { const f = (X[k] || []).find(eq); if (f) return { ...f, stage: k }; }
  return null;
}

/** Title of any record of the system by id: requirement, document, evidence, explicit record, else TITLES. */
export function titleOf(D, d, id) {
  const c = d.reqs.find((x) => x.id === id); if (c) return c.title;
  const doc = d.docs.find((x) => x.id === id); if (doc) return doc.title;
  const e = d.evs.find((x) => x.code === id); if (e) return e.title;
  const x = findX(D, d.ms, id); if (x) return x.t;
  return D.TITLES[id] || '';
}

/** Phases with their activities and counts (UI 2.7). */
export function phases(D, ov, d) {
  const ms = d.ms, defs = D.PHASES[ms.id], ps = D.PHASE_STATE[ms.id]; const ppl = OWNER_POOL[ms.id];
  return defs.map((p, pi) => {
    const no = pi + 1;
    const acts = p.acts.map((title, ai) => {
      const key = ms.id + ':act:' + no + '.' + (ai + 1); let st, blocker = null; const o = ps.ov[no + ':' + (ai + 1)];
      if (o) { if (o.startsWith('blocked:')) { st = 'blocked'; blocker = o.slice(8); } else st = o; }
      else if (no <= ps.verifiedUpTo) st = 'verified';
      else if (ps.lockedFrom && no >= ps.lockedFrom) st = 'locked';
      else if (no === ps.current) st = 'progress';
      else st = 'ns';
      const v = ov[key] || {}; if (v.st) st = v.st;
      let owner = v.h || ppl[(pi * 3 + ai) % ppl.length];
      if (blocker && !v.h) { const c = d.reqs.find((x) => x.id === blocker); const x = findX(D, ms, blocker); owner = c ? c.owner : x ? x.h : owner; }
      const om = D.OUTPUT_MAP.find(([k]) => title.toLowerCase().includes(k.toLowerCase())); const out = om ? om[1] : null;
      const doc = out ? d.docs.find((x) => x.id === out) : null;
      // Sample fabrication (UI 2.15): verified and due dates spread from fixed start dates.
      const date = st === 'verified' ? D.addD('2024-09-01', pi * 45 + ai * 4) : st === 'locked' ? null : (v.due || D.addD('2026-10-01', (ai * 6 + pi * 3) % 50));
      return { key, no: no + '.' + (ai + 1), title, st, blocker, owner, out, doc, date, pno: no, by: v.by };
    });
    const n = (s) => acts.filter((a) => a.st === s).length;
    return { no, n: p.n, gate: !!p.gate, acts, c: { verified: n('verified'), complete: n('complete'), progress: n('progress'), blocked: n('blocked'), ns: n('ns'), locked: n('locked') }, total: acts.length };
  });
}

/** Number of the current phase (UI 2.6): the first phase not fully verified and without a locked activity, else the last. */
export function overviewPhase(phs) {
  const p = phs.find((x) => x.c.verified < x.total && !x.c.locked) || phs[phs.length - 1];
  return p ? p.no : null;
}

/** Everything the controller reads for one system (UI 4.2 MsBundle). */
export function deriveBundle(D, ov, ms) {
  const d = data(D, ov, ms);
  return { reqs: d.reqs, docs: d.docs, evs: d.evs, chain: chain(D, ov, d), gates: gateItems(D, d), phases: phases(D, ov, d) };
}
