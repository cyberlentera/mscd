// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function FrameworkLibrary({ v }) {
  return (
    <>{v.isFw ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
              <th style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.standard)}</th>
              <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.editions)}</th>
              <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.packVersion)}</th>
              <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_status)}</th>
              <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.activeMs)}</th>
              <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.repo)}</th>
              <th style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}></th>
            </tr>
          </thead>
          <tbody>
            {list(v.fw?.cards).map((f, $i72) => (<Fragment key={$i72}>
              <tr data-hov="1" style={{ transition: "background .15s" }}>
                <td style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                  <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                    <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: f?.color, marginTop: "5px", flex: "none" }}></span>
                    <span>
                      <span style={{ display: "block", fontWeight: "600", whiteSpace: "nowrap" }}>{txt(f?.code)}</span>
                      <span style={{ display: "block", fontSize: "12px", color: "var(--tx3)" }}>{txt(f?.name)}</span>
                    </span>
                  </div>
                </td>
                <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top", color: "var(--tx2)", whiteSpace: "nowrap" }}>{txt(f?.edsShort)}</td>
                <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                  <span style={{ fontFamily: "var(--ffm)" }}>{txt(f?.pack)}</span>
                  <span style={{ display: "block", fontSize: "12px", color: "var(--ok)", marginTop: "2px" }}>{"✓ "}{txt(f?.sig)}{", "}{txt(f?.installed)}</span>
                </td>
                <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                  <span style={{ display: "inline-flex", padding: "3px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: "600", background: f?.bg, color: f?.fg, whiteSpace: "nowrap" }}>{txt(f?.status)}</span>
                  {f?.update ? (<>
                    <span style={{ display: "block", fontSize: "12px", color: "var(--info)", marginTop: "4px", maxWidth: "220px" }}>{txt(v.t?.updateAvail)}{" "}{txt(f?.updateShort)}</span>
                  </>) : null}
                </td>
                <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                  <span style={{ fontWeight: "600" }}>{txt(f?.short)}</span>
                  <span style={{ display: "block", fontSize: "12px", color: "var(--tx3)" }}>{txt(f?.certifier)}</span>
                </td>
                <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap" }}>
                    <span style={{ width: "26px", height: "26px", borderRadius: "7px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--sur2)", color: f?.locColor }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d={f?.locIcon}></path>
                      </svg>
                    </span>
                    <span style={{ lineHeight: "1.25" }}>
                      <span style={{ display: "block", fontWeight: "500" }}>{txt(f?.locShort)}</span>
                      <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(f?.locMode)}</span>
                    </span>
                  </span>
                </td>
                <td style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", verticalAlign: "top", width: "1%" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "stretch" }}>
                    {f?.transition ? (<>
                      <button onClick={f?.goTransition} style={{ height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--acc)", background: "var(--acc)", color: "#fff", font: "inherit", fontSize: "var(--fs)", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(v.t?.transitionShort)}</button>
                    </>) : null}
                    <button onClick={f?.go} style={{ height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(v.t?.manage)}</button>
                  </div>
                </td>
              </tr>
            </Fragment>))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "#1c1a17", color: "#f2eee7", borderRadius: "var(--r)", padding: "var(--pad) calc(var(--pad) + 4px)", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "20px", alignItems: "center", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
            <div style={{ position: "absolute", right: "-10%", top: "-60%", width: "55%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(232,115,26,.38),transparent 60%)", filter: "blur(30px)", animation: "meshA 16s ease-in-out infinite" }}></div>
            <div style={{ position: "absolute", left: "30%", bottom: "-80%", width: "45%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(122,79,211,.22),transparent 60%)", filter: "blur(36px)", animation: "meshB 20s ease-in-out infinite" }}></div>
          </div>
          <div style={{ position: "relative", minWidth: "0" }}>
            <div style={{ fontSize: "12px", letterSpacing: ".08em", textTransform: "uppercase", color: "#cfc7b8" }}>{txt(v.t?.licence)}</div>
            <div style={{ fontSize: "1.3em", fontWeight: "600", marginTop: "4px" }}>{txt(v.fw?.org)}</div>
            <div style={{ color: "#cfc7b8", marginTop: "4px", fontSize: "12.5px" }}>{txt(v.t?.validTo)}{" "}
              <strong style={{ color: "#f2eee7" }}>{txt(v.fw?.to)}</strong>{", "}{txt(v.t?.signature)}{" ✓ "}{txt(v.fw?.sig)}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" }}>
              {list(v.fw?.featureChips).map((fc, $i73) => (<Fragment key={$i73}>
                <span style={{ padding: "3px 9px", borderRadius: "999px", fontSize: "12px", border: "1px solid rgba(255,255,255,.18)", color: "#f2eee7" }}>{txt(fc)}</span>
              </Fragment>))}
            </div>
          </div>
          <div style={{ position: "relative", display: "flex", gap: "20px" }}>
            {list(v.fw?.lic).map((l, $i74) => (<Fragment key={$i74}>
              <div style={{ textAlign: "center", minWidth: "64px" }}>
                <div style={{ fontSize: "26px", fontWeight: "600", lineHeight: "1" }}>{txt(l?.n)}</div>
                <div style={{ fontSize: "12px", color: "#cfc7b8", marginTop: "4px", whiteSpace: "nowrap" }}>{txt(l?.k)}</div>
                <div style={{ height: "4px", borderRadius: "2px", background: "rgba(255,255,255,.14)", marginTop: "8px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${l?.pct ?? ''}%`, background: "var(--acc)" }}></div>
                </div>
              </div>
            </Fragment>))}
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "var(--pad)", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: "600" }}>{txt(v.fw?.channelTitle)}</span>
            <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.t?.adapters)}{": "}{txt(v.fw?.adapters)}</span>
          </div>
          <div style={{ color: "var(--tx2)", lineHeight: "1.6" }}>{txt(v.fw?.channelText)}</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "auto" }}>
            <button onClick={v.fw?.check} style={{ height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(v.fw?.checkLabel)}</button>
          </div>
        </div>
      </div>
    </>) : null}</>
  );
}
