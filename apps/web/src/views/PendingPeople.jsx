// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function PendingPeople({ v }) {
  return (
    <>{v.people ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontWeight: "600" }}>{txt(v.t?.perPerson)}</span>
          <span title={v.t?.perPersonSub} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "11px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
              <th style={{ padding: "8px var(--pad)", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_holder)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.open)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.overdue)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.after)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_next)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.stagesHeld)}</th>
            </tr>
          </thead>
          <tbody>
            {list(v.people).map((p, $i59) => (<Fragment key={$i59}>
              <tr onClick={p?.go} data-hov="1" style={{ cursor: "pointer", background: p?.bg }}>
                <td style={{ padding: "6px var(--pad)", height: "var(--rh)", borderBottom: "1px solid var(--bd)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ width: "24px", height: "24px", borderRadius: "50%", background: p?.abg, color: p?.afg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700" }}>{txt(p?.i)}</span>
                    <span style={{ lineHeight: "1.25", whiteSpace: "nowrap" }}>
                      <span style={{ fontWeight: "500", display: "block" }}>{txt(p?.name)}</span>
                      <span style={{ fontSize: ".9em", color: "var(--tx3)" }}>{txt(p?.role)}</span>
                    </span>
                  </span>
                </td>
                <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(p?.open)}</td>
                <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--bd)", fontWeight: "600", color: p?.ovColor }}>{txt(p?.overdue)}</td>
                <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--bd)", fontWeight: "600", color: p?.afColor }}>{txt(p?.after)}</td>
                <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--bd)", whiteSpace: "nowrap" }}>{txt(p?.next)}</td>
                <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--bd)", color: "var(--tx2)", fontSize: ".95em" }}>{txt(p?.stagesText)}</td>
              </tr>
            </Fragment>))}
          </tbody>
        </table>
      </div>
    </>) : null}</>
  );
}
