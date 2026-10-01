// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Overview({ v }) {
  return (
    <>{v.isOverview ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
          <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.t?.maturity)}</span>
            <span style={{ display: "flex", gap: "12px", fontSize: "12px", color: "var(--tx3)", alignItems: "center" }}>
              {list(v.ov?.legend).map((lg, $i60) => (<Fragment key={$i60}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <svg width="12" height="12" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5"></circle>
                    <path d={lg?.d} fill="currentColor"></path>
                  </svg>{txt(lg?.label)}
                </span>
              </Fragment>))}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) repeat(4,56px) 72px", gap: "0 8px", padding: "8px var(--pad)", borderBottom: "1px solid var(--bd)", fontSize: "12px", letterSpacing: ".02em", color: "var(--tx3)" }}>
            <span>{txt(v.t?.clause)}</span>
            {list(v.ov?.dims).map((dm, $i61) => (<Fragment key={$i61}>
              <span style={{ textAlign: "center" }}>{txt(dm)}</span>
            </Fragment>))}
            <span style={{ textAlign: "right" }}>{txt(v.t?.level)}</span>
          </div>
          {list(v.ov?.clauses).map((c, $i62) => (<Fragment key={$i62}>
            <button onClick={c?.go} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) repeat(4,56px) 72px", gap: "0 8px", alignItems: "center", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: "transparent", padding: "0 var(--pad)", height: "46px", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
                <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", color: "var(--tx2)", width: "18px" }}>{txt(c?.n)}</span>
                <span style={{ fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(c?.title)}</span>
                {c?.open ? (<>
                  <span style={{ flex: "none", fontFamily: "var(--ffm)", fontSize: "12px", padding: "1px 6px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>{txt(c?.open)}</span>
                </>) : null}
              </span>{" "}
              {list(c?.cells).map((h, $i63) => (<Fragment key={$i63}>
                <span title={h?.title} style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "46px", background: h?.bg }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" style={{ color: h?.fg }}>
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5"></circle>
                    <path d={h?.d} fill="currentColor"></path>
                  </svg>
                </span>
              </Fragment>))}{" "}
              <span title={c?.levelLabel} style={{ textAlign: "right", fontFamily: "var(--ffm)", fontWeight: "600", fontSize: "1.05em", color: c?.ink }}>{txt(c?.level)}</span>
            </button>
          </Fragment>))}
          <div style={{ padding: "8px var(--pad)", fontSize: "12px", color: "var(--tx3)", display: "flex", justifyContent: "space-between" }}>
            <span>{txt(v.ov?.gateLine)}</span>
            <span>{txt(v.t?.levelScale)}</span>
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.t?.phaseTracker)}</span>
            <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.t?.nextGate)}{": "}
              <strong style={{ color: "var(--tx)" }}>{txt(v.ov?.nextGate)}</strong>
            </span>
          </div>
          {list(v.ov?.phases).map((p, $i64) => (<Fragment key={$i64}>
            <button onClick={p?.go} style={{ display: "grid", gridTemplateColumns: "22px 1fr 90px 70px", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: p?.bg, padding: "8px var(--pad)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
              <span style={{ width: "18px", height: "18px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700", background: p?.dotBg, color: p?.dotFg }}>{txt(p?.no)}</span>{" "}
              <span style={{ fontWeight: p?.fw }}>{txt(p?.name)}
                {p?.gate ? (<>
                  <span style={{ marginLeft: "6px", fontSize: "12px", padding: "1px 6px", borderRadius: "4px", background: "var(--badbg)", color: "var(--bad)" }}>{txt(v.t?.gateTag)}</span>
                </>) : null}
              </span>{" "}
              <span style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .8s cubic-bezier(.2,.7,.2,1) both" }}>
                {list(p?.seg).map((sg, $i65) => (<Fragment key={$i65}>
                  <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                </Fragment>))}
              </span>{" "}
              <span style={{ fontSize: "12px", textAlign: "right", color: p?.stColor }}>{txt(p?.stLabel)}</span>
            </button>
          </Fragment>))}
        </div>
      </div>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(v.t?.blockers)}</div>
        {list(v.ov?.blockers).map((b, $i66) => (<Fragment key={$i66}>
          <button onClick={b?.go} style={{ display: "grid", gridTemplateColumns: "110px 1fr 220px 150px", alignItems: "center", gap: "14px", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: "transparent", padding: "10px var(--pad)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
            <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(b?.id)}</span>{" "}
            <span>
              <span style={{ fontWeight: "500" }}>{txt(b?.title)}</span>
              <br />
              <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(b?.act)}</span>
            </span>{" "}
            <span style={{ fontSize: "12.5px", color: "var(--tx2)" }}>{txt(b?.holder)}</span>{" "}
            <span style={{ display: "inline-flex", justifyContent: "flex-end" }}>
              <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.tag)}</span>
            </span>
          </button>
        </Fragment>))}
      </div>
    </>) : null}</>
  );
}
