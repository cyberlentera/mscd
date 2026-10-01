// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function SummaryTabs({ v }) {
  return (
    <>{v.stepper ? (<>
      <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "18px var(--pad) 6px" }}>
        <div style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${v.stepper?.n ?? ''},minmax(0,1fr))`, alignItems: "start" }}>
          <div style={{ position: "absolute", left: "5%", right: "5%", top: "17px", height: "3px", background: "var(--bd)", borderRadius: "2px" }}></div>
          <div style={{ position: "absolute", left: "5%", top: "17px", height: "3px", width: v.stepper?.fillW, background: "var(--ok)", borderRadius: "2px", transformOrigin: "left", animation: "growX .8s cubic-bezier(.2,.7,.2,1) both" }}></div>
          {list(v.stepper?.steps).map((sp, $i23) => (<Fragment key={$i23}>
            <button onClick={sp?.go} title={sp?.name} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", border: "0", background: "transparent", padding: "0", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)", minWidth: "0" }}>
              <span style={{ width: "36px", height: "36px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: "14px", background: sp?.bg, color: sp?.fg, border: `3px solid ${sp?.ring ?? ''}`, boxShadow: sp?.sh, transition: "transform .15s" }} className="hv2">{txt(sp?.mark)}</span>{" "}
              <span style={{ fontSize: "12.5px", lineHeight: "1.3", textAlign: "center", color: sp?.lc, fontWeight: sp?.fw, maxWidth: "120px" }}>{txt(sp?.short)}</span>
            </button>
          </Fragment>))}
        </div>
        <div style={{ marginTop: "14px", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "16px", alignItems: "center", padding: "14px 16px", borderRadius: "10px", background: v.stepper?.cur?.bg }}>
          <div style={{ minWidth: "0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "1.25em", fontWeight: "600" }}>{txt(v.stepper?.cur?.no)}{". "}{txt(v.stepper?.cur?.name)}</span>
              {v.stepper?.cur?.gate ? (<>
                <span style={{ fontSize: "12px", fontWeight: "700", padding: "2px 8px", borderRadius: "5px", background: "var(--badbg)", color: "var(--bad)" }}>{txt(v.t?.gateTag)}</span>
              </>) : null}
              <span style={{ fontSize: "12.5px", padding: "2px 9px", borderRadius: "999px", fontWeight: "600", background: v.stepper?.cur?.tagBg, color: v.stepper?.cur?.tagFg }}>{txt(v.stepper?.cur?.tag)}</span>
            </div>
            <div style={{ display: "flex", height: "10px", borderRadius: "5px", overflow: "hidden", background: "var(--bd)", marginTop: "10px", transformOrigin: "left", animation: "growX .7s cubic-bezier(.2,.7,.2,1) both" }}>
              {list(v.stepper?.cur?.seg).map((sg, $i24) => (<Fragment key={$i24}>
                <div style={{ width: `${sg?.w ?? ''}%`, background: sg?.color, transition: "width .5s" }}></div>
              </Fragment>))}
            </div>
          </div>
          <div style={{ display: "flex", gap: "18px", flex: "none" }}>
            {list(v.stepper?.cur?.counts).map((ct, $i25) => (<Fragment key={$i25}>
              <div style={{ textAlign: "center", minWidth: "56px" }}>
                <div style={{ fontSize: "24px", fontWeight: "600", lineHeight: "1", color: ct?.color }}>{txt(ct?.n)}</div>
                <div style={{ fontSize: "12px", color: "var(--tx3)", marginTop: "4px", whiteSpace: "nowrap" }}>{txt(ct?.label)}</div>
              </div>
            </Fragment>))}
          </div>
        </div>
      </div>
    </>) : null}</>
  );
}
