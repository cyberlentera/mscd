// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function TopBar({ v }) {
  return (
    <header style={{ position: "sticky", top: "0", zIndex: "20", display: "flex", alignItems: "center", gap: "14px", height: "56px", padding: "0 var(--pad)", background: "var(--sur)", borderBottom: "1px solid var(--bd)", boxSizing: "border-box" }}>
      <div style={{ position: "relative" }}>
        <button onClick={v.toggleMsMenu} title={v.t?.switchMs} style={{ display: "flex", alignItems: "center", gap: "10px", height: "36px", padding: "0 12px 0 10px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur2)", cursor: "pointer", color: "var(--tx)", fontSize: "var(--fs)", whiteSpace: "nowrap", flex: "none" }}>
          <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: v.ms?.color }}></span>{" "}
          <span style={{ fontWeight: "600" }}>{txt(v.ms?.short)}</span>
          <span style={{ color: "var(--tx2)" }}>{txt(v.ms?.code)}</span>{" "}
          {v.msArrow ? (<>
            <span style={{ color: "var(--tx3)", display: "inline-flex" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                <path d="M6 9l6 6 6-6"></path>
              </svg>
            </span>
          </>) : null}
        </button>
        {v.msMenuOpen ? (<>
          <div style={{ position: "absolute", top: "42px", left: "0", width: "420px", background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "12px", padding: "8px", zIndex: "30", animation: "drawerIn .18s ease" }}>
            <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", padding: "6px 10px" }}>{txt(v.t?.switchMs)}</div>
            {list(v.msOptions).map((o, $i3) => (<Fragment key={$i3}>
              <button onClick={o?.go} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", border: "0", borderRadius: "8px", padding: "9px 10px", cursor: "pointer", background: o?.bg, color: "var(--tx)", fontSize: "var(--fs)" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: o?.color }}></span>{" "}
                <span>
                  <span style={{ fontWeight: "600" }}>{txt(o?.short)}</span>{" "}
                  <span style={{ color: "var(--tx2)" }}>{txt(o?.code)}</span>
                </span>{" "}
                <span style={{ fontSize: "12px", color: "var(--tx3)", textAlign: "right" }}>{txt(o?.stage)}</span>
              </button>
            </Fragment>))}
            {v.goIntegrated ? (<>
              <div style={{ borderTop: "1px solid var(--bd)", margin: "6px 0" }}></div>
              <button onClick={v.goIntegrated} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", border: "0", borderRadius: "8px", padding: "9px 10px", cursor: "pointer", background: "transparent", color: "var(--tx)", fontSize: "var(--fs)" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: "linear-gradient(135deg,#e8731a,#3a6fd8,#1f8a8a,#7a4fd3)" }}></span>
                <span style={{ fontWeight: "600" }}>{txt(v.t?.integrated)}</span>
                <span style={{ color: "var(--tx3)" }}>{"IMS"}</span>
              </button>
            </>) : null}
          </div>
        </>) : null}
      </div>
      <div style={{ marginLeft: "auto", flex: "none", display: "flex", alignItems: "center", gap: "8px" }}>
        <div style={{ display: "flex", flex: "none", border: "1px solid var(--bd)", borderRadius: "999px", overflow: "hidden", height: "30px" }}>
          <button onClick={v.setEn} style={{ border: "0", padding: "0 10px", cursor: "pointer", fontSize: "12px", fontWeight: "600", background: v.enBg, color: v.enFg }}>{"EN"}</button>{" "}
          <button onClick={v.setId} style={{ border: "0", padding: "0 10px", cursor: "pointer", fontSize: "12px", fontWeight: "600", background: v.idBg, color: v.idFg }}>{"ID"}</button>
        </div>
        <button onClick={v.toggleTheme} title={v.t?.theme} style={{ height: "30px", width: "30px", borderRadius: "999px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx2)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={v.themeIcon}></path>
          </svg>
        </button>
        <div style={{ position: "relative" }}>
          <button onClick={v.toggleRoleMenu} style={{ display: "flex", alignItems: "center", gap: "8px", height: "36px", padding: "0 10px 0 4px", borderRadius: "999px", border: "1px solid var(--bd)", background: "var(--sur)", cursor: "pointer", color: "var(--tx)", fontSize: "var(--fs)" }}>
            <span style={{ width: "28px", height: "28px", borderRadius: "50%", background: "var(--acc)", color: "var(--onacc)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "600", fontSize: "12px" }}>{txt(v.me?.i)}</span>{" "}
            <span style={{ textAlign: "left", lineHeight: "1.2" }}>
              <span style={{ fontWeight: "600", display: "block" }}>{txt(v.me?.name)}</span>
              <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.me?.role)}</span>
            </span>{" "}
            <span style={{ color: "var(--tx3)", display: "inline-flex" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
                <path d="M6 9l6 6 6-6"></path>
              </svg>
            </span>
          </button>
          {v.roleMenu ? (<>
            <div style={{ position: "absolute", top: "42px", right: "0", width: "300px", background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "12px", padding: "8px", zIndex: "30", animation: "drawerIn .18s ease" }}>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", padding: "6px 10px" }}>{txt(v.t?.roleNote)}</div>
              {list(v.roleOptions).map((r, $i4) => (<Fragment key={$i4}>
                <button onClick={r?.go} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", border: "0", borderRadius: "8px", padding: "9px 10px", cursor: "pointer", background: r?.bg, color: "var(--tx)", fontSize: "var(--fs)" }}>
                  <span>
                    <span style={{ fontWeight: "600" }}>{txt(r?.name)}</span>
                    <br />
                    <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(r?.sub)}</span>
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(r?.label)}</span>
                </button>
              </Fragment>))}
            </div>
          </>) : null}
        </div>
      </div>
    </header>
  );
}
