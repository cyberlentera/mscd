// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function MyTasks({ v }) {
  return (
    <>{v.isTasks ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "#1c1a17", color: "#f2eee7", borderRadius: "var(--r)", padding: "calc(var(--pad) + 6px) calc(var(--pad) + 8px)", display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "24px", alignItems: "center", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
            <div style={{ position: "absolute", right: "-10%", top: "-60%", width: "55%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(232,115,26,.38),transparent 60%)", filter: "blur(30px)", animation: "meshA 16s ease-in-out infinite" }}></div>
            <div style={{ position: "absolute", left: "30%", bottom: "-80%", width: "45%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(122,79,211,.22),transparent 60%)", filter: "blur(36px)", animation: "meshB 20s ease-in-out infinite" }}></div>
          </div>
          <div style={{ position: "relative", width: "118px", height: "118px" }}>
            <svg viewBox="0 0 120 120" width="118" height="118" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="12"></circle>
              <circle cx="60" cy="60" r="50" fill="none" stroke="var(--acc)" strokeWidth="12" strokeLinecap="round" strokeDasharray={v.tasks?.ring?.dash} style={{ transition: "stroke-dasharray .8s cubic-bezier(.2,.7,.2,1)" }}></circle>
            </svg>
            <div style={{ position: "absolute", inset: "0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: "1" }}>
              <span style={{ fontSize: "30px", fontWeight: "600" }}>{txt(v.tasks?.ring?.pct)}{"%"}</span>
              <span style={{ fontSize: "12px", color: "#cfc7b8", marginTop: "4px" }}>{txt(v.t?.onTrack)}</span>
            </div>
          </div>
          <div style={{ position: "relative", minWidth: "0" }}>
            <div style={{ fontSize: "12px", letterSpacing: ".08em", textTransform: "uppercase", color: "#cfc7b8" }}>{txt(v.tasks?.dateLabel)}</div>
            <div style={{ fontSize: "1.55em", fontWeight: "600", marginTop: "4px", lineHeight: "1.2" }}>{txt(v.tasks?.greeting)}</div>
            <div style={{ color: "#cfc7b8", marginTop: "6px", lineHeight: "1.5" }}>{txt(v.tasks?.summary)}</div>
            <div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
              {list(v.tasks?.bySystem).map((b, $i79) => (<Fragment key={$i79}>
                <button onClick={b?.go} style={{ display: "inline-flex", alignItems: "center", gap: "8px", height: "30px", padding: "0 10px 0 8px", borderRadius: "999px", border: "1px solid rgba(255,255,255,.18)", background: b?.bg, color: "#f2eee7", font: "inherit", fontSize: "12.5px", cursor: "pointer" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: b?.color }}></span>
                  <span style={{ fontWeight: "600" }}>{txt(b?.short)}</span>
                  <span style={{ fontFamily: "var(--ffm)", color: "#cfc7b8" }}>{txt(b?.n)}</span>
                </button>
              </Fragment>))}
            </div>
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "var(--pad)", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.t?.thisWeek)}</span>
            <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.tasks?.weekRange)}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: "6px", flex: "1" }}>
            {list(v.tasks?.week).map((w, $i80) => (<Fragment key={$i80}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "8px 0", borderRadius: "10px", background: w?.bg, border: `1px solid ${w?.bd ?? ''}` }}>
                <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(w?.dow)}</span>{" "}
                <span style={{ fontSize: "15px", fontWeight: "600", color: w?.fg }}>{txt(w?.day)}</span>{" "}
                <span style={{ display: "flex", gap: "3px", height: "8px", alignItems: "flex-end" }}>
                  {list(w?.dots).map((dt, $i81) => (<Fragment key={$i81}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: dt }}></span>
                  </Fragment>))}
                </span>
              </div>
            </Fragment>))}
          </div>
          <div style={{ display: "flex", gap: "14px", fontSize: "12px", color: "var(--tx3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--bad)" }}></span>{txt(v.t?.overdueGroup)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--warn)" }}></span>{txt(v.t?.weekGroup)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--acc)" }}></span>{txt(v.t?.auditDay)}
            </span>
          </div>
        </div>
      </div>
      {v.tasks?.empty ? (<>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "calc(var(--pad) * 3)", textAlign: "center" }}>
          <div style={{ fontSize: "1.2em", fontWeight: "600" }}>{txt(v.t?.caughtUp)}</div>
          <div style={{ color: "var(--tx2)", marginTop: "4px" }}>{txt(v.t?.caughtUpSub)}</div>
        </div>
      </>) : null}
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>
          {list(v.tasks?.filters).map((f, $i82) => (<Fragment key={$i82}>
            <button onClick={f?.go} style={{ height: "28px", padding: "0 10px", borderRadius: "999px", border: `1px solid ${f?.bd ?? ''}`, background: f?.bg, color: f?.fg, font: "inherit", fontSize: "12px", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px" }}>{txt(f?.label)}
              <span style={{ fontFamily: "var(--ffm)" }}>{txt(f?.n)}</span>
            </button>
          </Fragment>))}{" "}
          <span style={{ marginLeft: "auto", display: "inline-flex" }}>
            <span data-tip={v.tasks?.sortNote} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
          </span>
        </div>
        {list(v.tasks?.feed).map((k, $i83) => (<Fragment key={$i83}>
          <div style={{ display: "grid", gridTemplateColumns: "4px 44px minmax(0,1fr) 150px 150px", gap: "14px", alignItems: "center", padding: "12px var(--pad) 12px 0", borderBottom: "1px solid var(--bd)", animation: "riseIn .4s cubic-bezier(.2,.7,.2,1) both", animationDelay: k?.delay, transition: "background .15s" }} className="hv9">
            <span style={{ height: "100%", minHeight: "52px", background: k?.tone, borderRadius: "0 3px 3px 0" }}></span>{" "}
            <span style={{ width: "44px", height: "44px", borderRadius: "12px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: k?.iconBg, color: k?.iconFg }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={k?.icon}></path>
              </svg>
            </span>{" "}
            <span style={{ minWidth: "0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--tx3)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: k?.color }}></span>{txt(k?.short)}
                <span style={{ fontFamily: "var(--ffm)" }}>{txt(k?.id)}</span>
                <span>{txt(k?.kindLabel)}</span>
              </span>{" "}
              <span style={{ display: "block", fontWeight: "600", fontSize: "1.05em", marginTop: "2px", lineHeight: "1.3" }}>{txt(k?.title)}</span>{" "}
              <span style={{ display: "block", color: "var(--tx2)", marginTop: "2px", lineHeight: "1.45", fontSize: "max(12px, .95em)" }}>{txt(k?.what)}</span>
            </span>{" "}
            <span style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
              <span style={{ padding: "3px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap", background: k?.bg, color: k?.fg }}>{txt(k?.due)}</span>
              <span data-tip={k?.examples} style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--tx3)", cursor: "help" }}>
                <span style={{ display: "inline-flex", width: "14px", height: "14px", borderRadius: "50%", border: "1px solid var(--tx3)", alignItems: "center", justifyContent: "center", fontSize: "12px", fontFamily: "var(--ffm)" }}>{"i"}</span>{txt(v.t?.accepted)}
              </span>
            </span>{" "}
            <span style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
              <button onClick={k?.go} style={{ height: "34px", padding: "0 14px", borderRadius: "8px", border: `1px solid ${k?.btnBd ?? ''}`, background: k?.btnBg, color: k?.btnFg, font: "inherit", fontSize: "var(--fs)", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={k?.btnIcon}></path>
                </svg>{txt(k?.btn)}
              </button>
            </span>
          </div>
        </Fragment>))}
      </div>
    </>) : null}</>
  );
}
