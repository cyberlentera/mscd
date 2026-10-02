// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function PageDetail({ v }) {
  return (
    <>{v.showPage ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
        <div style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>
          <button onClick={v.closeSel} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", fontSize: "var(--fs)", color: "var(--acc)", cursor: "pointer", fontWeight: "500", display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
              <path d="M19 12H5M11 18l-6-6 6-6"></path>
            </svg>{" "}{txt(v.t?.back)}
          </button>
        </div>
        <div style={{ padding: "calc(var(--pad) * 1.5)", display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: "calc(var(--pad) * 2)" }}>
          <div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(v.det?.id)}</span>
              {list(v.det?.badges).map((b, $i54) => (<Fragment key={$i54}>
                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "max(12px, .9em)", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.v)}</span>
              </Fragment>))}
              {v.det?.note ? (<>
                <span title={v.det?.note?.text} style={{ display: "inline-flex", width: "18px", height: "18px", borderRadius: "50%", background: v.det?.note?.bg, color: v.det?.note?.fg, fontSize: "12px", alignItems: "center", justifyContent: "center", cursor: "help", fontWeight: "700" }}>{"i"}</span>
              </>) : null}
            </div>
            <div style={{ fontSize: "1.4em", fontWeight: "600", marginTop: "4px" }}>{txt(v.det?.title)}</div>
            {v.det?.q ? (<>
              <div style={{ marginTop: "6px", fontStyle: "italic", color: "var(--tx2)" }}>{txt(v.t?.auditorQ)}{": \""}{txt(v.det?.q)}{"\""}</div>
            </>) : null}
            <div style={{ marginTop: "14px", display: "grid", gridTemplateColumns: "170px 1fr", rowGap: "8px", columnGap: "12px" }}>
              {list(v.det?.facts).map((f, $i55) => (<Fragment key={$i55}>
                <div style={{ color: "var(--tx3)", fontSize: "max(12px, .9em)", paddingTop: "1px" }}>{txt(f?.k)}</div>
                <div style={{ fontFamily: f?.ff }}>
                  {f?.go ? (<>
                    <button onClick={f?.go} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--acc)", cursor: "pointer", textDecoration: "underline" }}>{txt(f?.v)}</button>
                  </>) : null}
                  {f?.plain ? (<>
                    <span style={{ color: f?.ink }}>{txt(f?.v)}</span>
                  </>) : null}
                </div>
              </Fragment>))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.upstream)}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {list(v.det?.up).map((l, $i56) => (<Fragment key={$i56}>
                    <button onClick={l?.go} style={{ border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", borderRadius: "6px", padding: "3px 8px", fontFamily: "var(--ffm)", fontSize: "max(12px, .9em)", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(l?.v)}</button>
                  </Fragment>))}
                  {v.det?.noUp ? (<>
                    <span style={{ color: "var(--bad)", fontSize: "max(12px, .9em)" }}>{"- "}{txt(v.det?.noUp)}</span>
                  </>) : null}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.downstream)}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {list(v.det?.down).map((l, $i57) => (<Fragment key={$i57}>
                    <button onClick={l?.go} style={{ border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", borderRadius: "6px", padding: "3px 8px", fontFamily: "var(--ffm)", fontSize: "max(12px, .9em)", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(l?.v)}</button>
                  </Fragment>))}
                  {v.det?.noDown ? (<>
                    <span style={{ color: "var(--bad)", fontSize: "max(12px, .9em)" }}>{"- "}{txt(v.det?.noDown)}</span>
                  </>) : null}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {list(v.det?.actions).map((a, $i58) => (<Fragment key={$i58}>
                <button onClick={a?.go} title={a?.label} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "34px", minWidth: "34px", padding: `0 ${a?.px ?? ''}`, borderRadius: "8px", border: `1px solid ${a?.bd ?? ''}`, background: a?.bg, color: a?.fg, font: "inherit", fontSize: "var(--fs)", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>
                  {a?.icon ? (<>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                      <path d={a?.icon}></path>
                    </svg>
                  </>) : null}
                  {a?.txt ? (<>{txt(a?.txt)}
                  </>) : null}
                </button>
              </Fragment>))}
            </div>
          </div>
        </div>
      </div>
    </>) : null}</>
  );
}
