// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Timeline({ v }) {
  return (
    <>{v.tl ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", padding: "var(--pad) var(--pad) 10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "12px" }}>
          <span style={{ fontWeight: "600", whiteSpace: "nowrap" }}>{txt(v.t?.cycleTimeline)}</span>
          <span style={{ display: "flex", gap: "14px", fontSize: "12px", color: "var(--tx3)", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--tx2)" }}></span>{txt(v.t?.pastEvent)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", border: "2.5px solid var(--acc)", boxSizing: "border-box" }}></span>{txt(v.t?.nextEvent)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", border: "2px solid var(--bd)", boxSizing: "border-box" }}></span>{txt(v.t?.plannedEvent)}
            </span>
          </span>
        </div>
        <div style={{ position: "relative", paddingLeft: "150px" }}>
          <div style={{ position: "relative", height: "18px", borderBottom: "1px solid var(--bd)" }}>
            {list(v.tl?.years).map((y, $i48) => (<Fragment key={$i48}>
              <span style={{ position: "absolute", left: `${y?.x ?? ''}%`, top: "0", fontSize: "12px", color: "var(--tx3)", fontFamily: "var(--ffm)" }}>{txt(y?.label)}</span>
            </Fragment>))}
          </div>
          <div style={{ position: "absolute", left: `calc(150px + (100% - 150px) * ${v.tl?.todayF ?? ''})`, top: "0", bottom: "0", width: "0", borderLeft: "2px dashed var(--acc)", zIndex: "1", transformOrigin: "top", animation: "drawLine .8s cubic-bezier(.2,.7,.2,1) both" }}>
            <span style={{ position: "absolute", top: "-2px", left: "6px", fontSize: "12px", color: "var(--acc)", fontWeight: "600", whiteSpace: "nowrap" }}>{txt(v.t?.today)}</span>
          </div>
          {list(v.tl?.lanes).map((l, $i49) => (<Fragment key={$i49}>
            <div style={{ position: "relative", height: "58px", borderBottom: "1px solid var(--bd)" }}>
              <div data-tip={l?.certifier} style={{ position: "absolute", left: "-150px", top: "0", bottom: "0", width: "138px", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: "0" }}>
                <span style={{ fontWeight: "600", color: l?.ink }}>{txt(l?.short)}</span>
              </div>
              <div style={{ position: "absolute", left: `${l?.x0 ?? ''}%`, width: `${l?.w ?? ''}%`, top: "27px", height: "4px", borderRadius: "2px", background: l?.color, opacity: ".35" }}></div>
              {l?.none ? (<>
                <button onClick={l?.add} style={{ position: "absolute", left: `${v.tl?.todayPct ?? ''}%`, top: "16px", height: "26px", padding: "0 10px", borderRadius: "999px", border: "1px dashed var(--bd)", background: "var(--sur)", color: "var(--tx3)", font: "inherit", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", marginLeft: "14px" }}>{"+ "}{txt(v.t?.addEvent)}</button>
              </>) : null}{" "}
              {list(l?.evts).map((e, $i50) => (<Fragment key={$i50}>
                <button onClick={e?.go} title={e?.title} style={{ position: "absolute", left: `${e?.x ?? ''}%`, top: "20px", transform: "translateX(-50%)", width: "18px", height: "18px", borderRadius: "50%", background: e?.fill, border: `3px solid ${e?.ring ?? ''}`, cursor: "pointer", padding: "0", boxShadow: e?.sh, animation: e?.anim }}></button>{" "}
                <span style={{ position: "absolute", left: `${e?.x ?? ''}%`, top: e?.ly, transform: "translateX(-50%)", fontSize: "12px", color: e?.lc, whiteSpace: "nowrap", fontWeight: e?.fw }}>{txt(e?.short)}</span>
              </Fragment>))}
            </div>
          </Fragment>))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", padding: "var(--pad)", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)" }}>{txt(v.t?.eventDetail)}{", "}{txt(v.tl?.evt?.short)}</div>
              <div style={{ fontSize: "1.25em", fontWeight: "600", marginTop: "2px" }}>{txt(v.tl?.evt?.title)}</div>
              <div style={{ color: "var(--tx2)" }}>{txt(v.tl?.evt?.date)}{", "}{txt(v.tl?.evt?.days)}{" "}{txt(v.t?.auditDays)}{", "}{txt(v.tl?.evt?.certifier)}{", "}{txt(v.tl?.evt?.lead)}</div>
            </div>
            <span style={{ padding: "3px 10px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: v.tl?.evt?.bg, color: v.tl?.evt?.fg, whiteSpace: "nowrap" }}>{txt(v.tl?.evt?.tag)}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", rowGap: "6px", columnGap: "12px", fontSize: "max(12px, .95em)" }}>
            <span style={{ color: "var(--tx3)" }}>{txt(v.t?.scope)}</span>
            <span>{txt(v.tl?.evt?.scope)}</span>
            <span style={{ color: "var(--tx3)" }}>{txt(v.t?.expectedFocus)}</span>
            <span>{txt(v.tl?.evt?.focus)}</span>
            {v.tl?.evt?.result ? (<>
              <span style={{ color: "var(--tx3)" }}>{txt(v.t?.results)}</span>
              <span style={{ fontWeight: "600" }}>{txt(v.tl?.evt?.result)}</span>
            </>) : null}
            {v.tl?.evt?.window ? (<>
              <span style={{ color: "var(--tx3)" }}>{txt(v.t?.prepWindow)}</span>
              <span>{txt(v.tl?.evt?.window)}</span>
            </>) : null}
          </div>
          {v.tl?.evt?.ready ? (<>
            <div style={{ display: "flex", gap: "0", border: "1px solid var(--bd)", borderRadius: "8px", overflow: "hidden" }}>
              {list(v.tl?.evt?.ready).map((r, $i51) => (<Fragment key={$i51}>
                <div style={{ flex: "1", padding: "10px 12px", borderRight: "1px solid var(--bd)" }}>
                  <div style={{ fontSize: "20px", fontWeight: "600", color: r?.ink }}>{txt(r?.n)}</div>
                  <div style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(r?.l)}</div>
                </div>
              </Fragment>))}
              <button onClick={v.tl?.evt?.goReady} style={{ flex: "none", border: "0", background: "var(--accbg)", color: "var(--acc)", padding: "0 14px", font: "inherit", fontSize: "var(--fs)", fontWeight: "600", cursor: "pointer" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>{txt(v.t?.openReadiness)}{" "}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                    <path d="M5 12h14M13 6l6 6-6 6"></path>
                  </svg>
                </span>
              </button>
            </div>
          </>) : null}
          {v.tl?.evt?.prep ? (<>
            <div>
              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{txt(v.t?.prepChecklist)}</div>
              {list(v.tl?.evt?.prep).map((p, $i52) => (<Fragment key={$i52}>
                <div style={{ display: "grid", gridTemplateColumns: "20px 1fr 170px 110px", gap: "10px", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--bd)" }}>
                  <span style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1.5px solid ${p?.bd ?? ''}`, background: p?.bg, color: p?.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700" }}>{txt(p?.mark)}</span>
                  <span style={{ textDecoration: p?.deco }}>{txt(p?.title)}</span>
                  <span style={{ fontSize: "12.5px", color: "var(--tx2)" }}>{txt(p?.owner)}</span>
                  <span style={{ fontSize: "12.5px", textAlign: "right", color: p?.dueFg }}>{txt(p?.due)}</span>
                </div>
              </Fragment>))}
            </div>
          </>) : null}
          {v.tl?.evt?.findings ? (<>
            <div>
              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{txt(v.tl?.evt?.findingsTitle)}</div>
              {list(v.tl?.evt?.findings).map((f, $i53) => (<Fragment key={$i53}>
                <div data-tip={f?.tip} style={{ display: "grid", gridTemplateColumns: "110px 70px 1fr 120px", gap: "10px", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--bd)" }}>
                  <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(f?.id)}</span>
                  <span style={{ padding: "1px 7px", borderRadius: "5px", fontSize: "12px", fontWeight: "600", background: f?.cbg, color: f?.cfg, textAlign: "center" }}>{txt(f?.cls)}</span>
                  <span>{txt(f?.title)}</span>
                  <span style={{ textAlign: "right", fontSize: "12.5px", fontWeight: "600", color: f?.fg }}>{txt(f?.st)}</span>
                </div>
              </Fragment>))}
            </div>
          </>) : null}
          {v.tl?.evt?.prereq ? (<>
            <div>
              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{txt(v.t?.prereq)}</div>
              <ul style={{ margin: "0", paddingLeft: "18px", color: "var(--tx2)", lineHeight: "1.7" }}>
                {list(v.tl?.evt?.prereq).map((p, $i54) => (<Fragment key={$i54}>
                  <li>{txt(p)}</li>
                </Fragment>))}
              </ul>
            </div>
          </>) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--pad)" }}>
          <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
            <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontWeight: "600" }}>{txt(v.t?.cycleComplete)}</span>
                <span data-tip={v.t?.cycleSub} tabIndex="0" role="img" aria-label={v.t?.cycleSub} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
              </div>
              <button onClick={v.tl?.toggleCycle} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", fontSize: "12.5px", color: "var(--acc)", cursor: "pointer", fontWeight: "500" }}>{txt(v.tl?.cycleBtn)}</button>
            </div>
            {list(v.tl?.cycle).map((c, $i55) => (<Fragment key={$i55}>
              <div data-tip={c?.tip} style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: "10px", alignItems: "start", padding: "9px var(--pad)", borderBottom: "1px solid var(--bd)" }}>
                <span style={{ marginTop: "2px", width: "16px", height: "16px", borderRadius: "50%", border: `1.5px solid ${c?.bd ?? ''}`, background: c?.bg, color: c?.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700" }}>{txt(c?.mark)}</span>
                <span>
                  <span style={{ fontWeight: "500" }}>{txt(c?.title)}</span>{" "}
                  <span style={{ fontFamily: "var(--ffm)", fontSize: "12px", color: "var(--tx3)" }}>{txt(c?.clause)}</span>
                </span>
                <span style={{ fontSize: "12.5px", color: c?.stFg, whiteSpace: "nowrap", textAlign: "right" }}>{txt(c?.st)}
                  <br />
                  <span style={{ color: "var(--tx3)", fontWeight: "400" }}>{txt(c?.due)}</span>
                </span>
              </div>
            </Fragment>))}
          </div>
          <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
            <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontWeight: "600" }}>{txt(v.t?.drift)}</span>
              <span data-tip={v.t?.driftSub} tabIndex="0" role="img" aria-label={v.t?.driftSub} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
            </div>
            {list(v.tl?.drift).map((dr, $i56) => (<Fragment key={$i56}>
              <button onClick={dr?.go} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "10px", alignItems: "center", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", background: dr?.rowBg, padding: "10px var(--pad)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
                <span style={{ fontWeight: "500" }}>{txt(dr?.label)}</span>
                <span style={{ padding: "2px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: "700", background: dr?.bg, color: dr?.fg }}>{txt(dr?.n)}{" "}{txt(v.t?.affected)}</span>
              </button>
            </Fragment>))}
          </div>
        </div>
      </div>
    </>) : null}</>
  );
}
