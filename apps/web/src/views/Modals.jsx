// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Modals({ v }) {
  return (
    <>{v.modal ? (<>
      <div onClick={v.closeModal} style={{ position: "fixed", inset: "0", background: "rgba(20,16,10,.35)", zIndex: "50" }}></div>
      <div className="mscd" data-theme={v.theme} data-font={v.font} style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "520px", maxWidth: "92vw", background: "var(--sur)", color: "var(--tx)", border: "1px solid var(--bd)", borderRadius: "14px", zIndex: "51", fontFamily: "var(--ff)", fontSize: "13px", animation: "modalIn .18s ease", maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--bd)" }}>
          <div style={{ fontWeight: "600", fontSize: "15px" }}>{txt(v.modal?.title)}</div>
          <div style={{ color: "var(--tx2)", marginTop: "2px", fontSize: "12px" }}>{txt(v.modal?.sub)}</div>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "14px", overflowY: "auto", minHeight: "0" }}>
          {v.modal?.isReassign ? (<>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "12px", color: "var(--tx3)", textTransform: "uppercase", letterSpacing: ".06em" }}>{txt(v.t?.newHolder)}</span>
              <select value={v.modal?.h ?? ''} onChange={v.modalSetH} style={{ height: "36px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", fontSize: "13px" }}>
                {list(v.peopleOptions).map((p, $i92) => (<Fragment key={$i92}>
                  <option value={p?.id ?? ''}>{txt(p?.label)}</option>
                </Fragment>))}
              </select>
            </label>{" "}
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "12px", color: "var(--tx3)", textTransform: "uppercase", letterSpacing: ".06em" }}>{txt(v.t?.newDue)}</span>
              <input type="date" value={v.modal?.due ?? ''} onChange={v.modalSetDue} style={{ height: "36px", padding: "0 10px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", fontSize: "13px" }} />
            </label>
            {v.modal?.afterWarn ? (<>
              <div style={{ padding: "8px 12px", borderRadius: "8px", background: "var(--warnbg)", color: "var(--warn)", fontSize: "12px" }}>{txt(v.t?.afterWarn)}</div>
            </>) : null}
          </>) : null}
          {v.modal?.isPicker ? (<>
            <div style={{ fontFamily: "var(--ffm)", fontSize: "12px", color: "var(--tx2)", padding: "8px 10px", borderRadius: "8px", background: "var(--sur2)", border: "1px solid var(--bd)" }}>{txt(v.modal?.path)}</div>
            <div style={{ border: "1px solid var(--bd)", borderRadius: "8px", overflow: "hidden" }}>
              {list(v.modal?.files).map((f, $i93) => (<Fragment key={$i93}>
                <button onClick={f?.go} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "10px", width: "100%", textAlign: "left", border: "0", borderBottom: "1px solid var(--bd)", padding: "9px 12px", cursor: "pointer", background: f?.bg, color: "var(--tx)", font: "inherit", fontSize: "13px" }}>
                  <span>
                    <span style={{ fontWeight: "500" }}>{txt(f?.name)}</span>
                    <br />
                    <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(f?.meta)}</span>
                  </span>
                  <span style={{ fontSize: "12px", color: f?.hcolor, fontFamily: "var(--ffm)", alignSelf: "center" }}>{txt(f?.hash)}</span>
                </button>
              </Fragment>))}
            </div>
          </>) : null}
          {v.modal?.isUpload ? (<>
            <div style={{ border: "2px dashed var(--bd)", borderRadius: "10px", padding: "28px", textAlign: "center", color: "var(--tx2)", background: "var(--sur2)" }}>{txt(v.t?.dropHere)}
              <div style={{ fontSize: "12px", color: "var(--tx3)", marginTop: "4px" }}>{txt(v.t?.uploadHint)}</div>
            </div>
          </>) : null}
          {v.modal?.isVerify ? (<>
            <div style={{ color: "var(--tx2)", lineHeight: "1.6" }}>{txt(v.t?.verifyBody)}</div>
            <div style={{ fontFamily: "var(--ffm)", fontSize: "12px", padding: "8px 10px", borderRadius: "8px", background: "var(--sur2)", border: "1px solid var(--bd)" }}>{txt(v.modal?.meta)}</div>
          </>) : null}
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--bd)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={v.closeModal} style={{ height: "34px", padding: "0 14px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", font: "inherit", fontSize: "13px", cursor: "pointer" }}>{txt(v.t?.cancel)}</button>
          <button onClick={v.modalOk} disabled={v.modal?.okOff} style={{ height: "34px", padding: "0 16px", borderRadius: "8px", border: "1px solid var(--acc)", background: "var(--acc)", color: "var(--onacc)", font: "inherit", fontSize: "13px", fontWeight: "600", cursor: "pointer" }}>{txt(v.modal?.ok)}</button>
        </div>
      </div>
    </>) : null}</>
  );
}
