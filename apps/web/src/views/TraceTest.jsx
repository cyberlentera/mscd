// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function TraceTest({ v }) {
  return (
    <>{v.trace ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: "600" }}>{txt(v.t?.traceTest)}</div>
            <div style={{ fontSize: "12.5px", color: "var(--tx3)" }}>{txt(v.t?.traceSub)}</div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {list(v.trace?.picks).map((p, $i30) => (<Fragment key={$i30}>
              <button onClick={p?.go} style={{ height: "28px", padding: "0 10px", borderRadius: "999px", border: `1px solid ${p?.bd ?? ''}`, background: p?.bg, color: p?.fg, font: "inherit", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", fontFamily: "var(--ffm)" }}>{txt(p?.label)}</button>
            </Fragment>))}
          </div>
        </div>
        <div style={{ padding: "calc(var(--pad) + 6px) var(--pad)", display: "flex", alignItems: "flex-start", gap: "0", overflow: "auto" }}>
          {list(v.trace?.nodes).map((n, $i31) => (<Fragment key={$i31}>
            <div style={{ display: "flex", alignItems: "flex-start", flex: "1 1 0", minWidth: "120px" }}>
              <button onClick={n?.go} style={{ flex: "1", minWidth: "0", textAlign: "left", border: `1.5px solid ${n?.fg ?? ''}`, background: n?.bg, borderRadius: "10px", padding: "10px 10px", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)", animation: n?.anim, animationDelay: n?.delay, transition: "transform .15s" }} className="hv3">
                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".04em", overflowWrap: "anywhere", color: n?.fg, fontWeight: "700" }}>{txt(n?.stage)}</div>
                <div style={{ fontFamily: "var(--ffm)", fontWeight: "600", marginTop: "4px" }}>{txt(n?.id)}</div>
                <div style={{ fontSize: "12px", color: "var(--tx2)", marginTop: "2px", lineHeight: "1.3", minHeight: "32px" }}>{txt(n?.title)}</div>
                {n?.holder ? (<>
                  <div style={{ fontSize: "12px", marginTop: "6px", paddingTop: "6px", borderTop: `1px dashed ${n?.fg ?? ''}`, color: n?.fg }}>
                    <strong>{txt(n?.holder)}</strong>
                    <br />{txt(n?.dueLabel)}
                  </div>
                </>) : null}
              </button>{" "}
              {n?.arrow ? (<>
                <span style={{ flex: "none", width: "18px", height: "2px", marginTop: "38px", background: n?.arrowColor, transformOrigin: "left", animation: "growX .3s both", animationDelay: n?.delay }}></span>
              </>) : null}
            </div>
          </Fragment>))}
        </div>
        <div style={{ padding: "12px var(--pad)", borderTop: "1px solid var(--bd)", display: "flex", gap: "12px", alignItems: "flex-start", background: v.trace?.warnBg, color: v.trace?.warnFg, borderRadius: "0 0 var(--r) var(--r)" }}>
          <span style={{ fontWeight: "700" }}>{txt(v.trace?.warnIcon)}</span>
          <span style={{ lineHeight: "1.55" }}>{txt(v.trace?.warning)}</span>
          <span style={{ marginLeft: "auto", fontSize: "12px", whiteSpace: "nowrap", fontFamily: "var(--ffm)" }}>{txt(v.t?.renderedIn)}{" "}{txt(v.trace?.ms)}{" ms"}</span>
        </div>
      </div>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", overflow: "hidden" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(v.t?.stageTable)}</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
              <th style={{ padding: "8px var(--pad)", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_stage)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)", minWidth: "220px" }}>{txt(v.t?.c_readiness)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.records)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_pending)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_overdue)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_after)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_nextdue)}</th>
            </tr>
          </thead>
          <tbody>
            {list(v.trace?.stages).map((s, $i32) => (<Fragment key={$i32}>
              <tr onClick={s?.go} data-hov="1" style={{ cursor: "pointer" }}>
                <td style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>
                  <div style={{ fontWeight: "600" }}>{txt(s?.label)}</div>
                  <div style={{ fontSize: "12px", color: "var(--tx3)", fontStyle: "italic" }}>{txt(s?.q)}</div>
                </td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ flex: "1", display: "flex", height: "8px", borderRadius: "4px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .8s cubic-bezier(.2,.7,.2,1) both" }}>
                      {list(s?.seg).map((sg, $i33) => (<Fragment key={$i33}>
                        <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                      </Fragment>))}
                    </span>
                    <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", width: "40px", textAlign: "right" }}>{txt(s?.pct)}{"%"}</span>
                  </div>
                </td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", fontFamily: "var(--ffm)" }}>{txt(s?.rec)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", fontFamily: "var(--ffm)", color: s?.pendColor }}>{txt(s?.pend)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", fontFamily: "var(--ffm)", color: s?.ovColor }}>{txt(s?.ov)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", fontFamily: "var(--ffm)", color: s?.afColor }}>{txt(s?.af)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", whiteSpace: "nowrap" }}>{txt(s?.next)}</td>
              </tr>
            </Fragment>))}
          </tbody>
        </table>
      </div>
    </>) : null}</>
  );
}
