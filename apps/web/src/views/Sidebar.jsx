// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Sidebar({ v }) {
  return (
    <aside style={{ position: "sticky", top: "0", height: "100vh", overflow: "auto", background: "var(--sur)", borderRight: "1px solid var(--bd)", display: "flex", flexDirection: "column", gap: "14px", padding: `14px ${v.sbPad ?? ''} 18px`, boxSizing: "border-box", transition: "padding .2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
          <div style={{ background: "#fff", borderRadius: "8px", padding: "5px 7px", border: "1px solid var(--bd)", display: "flex", alignItems: "center", flex: "none" }}>
            <img src="assets/cyberlentera-logo.png" alt="CyberLentera" style={{ height: "20px", display: "block", width: "auto", maxWidth: v.logoMax }} />
          </div>
          {v.sbOpen ? (<>
            <div style={{ minWidth: "0" }}>
              <div style={{ fontWeight: "700", letterSpacing: ".02em", fontSize: "22px", fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>{"MSCD"}</div>
            </div>
          </>) : null}
        </div>
        {v.sbOpen ? (<>
          <button onClick={v.toggleSb} title={v.t?.collapse} style={{ flex: "none", width: "28px", height: "28px", borderRadius: "7px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx2)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
              <path d="M3 4h18v16H3zM9 4v16"></path>
            </svg>
          </button>
        </>) : null}
      </div>
      {v.sbClosed ? (<>
        <button onClick={v.toggleSb} title={v.t?.expand} style={{ width: "36px", height: "32px", borderRadius: "7px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx2)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
            <path d="M9 18l6-6-6-6"></path>
          </svg>
        </button>
      </>) : null}
      <div style={{ position: "relative" }}>
        <button onClick={v.toggleOrgMenu} title={v.orgName} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: "8px", width: "100%", textAlign: "left", padding: v.orgPad, borderRadius: "8px", background: "var(--sur2)", border: "1px solid var(--bd)", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
          {v.sbOpen ? (<>
            <span style={{ minWidth: "0" }}>
              <span style={{ display: "block", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)" }}>{txt(v.t?.organisation)}</span>
              <span style={{ display: "block", fontWeight: "600", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(v.orgName)}</span>
            </span>
            <span style={{ color: "var(--tx3)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                <path d="M6 9l6 6 6-6"></path>
              </svg>
            </span>
          </>) : null}{" "}
          {v.sbClosed ? (<>
            <span style={{ width: "100%", textAlign: "center", fontWeight: "700", fontSize: "12px", letterSpacing: ".04em" }}>{txt(v.orgInitials)}</span>
          </>) : null}
        </button>
        {v.orgMenu ? (<>
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: "0", minWidth: "260px", background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "10px", padding: "6px", zIndex: "30", animation: "drawerIn .18s ease" }}>
            {list(v.orgOptions).map((o, $i0) => (<Fragment key={$i0}>
              <button onClick={o?.go} style={{ display: "block", width: "100%", textAlign: "left", border: "0", borderRadius: "8px", padding: "8px 10px", cursor: "pointer", background: o?.bg, color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
                <span style={{ fontWeight: "600", display: "block" }}>{txt(o?.name)}</span>
                <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(o?.sub)}</span>
              </button>
            </Fragment>))}
          </div>
        </>) : null}
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {list(v.nav).map((g, $i1) => (<Fragment key={$i1}>
          <div>
            {g?.label ? (<>
              {v.sbOpen ? (<>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", padding: "0 10px 6px" }}>
                  {g?.no ? (<>
                    <span style={{ flex: "none", width: "18px", height: "18px", borderRadius: "5px", background: "var(--tx)", color: "var(--bg)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--ffm)", fontSize: "12px", fontWeight: "600", letterSpacing: "0" }}>{txt(g?.no)}</span>
                  </>) : null}{txt(g?.label)}
                </div>
              </>) : null}
              {v.sbClosed ? (<>
                <div style={{ height: "1px", background: "var(--bd)", margin: "2px 6px 8px" }}></div>
              </>) : null}
            </>) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {list(g?.items).map((it, $i2) => (<Fragment key={$i2}>
                <button onClick={it?.go} title={it?.label} style={{ display: "flex", alignItems: "center", justifyContent: v.navJustify, gap: "8px", width: "100%", textAlign: "left", border: "0", borderRadius: "8px", padding: `8px ${v.navPx ?? ''}`, cursor: "pointer", fontSize: "var(--fs)", fontWeight: it?.fw, background: it?.bg, color: it?.fg, position: "relative" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: "0" }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", opacity: it?.iop }}>
                      <path d={it?.icon}></path>
                    </svg>
                    {v.sbOpen ? (<>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(it?.label)}</span>
                    </>) : null}
                  </span>{" "}
                  {it?.n ? (<>
                    {v.sbOpen ? (<>
                      <span style={{ fontSize: "12px", fontWeight: "600", padding: "1px 7px", borderRadius: "999px", background: it?.nbg, color: it?.nfg }}>{txt(it?.n)}</span>
                    </>) : null}
                    {v.sbClosed ? (<>
                      <span style={{ position: "absolute", top: "5px", right: "6px", width: "8px", height: "8px", borderRadius: "50%", background: it?.nfg }}></span>
                    </>) : null}
                  </>) : null}
                </button>
              </Fragment>))}
            </div>
          </div>
        </Fragment>))}
      </nav>
      {v.sbOpen ? (<>
        <div style={{ marginTop: "auto", padding: "0 6px", fontSize: "12px", color: "var(--tx3)", lineHeight: "1.5" }}>{txt(v.t?.frameworkPack)}
          <br />
          <span style={{ fontFamily: "var(--ffm)", color: "var(--tx2)" }}>{txt(v.pack)}</span>
        </div>
      </>) : null}
    </aside>
  );
}
