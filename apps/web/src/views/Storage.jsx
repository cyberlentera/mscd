// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Storage({ v }) {
  return (
    <>{v.isStorage ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "var(--pad)" }}>
        {list(v.st?.repos).map((r, $i29) => (<Fragment key={$i29}>
          <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", padding: "var(--pad)", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "10px", alignItems: "start" }}>
              <div data-tip={r?.tip} style={{ minWidth: "0" }}>
                <div style={{ fontSize: "1.1em", fontWeight: "600", lineHeight: "1.3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(r?.name)}</div>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: r?.bg, color: r?.fg, whiteSpace: "nowrap" }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "currentColor" }}></span>{txt(r?.status)}
              </span>
            </div>
            {r?.msg ? (<>
              <div style={{ padding: "8px 12px", borderRadius: "8px", background: r?.bg, color: r?.fg, fontSize: "max(12px, .95em)" }}>{txt(r?.msg)}</div>
            </>) : null}
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ flex: "1", display: "flex", height: "8px", borderRadius: "4px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .7s cubic-bezier(.2,.7,.2,1) both" }}>
                {list(r?.seg).map((sg, $i30) => (<Fragment key={$i30}>
                  <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                </Fragment>))}
              </span>{" "}
              <span style={{ fontFamily: "var(--ffm)", fontSize: "12.5px", color: "var(--tx2)", whiteSpace: "nowrap" }}>{txt(r?.refLine)}</span>
            </div>
            <div style={{ display: "flex", gap: "16px", fontSize: "12.5px", flexWrap: "wrap" }}>
              {list(r?.stats).map((s, $i31) => (<Fragment key={$i31}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--tx2)" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: s?.color }}></span>
                  <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", color: "var(--tx)" }}>{txt(s?.n)}</span>{txt(s?.l)}
                </span>
              </Fragment>))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12.5px", color: "var(--tx3)" }}>
              <span>{txt(v.t?.scopeL)}</span>
              <span style={{ color: "var(--tx2)" }}>{txt(r?.tenant)}</span>
              <span>{txt(v.t?.c_ms)}</span>
              <span style={{ color: "var(--tx2)" }}>{txt(r?.ms)}</span>
              <span>{txt(v.t?.c_lastcheck)}</span>
              <span style={{ color: "var(--tx2)" }}>{txt(r?.last)}</span>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "auto" }}>
              {list(r?.actions).map((a, $i32) => (<Fragment key={$i32}>
                <button onClick={a?.go} title={a?.label} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", height: "32px", minWidth: "32px", padding: `0 ${a?.px ?? ''}`, borderRadius: "8px", border: `1px solid ${a?.bd ?? ''}`, background: a?.bg, color: a?.fg, font: "inherit", fontSize: "var(--fs)", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>
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
        </Fragment>))}
      </div>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", overflow: "hidden" }}>
        <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(v.t?.routing)}</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
              <th style={{ padding: "8px var(--pad)", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_ms)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_repo)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_default)}</th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_class)}</th>
            </tr>
          </thead>
          <tbody>
            {list(v.st?.routing).map((r, $i33) => (<Fragment key={$i33}>
              <tr>
                <td style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(r?.ms)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(r?.repo)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(r?.mode)}</td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", color: "var(--tx2)" }}>{txt(r?.rule)}</td>
              </tr>
            </Fragment>))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
        <span style={{ fontWeight: "600", fontSize: "1.05em" }}>{txt(v.t?.linkHealth)}</span>
        <span data-tip={v.st?.linkTip} tabIndex="0" role="img" aria-label={v.st?.linkTip} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
      </div>
    </>) : null}</>
  );
}
