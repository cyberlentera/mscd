// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';


export default function Portfolio({ v }) {
  return (
    <>{v.isPortfolio ? (<>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: "var(--pad)" }}>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)" }}>
          <div style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: "600", display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap" }}>{txt(v.t?.attention)}{" "}
              <span data-tip={v.t?.noAvg} tabIndex="0" role="img" aria-label={v.t?.noAvg} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
            </span>
            <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{txt(v.attention?.length)}{" "}{txt(v.t?.items)}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
            {list(v.attentionGroups).map((g, $i6) => (<Fragment key={$i6}>
              <div style={{ borderRight: "1px solid var(--bd)", minWidth: "0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px var(--pad) 6px", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: g?.fg }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: g?.fg }}></span>{txt(g?.label)}
                  <span style={{ fontFamily: "var(--ffm)", marginLeft: "auto" }}>{txt(g?.n)}</span>
                </div>
                {list(g?.items).map((a, $i7) => (<Fragment key={$i7}>
                  {a?.go ? (<>
                    <button onClick={a?.go} data-tip={a?.sub} style={{ display: "grid", gridTemplateColumns: "46px minmax(0,1fr)", alignItems: "start", gap: "10px", width: "100%", textAlign: "left", border: "0", borderTop: "1px solid var(--bd)", background: "transparent", padding: "10px var(--pad)", cursor: "pointer", color: "var(--tx)", fontSize: "var(--fs)", transition: "background .15s" }} className="hv0">
                      <span style={{ fontSize: "12px", fontWeight: "700", padding: "2px 0", borderRadius: "5px", textAlign: "center", background: a?.fill, color: "#fff", marginTop: "2px" }}>{txt(a?.short)}</span>{" "}
                      <span style={{ minWidth: "0", fontWeight: "500", lineHeight: "1.3" }}>{txt(a?.text)}</span>
                    </button>
                  </>) : null}
                  {a?.plain ? (<>
                    <div data-tip={a?.sub} tabIndex={a?.tabi} style={{ display: "grid", gridTemplateColumns: "46px minmax(0,1fr)", alignItems: "start", gap: "10px", borderTop: "1px solid var(--bd)", padding: "10px var(--pad)", color: "var(--tx)", fontSize: "var(--fs)" }}>
                      <span style={{ fontSize: "12px", fontWeight: "700", padding: "2px 0", borderRadius: "5px", textAlign: "center", background: a?.fill, color: "#fff", marginTop: "2px" }}>{txt(a?.short)}</span>{" "}
                      <span style={{ minWidth: "0", fontWeight: "500", lineHeight: "1.3" }}>{txt(a?.text)}</span>
                    </div>
                  </>) : null}
                </Fragment>))}
              </div>
            </Fragment>))}
          </div>
        </div>
      </div>
      {v.pfCards ? (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "var(--pad)" }}>
          {list(v.pf).map((m, $i8) => (<Fragment key={$i8}>
            <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", padding: "var(--pad)", display: "flex", flexDirection: "column", gap: "14px", animation: "riseIn .5s cubic-bezier(.2,.7,.2,1) both", animationDelay: m?.delay, transition: "border-color .2s", "--hv1-0": m?.color }} className="hv1">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
                <div style={{ minWidth: "0" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", fontWeight: "700", padding: "2px 7px", borderRadius: "5px", background: m?.fill, color: "#fff" }}>{txt(m?.short)}</span>
                    <span style={{ fontFamily: "var(--ffm)", fontSize: "12px", color: "var(--tx2)" }}>{txt(m?.code)}{" : "}{txt(m?.ed)}</span>
                  </div>
                  <button onClick={m?.go} style={{ border: "0", background: "transparent", padding: "0", marginTop: "6px", font: "inherit", fontSize: "1.25em", fontWeight: "600", color: "var(--tx)", cursor: "pointer", textAlign: "left" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>{txt(m?.name)}{" "}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", color: "var(--tx3)" }}>
                        <path d="M5 12h14M13 6l6 6-6 6"></path>
                      </svg>
                    </span>
                  </button>
                  <div style={{ color: "var(--tx2)", fontSize: "12px" }}>{txt(m?.scope)}</div>
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)" }}>{txt(v.t?.nextAudit)}</div>
                  {m?.hasAudit ? (<>
                    <div style={{ fontWeight: "600", marginTop: "2px", maxWidth: "220px" }}>{txt(m?.auditName)}</div>
                    <div>
                      <span style={{ fontSize: "20px", fontWeight: "600", color: m?.auditColor }}>{txt(m?.auditDays)}</span>{" "}
                      <span style={{ color: "var(--tx2)" }}>{txt(v.t?.daysLeft)}{", "}{txt(m?.auditDate)}</span>
                    </div>
                  </>) : null}
                  {m?.noAudit ? (<>
                    <div style={{ fontWeight: "600", color: "var(--warn)", marginTop: "2px", display: "inline-flex", gap: "6px", alignItems: "center" }}>{txt(v.t?.noAudit)}{" "}
                      <span data-tip={v.t?.noAuditSub} tabIndex="0" role="img" aria-label={v.t?.noAuditSub} style={{ display: "inline-flex", width: "16px", height: "16px", borderRadius: "50%", border: "1px solid var(--tx3)", color: "var(--tx3)", fontSize: "12px", lineHeight: "1", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "var(--ffm)", flex: "none" }}>{"i"}</span>
                    </div>
                  </>) : null}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "16px", alignItems: "center" }}>
                <svg viewBox="0 0 120 120" width="150" height="150" style={{ overflow: "visible" }}>
                  <g style={{ transformOrigin: "60px 60px", animation: "radarIn .6s cubic-bezier(.2,.7,.2,1) both", animationDelay: m?.delay }}>
                    <polygon points={m?.grid100} fill="none" stroke="var(--bd)" strokeWidth="1"></polygon>
                    <polygon points={m?.grid50} fill="none" stroke="var(--bd)" strokeWidth="1" strokeDasharray="2 3"></polygon>
                    {list(m?.axes).map((a, $i9) => (<Fragment key={$i9}>
                      <line x1="60" y1="60" x2={a?.x} y2={a?.y} stroke="var(--bd)" strokeWidth="1"></line>
                    </Fragment>))}
                    <polygon points={m?.radar} fill={m?.color} fillOpacity=".22" stroke={m?.color} strokeWidth="2" strokeLinejoin="round"></polygon>
                    {list(m?.cl).map((c, $i10) => (<Fragment key={$i10}>
                      <circle cx={c?.x} cy={c?.y} r="3.2" fill={c?.color} stroke="var(--sur)" strokeWidth="1.5"></circle>
                    </Fragment>))}
                  </g>
                  {list(m?.axes).map((a, $i11) => (<Fragment key={$i11}>
                    <text x={a?.lx} y={a?.ly} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontFamily="var(--ffm)" fill="var(--tx3)">{txt(a?.n)}</text>
                  </Fragment>))}
                </svg>
                <div>
                  <div style={{ fontSize: "12px", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.clauseReadiness)}{", "}{txt(m?.stage)}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "4px 14px" }}>
                    {list(m?.cl).map((c, $i12) => (<Fragment key={$i12}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "12.5px", borderBottom: "1px solid var(--bd)", padding: "3px 0" }}>
                        <span style={{ color: "var(--tx2)", minWidth: "0", overflowWrap: "anywhere" }}>
                          <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", color: "var(--tx)", marginRight: "6px" }}>{txt(c?.n)}</span>{txt(c?.title)}
                        </span>
                        <span style={{ fontFamily: "var(--ffm)", fontWeight: "600", flex: "none", color: c?.ink }}>{txt(c?.pct)}{"%"}</span>
                      </div>
                    </Fragment>))}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "0", borderTop: "1px solid var(--bd)", borderBottom: "1px solid var(--bd)" }}>
                {list(m?.stats).map((s, $i13) => (<Fragment key={$i13}>
                  {s?.go ? (<>
                    <button onClick={s?.go} style={{ flex: "1", textAlign: "left", border: "0", borderRight: "1px solid var(--bd)", padding: "10px 12px 10px 0", marginRight: "12px", background: "transparent", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
                      <div style={{ fontSize: "22px", fontWeight: "600", lineHeight: "1.1", color: s?.ink }}>{txt(s?.nEl)}</div>
                      <div style={{ fontSize: "12px", color: "var(--tx3)", marginTop: "3px" }}>{txt(s?.label)}</div>
                    </button>
                  </>) : null}
                  {s?.plain ? (<>
                    <div style={{ flex: "1", borderRight: "1px solid var(--bd)", padding: "10px 12px 10px 0", marginRight: "12px", color: "var(--tx)", fontSize: "var(--fs)" }}>
                      <div style={{ fontSize: "22px", fontWeight: "600", lineHeight: "1.1", color: s?.ink }}>{txt(s?.nEl)}</div>
                      <div style={{ fontSize: "12px", color: "var(--tx3)", marginTop: "3px" }}>{txt(s?.label)}</div>
                    </div>
                  </>) : null}
                </Fragment>))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", fontSize: "12px", color: "var(--tx3)", borderTop: "1px solid var(--bd)", paddingTop: "10px", marginTop: "auto" }}>
                <span>{txt(m?.certifier)}{", "}{txt(m?.cert)}</span>{" "}
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "2px 8px", borderRadius: "999px", background: m?.locBg, color: m?.locFg, fontWeight: "600" }}>{txt(m?.locLabel)}</span>
              </div>
            </div>
          </Fragment>))}
        </div>
      </>) : null}
      {v.pfRows ? (<>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
                <th style={{ padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.c_msName)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)", minWidth: "260px" }}>{txt(v.t?.clauseReadiness)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.nextAudit)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.gateItems)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.findings)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.docsExpired)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.evCritical)}</th>
                <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd)" }}>{txt(v.t?.repo)}</th>
              </tr>
            </thead>
            <tbody>
              {list(v.pf).map((m, $i14) => (<Fragment key={$i14}>
                <tr>
                  <td data-tip={m?.tip} style={{ padding: "12px var(--pad)", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <button onClick={m?.go} style={{ display: "flex", alignItems: "baseline", gap: "8px", border: "0", background: "transparent", padding: "0", font: "inherit", fontSize: "var(--fs)", fontWeight: "600", color: "var(--tx)", cursor: "pointer", textAlign: "left" }}>
                      <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: m?.color, flex: "none" }}></span>
                      <span>{txt(m?.short)}{", "}{txt(m?.name)}</span>
                    </button>
                    {m?.banner ? (<>
                      <div style={{ fontSize: "12px", marginTop: "4px", color: m?.banner?.fg }}>{txt(m?.banner?.text)}</div>
                    </>) : null}
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: "5px" }}>
                      {list(m?.cl).map((c, $i15) => (<Fragment key={$i15}>
                        <div>
                          <div style={{ height: "6px", borderRadius: "3px", background: "var(--bd)", overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${c?.pct ?? ''}%`, background: c?.color }}></div>
                          </div>
                          <div style={{ fontSize: "12px", color: "var(--tx3)", fontFamily: "var(--ffm)", marginTop: "2px" }}>{txt(c?.n)}{", "}{txt(c?.pct)}</div>
                        </div>
                      </Fragment>))}
                    </div>
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    {m?.hasAudit ? (<>
                      <div style={{ fontWeight: "500" }}>{txt(m?.auditName)}</div>
                      <div style={{ fontSize: "12px", color: "var(--tx2)" }}>
                        <span style={{ fontWeight: "600", color: m?.auditColor }}>{txt(m?.auditDays)}{" "}{txt(v.t?.daysLeft)}</span>{", "}{txt(m?.auditDate)}
                      </div>
                    </>) : null}
                    {m?.noAudit ? (<>
                      <span style={{ color: "var(--warn)", fontWeight: "500" }}>{txt(v.t?.noAudit)}</span>
                    </>) : null}
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", color: m?.gateColor }}>{txt(m?.gateN)}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                      {list(m?.gateItems).map((g, $i16) => (<Fragment key={$i16}>
                        {g?.go ? (<>
                          <button onClick={g?.go} style={{ border: "0", background: "var(--badbg)", color: "var(--bad)", borderRadius: "5px", padding: "1px 6px", fontSize: "12px", cursor: "pointer", fontFamily: "var(--ffm)" }}>{txt(g?.id)}</button>
                        </>) : null}
                        {g?.plain ? (<>
                          <span style={{ background: "var(--badbg)", color: "var(--bad)", borderRadius: "5px", padding: "1px 6px", fontSize: "12px", fontFamily: "var(--ffm)" }}>{txt(g?.id)}</span>
                        </>) : null}
                      </Fragment>))}
                    </div>
                  </td>
                  <td data-tip={m?.findSub} style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600" }}>{txt(m?.findN)}</div>
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", color: m?.docColor }}>{txt(m?.docExp)}</div>
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", color: m?.evColor }}>{txt(m?.evCrit)}</div>
                  </td>
                  <td style={{ padding: "12px", borderBottom: "1px solid var(--bd)", verticalAlign: "top" }}>
                    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: "999px", background: m?.locBg, color: m?.locFg, fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap" }}>{txt(m?.locLabel)}</span>
                  </td>
                </tr>
              </Fragment>))}
            </tbody>
          </table>
        </div>
      </>) : null}
    </>) : null}</>
  );
}
