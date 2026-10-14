// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Overview({ v }) {
  return (
    <>{v.isOverview ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)" }}>
          <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.t?.maturity)}</span>
            <span style={{ display: "flex", gap: "12px", fontSize: "12px", color: "var(--tx3)", alignItems: "center" }}>
              {list(v.ov?.legend).map((lg, $i72) => (<Fragment key={$i72}>
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
            {list(v.ov?.dims).map((dm, $i73) => (<Fragment key={$i73}>
              <span style={{ textAlign: "center" }}>{txt(dm)}</span>
            </Fragment>))}
            <span style={{ textAlign: "right" }}>{txt(v.t?.level)}</span>
          </div>
          {list(v.ov?.clauses).map((c, $i74) => (<Fragment key={$i74}>
            {c?.go ? (<>
              <button onClick={c?.go} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) repeat(4,56px) 72px", gap: "0 8px", alignItems: "center", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: "transparent", padding: "0 var(--pad)", height: "46px", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
                  <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", color: "var(--tx2)", width: "18px" }}>{txt(c?.n)}</span>
                  <span style={{ fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(c?.title)}</span>
                  {c?.open ? (<>
                    <span style={{ flex: "none", fontFamily: "var(--ffm)", fontSize: "12px", padding: "1px 6px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>{txt(c?.open)}</span>
                  </>) : null}
                </span>{" "}
                {list(c?.cells).map((h, $i75) => (<Fragment key={$i75}>
                  <span title={h?.title} style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "46px", background: h?.bg }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" style={{ color: h?.fg }}>
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5"></circle>
                      <path d={h?.d} fill="currentColor"></path>
                    </svg>
                  </span>
                </Fragment>))}{" "}
                <span title={c?.levelLabel} style={{ textAlign: "right", fontFamily: "var(--ffm)", fontWeight: "600", fontSize: "1.05em", color: c?.ink }}>{txt(c?.level)}</span>
              </button>
            </>) : null}
            {c?.plain ? (<>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) repeat(4,56px) 72px", gap: "0 8px", alignItems: "center", boxSizing: "border-box", borderBottom: "1px solid var(--bd)", padding: "0 var(--pad)", height: "46px", color: "var(--tx)", fontSize: "var(--fs)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
                  <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", color: "var(--tx2)", width: "18px" }}>{txt(c?.n)}</span>
                  <span style={{ fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(c?.title)}</span>
                  {c?.open ? (<>
                    <span style={{ flex: "none", fontFamily: "var(--ffm)", fontSize: "12px", padding: "1px 6px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>{txt(c?.open)}</span>
                  </>) : null}
                </span>{" "}
                {list(c?.cells).map((h, $i76) => (<Fragment key={$i76}>
                  <span title={h?.title} style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "46px", background: h?.bg }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" style={{ color: h?.fg }}>
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5"></circle>
                      <path d={h?.d} fill="currentColor"></path>
                    </svg>
                  </span>
                </Fragment>))}{" "}
                <span title={c?.levelLabel} style={{ textAlign: "right", fontFamily: "var(--ffm)", fontWeight: "600", fontSize: "1.05em", color: c?.ink }}>{txt(c?.level)}</span>
              </div>
            </>) : null}
          </Fragment>))}
          <div style={{ padding: "8px var(--pad)", fontSize: "12px", color: "var(--tx3)", display: "flex", justifyContent: "space-between" }}>
            <span>{txt(v.ov?.gateLine)}</span>
            <span>{txt(v.t?.levelScale)}</span>
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.t?.phaseTracker)}</span>
            <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.t?.nextGate)}{": "}
              <strong style={{ color: "var(--tx)" }}>{txt(v.ov?.nextGate)}</strong>
            </span>
          </div>
          {list(v.ov?.phases).map((p, $i77) => (<Fragment key={$i77}>
            {p?.go ? (<>
              <button onClick={p?.go} style={{ display: "grid", gridTemplateColumns: "22px 1fr 90px 70px", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: p?.bg, padding: "8px var(--pad)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
                <span style={{ width: "18px", height: "18px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700", background: p?.dotBg, color: p?.dotFg }}>{txt(p?.no)}</span>{" "}
                <span style={{ fontWeight: p?.fw, display: "flex", alignItems: "center", gap: "6px", minWidth: "0" }}>
                  <span style={{ minWidth: "0" }}>{txt(p?.name)}</span>
                  {p?.gate ? (<>
                    <span data-tip={v.t?.gateTag} role="img" aria-label={v.t?.gateTag} style={{ flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                        <path d="M4 22V4M4 4h13l-2 4 2 4H4"></path>
                      </svg>
                    </span>
                  </>) : null}
                </span>{" "}
                <span style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .8s cubic-bezier(.2,.7,.2,1) both" }}>
                  {list(p?.seg).map((sg, $i78) => (<Fragment key={$i78}>
                    <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                  </Fragment>))}
                </span>{" "}
                <span style={{ fontSize: "12px", textAlign: "right", color: p?.stColor }}>{txt(p?.stLabel)}</span>
              </button>
            </>) : null}
            {p?.plain ? (<>
              <div style={{ display: "grid", gridTemplateColumns: "22px 1fr 90px 70px", alignItems: "center", gap: "10px", borderBottom: "1px solid var(--bd)", background: p?.bg, padding: "8px var(--pad)", color: "var(--tx)", fontSize: "var(--fs)" }}>
                <span style={{ width: "18px", height: "18px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700", background: p?.dotBg, color: p?.dotFg }}>{txt(p?.no)}</span>{" "}
                <span style={{ fontWeight: p?.fw, display: "flex", alignItems: "center", gap: "6px", minWidth: "0" }}>
                  <span style={{ minWidth: "0" }}>{txt(p?.name)}</span>
                  {p?.gate ? (<>
                    <span data-tip={v.t?.gateTag} tabIndex="0" role="img" aria-label={v.t?.gateTag} style={{ flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                        <path d="M4 22V4M4 4h13l-2 4 2 4H4"></path>
                      </svg>
                    </span>
                  </>) : null}
                </span>{" "}
                <span style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .8s cubic-bezier(.2,.7,.2,1) both" }}>
                  {list(p?.seg).map((sg, $i79) => (<Fragment key={$i79}>
                    <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                  </Fragment>))}
                </span>{" "}
                <span style={{ fontSize: "12px", textAlign: "right", color: p?.stColor }}>{txt(p?.stLabel)}</span>
              </div>
            </>) : null}
          </Fragment>))}
        </div>
      </div>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(v.t?.blockers)}</div>
        {list(v.ov?.blockers).map((b, $i80) => (<Fragment key={$i80}>
          {b?.go ? (<>
            <button onClick={b?.go} data-tip={b?.act} style={{ display: "grid", gridTemplateColumns: "110px 1fr 220px 150px", alignItems: "center", gap: "14px", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: "transparent", padding: "10px var(--pad)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
              <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(b?.id)}</span>{" "}
              <span style={{ fontWeight: "500" }}>{txt(b?.title)}</span>{" "}
              <span style={{ fontSize: "12.5px", color: "var(--tx2)" }}>{txt(b?.holder)}</span>{" "}
              <span style={{ display: "inline-flex", justifyContent: "flex-end" }}>
                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.tag)}</span>
              </span>
            </button>
          </>) : null}
          {b?.plain ? (<>
            <div data-tip={b?.act} tabIndex="0" style={{ display: "grid", gridTemplateColumns: "110px 1fr 220px 150px", alignItems: "center", gap: "14px", borderBottom: "1px solid var(--bd)", padding: "10px var(--pad)", color: "var(--tx)", fontSize: "var(--fs)" }}>
              <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(b?.id)}</span>{" "}
              <span style={{ fontWeight: "500" }}>{txt(b?.title)}</span>{" "}
              <span style={{ fontSize: "12.5px", color: "var(--tx2)" }}>{txt(b?.holder)}</span>{" "}
              <span style={{ display: "inline-flex", justifyContent: "flex-end" }}>
                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.tag)}</span>
              </span>
            </div>
          </>) : null}
        </Fragment>))}
      </div>
    </>) : null}</>
  );
}
