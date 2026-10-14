// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Journey({ v }) {
  return (
    <>{v.isJourney ? (<>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--pad)" }}>
        <div style={{ background: "#1c1a17", color: "#f2eee7", borderRadius: "var(--r)", padding: "calc(var(--pad) + 8px) calc(var(--pad) + 10px) calc(var(--pad) + 6px)", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
            <div style={{ position: "absolute", right: "-10%", top: "-60%", width: "55%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(232,115,26,.38),transparent 60%)", filter: "blur(30px)", animation: "meshA 16s ease-in-out infinite" }}></div>
            <div style={{ position: "absolute", left: "20%", bottom: "-80%", width: "45%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(31,138,138,.26),transparent 60%)", filter: "blur(36px)", animation: "meshB 20s ease-in-out infinite" }}></div>
          </div>
          <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "18px", flexWrap: "wrap" }}>
            <div style={{ minWidth: "0", maxWidth: "660px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12.5px", color: "#cfc7b8" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: v.jr?.ms?.color }}></span>
                  <span style={{ fontWeight: "600", color: "#f2eee7" }}>{txt(v.jr?.ms?.short)}</span>{txt(v.jr?.ms?.code)}
                </span>
                <span style={{ padding: "2px 9px", borderRadius: "999px", background: "rgba(232,115,26,.22)", color: "#ffb87a", fontWeight: "600" }}>{txt(v.jr?.eyebrow)}</span>
              </div>
              <div style={{ fontSize: "1.8em", fontWeight: "600", marginTop: "10px", lineHeight: "1.15", letterSpacing: "-.01em" }}>{txt(v.jr?.title)}</div>
              <div style={{ color: "#cfc7b8", marginTop: "6px", lineHeight: "1.5" }}>{txt(v.jr?.what)}</div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", marginTop: "14px", padding: "6px 12px", borderRadius: "999px", background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.16)", fontSize: "12.5px", maxWidth: "100%" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                  <path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"></path>
                </svg>
                <span style={{ color: "#cfc7b8" }}>{txt(v.jr?.nextLabel)}</span>
                <span style={{ fontWeight: "600" }}>{txt(v.jr?.next)}</span>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "flex-end", maxWidth: "440px" }}>
              {list(v.jr?.systems).map((s, $i17) => (<Fragment key={$i17}>
                <button onClick={s?.go} title={s?.label} style={{ display: "inline-flex", alignItems: "center", gap: "8px", height: "32px", padding: "0 12px 0 10px", borderRadius: "999px", border: `1px solid ${s?.bd ?? ''}`, background: s?.bg, color: "#f2eee7", font: "inherit", fontSize: "12.5px", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: s?.color }}></span>
                  <span style={{ fontWeight: "600" }}>{txt(s?.short)}</span>
                  <span style={{ color: "#cfc7b8" }}>{txt(s?.label)}</span>
                  <span style={{ fontFamily: "var(--ffm)", color: "#cfc7b8" }}>{txt(s?.n)}</span>
                </button>
              </Fragment>))}
            </div>
          </div>
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: "0", marginTop: "28px" }}>
            <div style={{ position: "absolute", left: "7.14%", right: "7.14%", top: "22px", height: "2px", background: "rgba(255,255,255,.14)" }}></div>
            <div style={{ position: "absolute", left: "7.14%", top: "22px", height: "2px", width: v.jr?.fillW, background: "linear-gradient(90deg,#1f7a48,#e8731a)", transformOrigin: "left", animation: "growX .9s cubic-bezier(.2,.7,.2,1) both" }}></div>
            {list(v.jr?.track).map((s, $i18) => (<Fragment key={$i18}>
              <button onClick={s?.go} title={s?.short} aria-disabled={s?.off} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", border: "0", background: "transparent", color: "inherit", cursor: s?.cursor, font: "inherit", padding: "0 4px", minWidth: "0" }}>
                <span style={{ width: "44px", height: "44px", borderRadius: "13px", display: "flex", alignItems: "center", justifyContent: "center", background: s?.dotBg, color: s?.dotFg, border: `1.5px solid ${s?.dotBd ?? ''}` }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                    <path d={s?.d}></path>
                  </svg>
                </span>{" "}
                <span style={{ fontSize: "12.5px", fontWeight: s?.fw, textAlign: "center", lineHeight: "1.25", color: s?.lc }}>{txt(s?.no)}{". "}{txt(s?.short)}</span>
              </button>
            </Fragment>))}
          </div>
        </div>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", overflow: "hidden" }}>
          {list(v.jr?.stages).map((s, $i19) => (<Fragment key={$i19}>
            <div style={{ display: "grid", gridTemplateColumns: "34px minmax(0,1.1fr) minmax(0,1.7fr) 190px", gap: "18px", alignItems: "start", padding: "16px var(--pad)", borderBottom: "1px solid var(--bd)", background: s?.rowBg }}>
              <span style={{ width: "32px", height: "32px", borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--ffm)", fontWeight: "600", background: s?.numBg, color: s?.numFg }}>{txt(s?.no)}</span>
              <div style={{ minWidth: "0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: "600", fontSize: "1.05em" }}>{txt(s?.title)}</span>
                  <span style={{ fontSize: "12px", fontWeight: "600", padding: "2px 8px", borderRadius: "999px", background: s?.tagBg, color: s?.tagFg, whiteSpace: "nowrap" }}>{txt(s?.tag)}</span>
                  <span data-tip={s?.who} tabIndex="0" role="img" aria-label={s?.who} style={{ display: "inline-flex", width: "24px", height: "24px", borderRadius: "7px", alignItems: "center", justifyContent: "center", background: "var(--sur2)", color: "var(--tx3)", cursor: "help" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
                    </svg>
                  </span>
                </div>
                <div style={{ color: "var(--tx2)", marginTop: "4px", lineHeight: "1.45" }}>{txt(s?.what)}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px 16px", minWidth: "0" }}>
                {list(s?.checks).map((c, $i20) => (<Fragment key={$i20}>
                  <div style={{ display: "grid", gridTemplateColumns: "20px minmax(0,1fr)", gap: "8px", alignItems: "start", fontSize: "12.5px", minWidth: "0" }}>
                    <span style={{ width: "20px", height: "20px", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", background: c?.bg, color: c?.fg, marginTop: "1px" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                        <path d={c?.d}></path>
                      </svg>
                    </span>
                    <span style={{ minWidth: "0" }}>
                      <span style={{ display: "block", color: "var(--tx3)" }}>{txt(c?.label)}</span>
                      <span style={{ display: "block", color: "var(--tx)", fontWeight: "500", overflowWrap: "anywhere" }}>{txt(c?.val)}</span>
                    </span>
                  </div>
                </Fragment>))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {list(s?.acts).map((a, $i21) => (<Fragment key={$i21}>
                  <button onClick={a?.go} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", height: "32px", padding: "0 10px 0 12px", borderRadius: "8px", border: `1px solid ${a?.bd ?? ''}`, background: a?.bg, color: a?.fg, font: "inherit", fontSize: "12.5px", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}>{txt(a?.label)}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                      <path d="M9 6l6 6-6 6"></path>
                    </svg>
                  </button>
                </Fragment>))}
              </div>
            </div>
          </Fragment>))}
        </div>
      </div>
    </>) : null}</>
  );
}
