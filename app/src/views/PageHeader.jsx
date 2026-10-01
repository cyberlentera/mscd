// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function PageHeader({ v }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 auto", minWidth: "0" }}>
        <div style={{ fontSize: "12px", color: "var(--tx3)", display: "flex", gap: "6px", alignItems: "center", whiteSpace: "nowrap" }}>
          <span>{txt(v.crumb1)}</span>
          {v.crumb2 ? (<>
            <span>{"/"}</span>
            <span>{txt(v.crumb2)}</span>
          </>) : null}
        </div>
        <h1 style={{ margin: "2px 0 0", fontSize: "22px", fontWeight: "600", letterSpacing: "-.01em", whiteSpace: "nowrap" }}>{txt(v.title)}</h1>
        <div style={{ color: "var(--tx2)", marginTop: "2px" }}>{txt(v.subtitle)}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "none" }}>
        <span style={{ fontSize: "12px", color: "var(--tx3)", display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "6px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--ok)" }}></span>{txt(v.t?.updated)}{" "}{txt(v.updatedAt)}
        </span>{" "}
        {list(v.pageActions).map((pa, $i5) => (<Fragment key={$i5}>
          <button onClick={pa?.go} title={pa?.label} style={{ display: "inline-flex", alignItems: "center", gap: "7px", height: "34px", padding: "0 12px", borderRadius: "8px", border: `1px solid ${pa?.bd ?? ''}`, background: pa?.bg, color: pa?.fg, font: "inherit", fontSize: "var(--fs)", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={pa?.icon}></path>
            </svg>{txt(pa?.label)}
          </button>
        </Fragment>))}
      </div>
      {v.roleBanner ? (<>
        <div style={{ fontSize: "12px", color: "var(--tx2)", background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "8px", padding: "8px 12px", maxWidth: "520px" }}>{txt(v.roleBanner)}</div>
      </>) : null}
    </div>
  );
}
