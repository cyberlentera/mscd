// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Drawer({ v }) {
  return (
    <>{v.showPanel ? (<>
      <div onClick={v.closeSel} style={{ position: "fixed", inset: "0", background: "rgba(20,16,10,.25)", zIndex: "40" }}></div>
      <div style={{ position: "fixed", top: "0", right: "0", bottom: "0", width: "560px", background: "var(--sur)", borderLeft: "1px solid var(--bd)", zIndex: "41", overflow: "auto", animation: "drawerIn .22s ease", fontFamily: "var(--ff)", fontSize: "var(--fs)", color: "var(--tx)" }} className="mscd" data-theme={v.theme} data-density={v.density}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px var(--pad)", borderBottom: "1px solid var(--bd)", position: "sticky", top: "0", background: "var(--sur)" }}>
          <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.crumb2)}</span>
          <button onClick={v.closeSel} style={{ border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", borderRadius: "6px", width: "28px", height: "28px", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
              <path d="M18 6L6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div style={{ padding: "var(--pad) calc(var(--pad) + 4px)", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(v.det?.id)}</span>
              {list(v.det?.badges).map((b, $i87) => (<Fragment key={$i87}>
                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "max(12px, .9em)", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.v)}</span>
              </Fragment>))}
              {v.det?.note ? (<>
                <span data-tip={v.det?.note?.text} style={{ display: "inline-flex", width: "18px", height: "18px", borderRadius: "50%", background: v.det?.note?.bg, color: v.det?.note?.fg, fontSize: "12px", alignItems: "center", justifyContent: "center", cursor: "help", fontWeight: "700" }}>{"i"}</span>
              </>) : null}
            </div>
            <div style={{ fontSize: "1.3em", fontWeight: "600", marginTop: "4px", lineHeight: "1.3" }}>{txt(v.det?.title)}</div>
            {v.det?.q ? (<>
              <div style={{ marginTop: "6px", fontStyle: "italic", color: "var(--tx2)" }}>{txt(v.t?.auditorQ)}{": \""}{txt(v.det?.q)}{"\""}</div>
            </>) : null}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", rowGap: "8px", columnGap: "12px" }}>
            {list(v.det?.facts).map((f, $i88) => (<Fragment key={$i88}>
              <div style={{ color: "var(--tx3)", fontSize: "max(12px, .9em)", paddingTop: "1px" }}>{txt(f?.k)}</div>
              <div style={{ fontFamily: f?.ff }}>
                {f?.go ? (<>
                  <button onClick={f?.go} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--acc)", cursor: "pointer", textDecoration: "underline", textAlign: "left" }}>{txt(f?.v)}</button>
                </>) : null}
                {f?.plain ? (<>
                  <span style={{ color: f?.ink }}>{txt(f?.v)}</span>
                </>) : null}
              </div>
            </Fragment>))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.upstream)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {list(v.det?.up).map((l, $i89) => (<Fragment key={$i89}>
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
                {list(v.det?.down).map((l, $i90) => (<Fragment key={$i90}>
                  <button onClick={l?.go} style={{ border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", borderRadius: "6px", padding: "3px 8px", fontFamily: "var(--ffm)", fontSize: "max(12px, .9em)", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(l?.v)}</button>
                </Fragment>))}
                {v.det?.noDown ? (<>
                  <span style={{ color: "var(--bad)", fontSize: "max(12px, .9em)" }}>{"- "}{txt(v.det?.noDown)}</span>
                </>) : null}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingTop: "6px", borderTop: "1px solid var(--bd)" }}>
            {list(v.det?.actions).map((a, $i91) => (<Fragment key={$i91}>
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
    </>) : null}</>
  );
}
