// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function GoldenThread({ v }) {
  return (
    <>{v.gt ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", padding: "12px var(--pad)", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <input value={v.gt?.q ?? ''} onChange={v.gt?.setQ} onKeyDown={v.gt?.key} placeholder={v.t?.gtSearch} style={{ flex: "1", minWidth: "280px", height: "36px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", fontSize: "var(--fs)", outline: "none", fontFamily: "var(--ffm)" }} />{" "}
        <button onClick={v.gt?.run} style={{ height: "36px", padding: "0 16px", borderRadius: "8px", border: "1px solid var(--acc)", background: "var(--acc)", color: "var(--onacc)", font: "inherit", fontSize: "var(--fs)", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>{txt(v.t?.trace)}</button>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "12px" }}>
          {list(v.gt?.sugg).map((s, $i34) => (<Fragment key={$i34}>
            <button onClick={s?.go} style={{ height: "26px", padding: "0 9px", borderRadius: "999px", border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx2)", font: "inherit", fontSize: "12px", cursor: "pointer", fontFamily: "var(--ffm)", whiteSpace: "nowrap" }}>{txt(s?.id)}</button>
          </Fragment>))}
        </div>
        <div style={{ width: "100%", fontSize: "12.5px", color: "var(--tx3)" }}>{txt(v.t?.gtSub)}{", "}{txt(v.t?.renderedIn)}{" "}{txt(v.gt?.ms)}{" ms"}</div>
      </div>
      {v.gt?.none ? (<>
        <div style={{ background: "var(--sur)", border: "1px dashed var(--bd)", borderRadius: "var(--r)", padding: "calc(var(--pad) * 2)", textAlign: "center", color: "var(--tx2)" }}>{txt(v.gt?.none)}</div>
      </>) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "0", maxWidth: "980px" }}>
        {list(v.gt?.nodes).map((n, $i35) => (<Fragment key={$i35}>
          <div style={{ display: "grid", gridTemplateColumns: "150px 28px 1fr", gap: "0", animation: "popIn .45s cubic-bezier(.2,.7,.2,1) both", animationDelay: n?.delay }}>
            <div style={{ padding: "14px 12px 14px 0", textAlign: "right" }}>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: "700", color: n?.fg }}>{txt(n?.stage)}</div>
              {n?.clause ? (<>
                <div style={{ fontSize: "12px", color: "var(--bad)", marginTop: "2px" }}>{txt(v.t?.clauseViolated)}{" "}{txt(n?.clause)}</div>
              </>) : null}
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ position: "absolute", left: "12px", top: "0", bottom: "0", width: "2px", background: n?.lineColor, transformOrigin: "top", animation: "drawLine .5s both", animationDelay: n?.delay }}></div>
              <div style={{ position: "absolute", left: "6px", top: "18px", width: "14px", height: "14px", borderRadius: "50%", background: n?.fg, border: "3px solid var(--bg)", animation: n?.dotAnim }}></div>
            </div>
            <button onClick={n?.go} style={{ textAlign: "left", margin: "6px 0", background: "var(--sur)", border: `1px solid ${n?.bd ?? ''}`, borderLeft: `4px solid ${n?.fg ?? ''}`, borderRadius: "10px", padding: "12px 14px", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)", boxShadow: "var(--sh)" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(n?.id)}</span>
                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: n?.bg, color: n?.fg }}>{txt(n?.stLabel)}</span>
                {n?.shared ? (<>
                  <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: "var(--infobg)", color: "var(--info)" }}>{txt(v.t?.shared)}{", "}{txt(n?.shared)}</span>
                </>) : null}
                <span style={{ marginLeft: "auto", fontSize: "12.5px", color: "var(--tx2)" }}>{txt(n?.owner)}</span>
              </div>
              <div style={{ fontWeight: "500", marginTop: "4px" }}>{txt(n?.title)}</div>
              {n?.sub ? (<>
                <div style={{ fontSize: "12.5px", color: n?.subColor, marginTop: "4px" }}>{txt(n?.sub)}</div>
              </>) : null}
            </button>
          </div>
        </Fragment>))}
      </div>
    </>) : null}</>
  );
}
