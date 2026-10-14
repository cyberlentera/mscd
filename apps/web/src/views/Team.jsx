// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Team({ v }) {
  return (
    <>{v.isTeam ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "var(--pad)" }}>
          <div style={{ fontWeight: "600", marginBottom: "12px" }}>{txt(v.t?.tm_how)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px" }}>
            {list(v.tm?.steps).map((s, $i22) => (<Fragment key={$i22}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "10px", background: "var(--sur2)", minWidth: "0" }}>
                <span style={{ flex: "none", width: "34px", height: "34px", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accbg)", color: "var(--acc)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                    <path d={s?.icon}></path>
                  </svg>
                </span>
                <span style={{ minWidth: "0" }}>
                  <span style={{ display: "block", fontFamily: "var(--ffm)", fontSize: "12px", color: "var(--tx3)" }}>{"0"}{txt(s?.n)}</span>
                  <span style={{ display: "block", fontWeight: "500", lineHeight: "1.3" }}>{txt(s?.label)}</span>
                </span>
              </div>
            </Fragment>))}
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "var(--pad)", display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "12px", alignItems: "center" }}>
          {list(v.tm?.stats).map((s, $i23) => (<Fragment key={$i23}>
            <div style={{ minWidth: "0" }}>
              <div style={{ fontSize: "28px", fontWeight: "600", lineHeight: "1.1", color: s?.ink }}>{txt(s?.n)}</div>
              <div style={{ fontSize: "12.5px", color: "var(--tx3)", marginTop: "4px", lineHeight: "1.35" }}>{txt(s?.l)}</div>
            </div>
          </Fragment>))}
        </div>
      </div>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "880px" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
              {list(v.tm?.cols).map((c, $i24) => (<Fragment key={$i24}>
                <th style={{ padding: "10px 14px", borderBottom: "1px solid var(--bd)", fontWeight: "600" }}>{txt(c)}</th>
              </Fragment>))}
            </tr>
          </thead>
          <tbody>
            {list(v.tm?.rows).map((r, $i25) => (<Fragment key={$i25}>
              <tr data-hov="">
                <td data-tip={r?.job} style={{ padding: "12px 14px", borderBottom: "1px solid var(--bd)", verticalAlign: "middle", width: "240px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
                    <span style={{ flex: "none", width: "34px", height: "34px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "600", fontSize: "12.5px", background: r?.abg, color: r?.afg }}>{txt(r?.i)}</span>
                    <span style={{ fontWeight: "600", minWidth: "0" }}>{txt(r?.name)}</span>
                  </div>
                </td>
                <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--bd)", borderLeft: "1px solid var(--bd)", verticalAlign: "middle" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {list(r?.roles).map((g, $i26) => (<Fragment key={$i26}>
                      {g?.go ? (<>
                        <button onClick={g?.go} style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 9px 0 7px", borderRadius: "999px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", font: "inherit", fontSize: "12.5px", cursor: "pointer", whiteSpace: "nowrap" }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: g?.color }}></span>
                          <span style={{ fontWeight: "600" }}>{txt(g?.short)}</span>
                          <span style={{ color: "var(--tx2)" }}>{txt(g?.label)}</span>
                        </button>
                      </>) : null}
                      {g?.plain ? (<>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "26px", padding: "0 9px 0 7px", fontSize: "12.5px", whiteSpace: "nowrap" }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: g?.color }}></span>
                          <span style={{ fontWeight: "600" }}>{txt(g?.short)}</span>
                          <span style={{ color: "var(--tx2)" }}>{txt(g?.label)}</span>
                        </span>
                      </>) : null}
                    </Fragment>))}
                  </div>
                </td>
                <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--bd)", borderLeft: "1px solid var(--bd)", verticalAlign: "middle", color: "var(--tx2)", width: "200px" }}>{txt(r?.owns)}</td>
                <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--bd)", borderLeft: "1px solid var(--bd)", verticalAlign: "middle", width: "180px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                    <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", fontSize: "1.05em" }}>{txt(r?.open)}</span>
                    <span style={{ fontSize: "12.5px", color: "var(--bad)" }}>{txt(r?.over)}</span>
                  </div>
                  <div style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--sur2)", marginTop: "6px", transformOrigin: "left", animation: "growX .7s cubic-bezier(.2,.7,.2,1) both" }}>
                    {list(r?.seg).map((sg, $i27) => (<Fragment key={$i27}>
                      <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color }}></span>
                    </Fragment>))}
                  </div>
                </td>
                <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--bd)", borderLeft: "1px solid var(--bd)", verticalAlign: "middle", textAlign: "right", width: "140px" }}>
                  {r?.canGo ? (<>
                    <button onClick={r?.go} style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "30px", padding: "0 10px 0 12px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", font: "inherit", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(r?.btn)}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                        <path d="M9 6l6 6-6 6"></path>
                      </svg>
                    </button>
                  </>) : null}
                </td>
              </tr>
            </Fragment>))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "var(--pad)" }}>
        {list(v.tm?.rules).map((r, $i28) => (<Fragment key={$i28}>
          <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "12px var(--pad)", display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ flex: "none", width: "36px", height: "36px", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--badbg)", color: "var(--bad)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                <path d={r?.icon}></path>
              </svg>
            </span>
            <span style={{ fontWeight: "600", flex: "1", minWidth: "0" }}>{txt(r?.title)}</span>
            <span data-tip={r?.detail} tabIndex="0" role="img" aria-label={r?.detail} style={{ display: "inline-flex", width: "18px", height: "18px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
          </div>
        </Fragment>))}
      </div>
    </>) : null}</>
  );
}
