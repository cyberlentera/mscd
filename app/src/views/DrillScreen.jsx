// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';
import SummaryTabs from './SummaryTabs.jsx';
import TraceTest from './TraceTest.jsx';
import GoldenThread from './GoldenThread.jsx';
import Timeline from './Timeline.jsx';
import PageDetail from './PageDetail.jsx';
import PendingPeople from './PendingPeople.jsx';

export default function DrillScreen({ v }) {
  return (
    <>{v.isDrill ? (<>
      {v.hero ? (<>
        <div data-hero="" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,2fr)", gap: "0", background: "var(--tx)", color: "var(--bg)", borderRadius: "var(--r)", overflow: "hidden", position: "relative" }}>
          <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
            <div style={{ position: "absolute", right: "-10%", top: "-60%", width: "55%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(232,115,26,.38),transparent 60%)", filter: "blur(30px)", animation: "meshA 16s ease-in-out infinite" }}></div>
            <div style={{ position: "absolute", left: "30%", bottom: "-80%", width: "45%", height: "160%", borderRadius: "50%", background: "radial-gradient(circle,rgba(122,79,211,.22),transparent 60%)", filter: "blur(36px)", animation: "meshB 20s ease-in-out infinite" }}></div>
          </div>
          <div style={{ position: "relative", padding: "var(--pad) calc(var(--pad) + 4px)", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "10px", borderRight: "1px solid rgba(255,255,255,.12)" }}>
            <div>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", opacity: ".85" }}>{txt(v.t?.nextAudit)}</div>
              <div style={{ fontSize: "1.25em", fontWeight: "600", marginTop: "4px" }}>{txt(v.hero?.name)}</div>
              <div style={{ opacity: ".9", fontSize: "12.5px" }}>{txt(v.hero?.certifier)}{", "}{txt(v.hero?.lead)}</div>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
              <span style={{ fontSize: "38px", fontWeight: "600", lineHeight: "1", color: "var(--acc)" }}>{txt(v.hero?.days)}</span>
              <span style={{ opacity: ".8" }}>{txt(v.t?.daysLeft)}{", "}{txt(v.hero?.date)}</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
            {list(v.hero?.nums).map((h, $i22) => (<Fragment key={$i22}>
              <div style={{ padding: "var(--pad)", borderRight: "1px solid rgba(255,255,255,.12)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
                <div style={{ fontSize: "30px", fontWeight: "600", lineHeight: "1", color: h?.color }}>{txt(h?.nEl)}</div>
                <div style={{ opacity: ".95", marginTop: "8px", fontSize: "12.5px" }}>{txt(h?.label)}</div>
                {h?.sub ? (<>
                  <div style={{ opacity: ".85", fontSize: "12px", marginTop: "2px" }}>{txt(h?.sub)}</div>
                </>) : null}
              </div>
            </Fragment>))}
          </div>
        </div>
      </>) : null}
      {v.noAuditState ? (<>
        <div style={{ background: "var(--sur)", border: "1px dashed var(--bd)", borderRadius: "var(--r)", padding: "calc(var(--pad) * 2)", textAlign: "center" }}>
          <div style={{ fontWeight: "600", fontSize: "1.1em" }}>{txt(v.t?.noAudit)}</div>
          <div style={{ color: "var(--tx2)", marginTop: "4px" }}>{txt(v.t?.noAuditSub)}</div>
        </div>
      </>) : null}
      <SummaryTabs v={v} />
      {v.tabs?.length ? (<>
        <div style={{ display: "flex", background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", overflow: "hidden" }}>
          {list(v.tabs).map((tb, $i26) => (<Fragment key={$i26}>
            <button onClick={tb?.go} style={{ flex: "1 1 0", minWidth: "0", textAlign: "left", background: tb?.bg, border: "0", borderRight: "1px solid var(--bd)", borderBottom: `3px solid ${tb?.bar ?? ''}`, padding: "12px 14px 10px", cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0 6px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "24px", fontWeight: "600", lineHeight: "1", color: tb?.color }}>{txt(tb?.nEl)}</span>
                {tb?.sub ? (<>
                  <span style={{ fontSize: "12px", color: "var(--tx3)", whiteSpace: "nowrap" }}>{txt(tb?.sub)}</span>
                </>) : null}
              </div>
              <div style={{ marginTop: "5px", color: "var(--tx2)", fontSize: "12.5px", lineHeight: "1.3" }}>{txt(tb?.label)}</div>
              {tb?.seg ? (<>
                <div style={{ display: "flex", height: "4px", borderRadius: "2px", overflow: "hidden", marginTop: "8px", background: "var(--bd)", transformOrigin: "left", animation: "growX .7s cubic-bezier(.2,.7,.2,1) both" }}>
                  {list(tb?.seg).map((sg, $i27) => (<Fragment key={$i27}>
                    <div style={{ width: `${sg?.w ?? ''}%`, background: sg?.color, transition: "width .5s" }}></div>
                  </Fragment>))}
                </div>
              </>) : null}
            </button>
          </Fragment>))}
        </div>
      </>) : null}
      {v.infoBanner ? (<>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r)", background: v.infoBanner?.bg, color: v.infoBanner?.fg }}>
          <span style={{ fontWeight: "700" }}>{"!"}</span>
          <span>{txt(v.infoBanner?.text)}
            {v.infoBanner?.link ? (<>{" "}
              <button onClick={v.infoBanner?.go} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "inherit", textDecoration: "underline", cursor: "pointer" }}>{txt(v.infoBanner?.link)}</button>
            </>) : null}
          </span>
        </div>
      </>) : null}
      {v.freq ? (<>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)", padding: "12px var(--pad)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontWeight: "600", display: "inline-flex", alignItems: "center", gap: "12px" }}>
              <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="22" cy="22" r="17" fill="none" stroke="var(--bd)" strokeWidth="7"></circle>
                <circle cx="22" cy="22" r="17" fill="none" stroke={v.donut0?.color} strokeWidth="7" strokeDasharray={v.donut0?.dash} strokeDashoffset={v.donut0?.off}></circle>
                <circle cx="22" cy="22" r="17" fill="none" stroke={v.donut1?.color} strokeWidth="7" strokeDasharray={v.donut1?.dash} strokeDashoffset={v.donut1?.off}></circle>
                <circle cx="22" cy="22" r="17" fill="none" stroke={v.donut2?.color} strokeWidth="7" strokeDasharray={v.donut2?.dash} strokeDashoffset={v.donut2?.off}></circle>
                <circle cx="22" cy="22" r="17" fill="none" stroke={v.donut3?.color} strokeWidth="7" strokeDasharray={v.donut3?.dash} strokeDashoffset={v.donut3?.off}></circle>
              </svg>{txt(v.t?.freqBy)}
            </span>
            <span style={{ display: "flex", gap: "12px", fontSize: "12px", color: "var(--tx3)" }}>
              <span>
                <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", background: "var(--ok)", marginRight: "4px" }}></span>{txt(v.t?.fresh)}
              </span>
              <span>
                <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", background: "var(--gold)", marginRight: "4px" }}></span>{txt(v.t?.aging)}
              </span>
              <span>
                <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", background: "var(--warn)", marginRight: "4px" }}></span>{txt(v.t?.expired)}
              </span>
              <span>
                <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", background: "var(--bad)", marginRight: "4px" }}></span>{txt(v.t?.critical)}
              </span>
            </span>
          </div>
          {list(v.freq).map((f, $i28) => (<Fragment key={$i28}>
            <button onClick={f?.go} style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px", alignItems: "center", gap: "12px", width: "100%", border: "0", borderRadius: "6px", padding: "5px 8px", background: f?.bg, cursor: "pointer", color: "var(--tx)", font: "inherit", fontSize: "var(--fs)" }}>
              <span style={{ textAlign: "left", fontWeight: f?.fw }}>{txt(f?.label)}</span>{" "}
              <span style={{ display: "flex", height: "10px", borderRadius: "5px", overflow: "hidden", background: "var(--bd)", transformOrigin: "left", animation: "growX .7s cubic-bezier(.2,.7,.2,1) both" }}>
                {list(f?.seg).map((sg, $i29) => (<Fragment key={$i29}>
                  <span style={{ width: `${sg?.w ?? ''}%`, background: sg?.color, transition: "width .5s" }}></span>
                </Fragment>))}
              </span>{" "}
              <span style={{ textAlign: "right", fontSize: "12px", color: "var(--tx3)", fontFamily: "var(--ffm)" }}>{txt(f?.sub)}</span>
            </button>
          </Fragment>))}
        </div>
      </>) : null}
      {v.stageQ ? (<>
        <div style={{ display: "flex", gap: "10px", alignItems: "baseline", padding: "10px 14px", borderRadius: "var(--r)", background: "var(--accbg)", color: "var(--tx)" }}>
          <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--acc)", fontWeight: "700", whiteSpace: "nowrap" }}>{txt(v.t?.auditorQ)}</span>
          <span style={{ fontStyle: "italic" }}>{"\""}{txt(v.stageQ)}{"\""}</span>
        </div>
      </>) : null}
      {v.personBanner ? (<>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderRadius: "var(--r)", background: "var(--infobg)", color: "var(--info)" }}>
          <span>{txt(v.t?.heldBy)}{" "}
            <strong>{txt(v.personBanner)}</strong>
          </span>
          <button onClick={v.clearPerson} style={{ border: "1px solid currentColor", background: "transparent", color: "inherit", borderRadius: "6px", width: "26px", height: "26px", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={v.t?.clear}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
              <path d="M18 6L6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </>) : null}
      <TraceTest v={v} />
      <GoldenThread v={v} />
      <Timeline v={v} />
      {v.showList ? (<>
        <div style={{ background: "var(--sur)", border: "1px solid var(--bd)", borderRadius: "var(--r)", boxShadow: "var(--sh)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px", alignItems: "center", gap: "12px", padding: "10px var(--pad)", borderBottom: "1px solid var(--bd)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: "0" }}>
              {v.listTitle ? (<>
                <span style={{ fontWeight: "600", marginRight: "8px" }}>{txt(v.listTitle)}</span>
              </>) : null}{" "}
              {list(v.chips).map((ch, $i45) => (<Fragment key={$i45}>
                <button onClick={ch?.go} style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "28px", padding: "0 10px", borderRadius: "999px", border: `1px solid ${ch?.bd ?? ''}`, background: ch?.bg, color: ch?.fg, cursor: "pointer", font: "inherit", fontSize: "12px", fontWeight: "500", whiteSpace: "nowrap" }}>{txt(ch?.label)}
                  <span style={{ fontFamily: "var(--ffm)", fontSize: "12px", opacity: ".8" }}>{txt(ch?.n)}</span>
                </button>
              </Fragment>))}
            </div>
            <input value={v.q ?? ''} onChange={v.setQ} placeholder={v.t?.search} style={{ height: "32px", width: "100%", boxSizing: "border-box", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--bd)", background: "var(--sur2)", color: "var(--tx)", fontSize: "var(--fs)", outline: "none" }} />
          </div>
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)" }}>
                  <th style={{ padding: "8px 6px 8px var(--pad)", borderBottom: "1px solid var(--bd)", width: "20px" }}></th>
                  {list(v.cols).map((co, $i46) => (<Fragment key={$i46}>
                    <th style={{ padding: "8px 8px", borderBottom: "1px solid var(--bd)", whiteSpace: "nowrap" }}>{txt(co)}</th>
                  </Fragment>))}
                </tr>
              </thead>
              <tbody>
                {list(v.rows).map((row, $i47) => (<Fragment key={$i47}>
                  {row?.isGroup ? (<>
                    <tr>
                      <td colSpan={v.ncols} style={{ padding: "8px var(--pad)", borderBottom: "1px solid var(--bd)", background: "var(--sur2)", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: row?.color, fontWeight: "600" }}>{txt(row?.label)}{" "}
                        <span style={{ fontFamily: "var(--ffm)", opacity: ".7", marginLeft: "6px" }}>{txt(row?.n)}</span>
                      </td>
                    </tr>
                  </>) : null}
                  {row?.isRow ? (<>
                    <tr onClick={row?.go} style={{ cursor: "pointer", background: row?.bg }} className="hv4">
                      <td style={{ padding: "0 6px 0 var(--pad)", height: "var(--rh)", borderBottom: "1px solid var(--bd)", color: "var(--tx3)" }}>
                        <span style={{ display: "inline-block", width: "7px", height: "7px", borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: `rotate(${row?.rot ?? ''})`, transition: "transform .2s", marginLeft: "2px" }}></span>
                      </td>
                      {list(row?.cells).map((c, $i48) => (<Fragment key={$i48}>
                        <td style={{ padding: "6px 8px", height: "var(--rh)", borderBottom: "1px solid var(--bd)", verticalAlign: "middle", maxWidth: "300px" }}>
                          {c?.mono ? (<>
                            <span style={{ fontFamily: "var(--ffm)", fontSize: ".95em", fontWeight: "500", whiteSpace: "nowrap" }}>{txt(c?.v)}</span>
                          </>) : null}{" "}
                          {c?.badge ? (<>
                            <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: "999px", fontSize: ".9em", fontWeight: "600", whiteSpace: "nowrap", background: c?.bg, color: c?.fg }}>{txt(c?.v)}</span>
                          </>) : null}{" "}
                          {c?.person ? (<>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ width: "24px", height: "24px", borderRadius: "50%", flex: "none", background: c?.bg, color: c?.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700" }}>{txt(c?.i)}</span>
                              <span style={{ lineHeight: "1.25" }}>
                                <span style={{ fontWeight: "500", display: "block", whiteSpace: "nowrap" }}>{txt(c?.v)}</span>
                                <span style={{ fontSize: ".9em", color: "var(--tx3)" }}>{txt(c?.s)}</span>
                              </span>
                            </span>
                          </>) : null}{" "}
                          {c?.loc ? (<>
                            <span title={c?.title} style={{ display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap", minWidth: "132px", paddingRight: "4px" }}>
                              <span style={{ width: "26px", height: "26px", borderRadius: "7px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--sur2)", color: c?.color }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                                  <path d={c?.icon}></path>
                                </svg>
                              </span>
                              <span style={{ lineHeight: "1.25" }}>
                                <span style={{ display: "block", fontWeight: "500" }}>{txt(c?.v)}</span>
                                {c?.s ? (<>
                                  <span style={{ fontSize: ".9em", color: c?.sColor }}>{txt(c?.s)}</span>
                                </>) : null}
                              </span>
                            </span>
                          </>) : null}
                          {c?.text ? (<>
                            <div style={{ fontWeight: c?.fw, lineHeight: "1.3" }}>{txt(c?.v)}</div>
                          </>) : null}
                          {c?.sub ? (<>
                            <div style={{ fontSize: ".9em", color: c?.subColor, marginTop: "2px", lineHeight: "1.3" }}>{txt(c?.sub)}</div>
                          </>) : null}
                          {c?.tag ? (<>
                            <span style={{ display: "inline-flex", marginTop: "3px", marginLeft: c?.tagMl, padding: "1px 6px", borderRadius: "5px", fontSize: ".9em", fontWeight: "600", whiteSpace: "nowrap", background: c?.tag?.bg, color: c?.tag?.fg }}>{txt(c?.tag?.v)}</span>
                          </>) : null}
                        </td>
                      </Fragment>))}
                    </tr>
                  </>) : null}
                  {row?.isDetail ? (<>
                    <tr>
                      <td colSpan={v.ncols} style={{ padding: "0", borderBottom: "1px solid var(--bd)", background: "var(--sur2)" }}>
                        <div style={{ padding: "var(--pad) calc(var(--pad) + 26px)", display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: "calc(var(--pad) * 1.5)" }}>
                          <div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontFamily: "var(--ffm)", fontWeight: "600" }}>{txt(row?.det?.id)}</span>
                              {list(row?.det?.badges).map((b, $i49) => (<Fragment key={$i49}>
                                <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: ".9em", fontWeight: "600", background: b?.bg, color: b?.fg }}>{txt(b?.v)}</span>
                              </Fragment>))}
                              {row?.det?.note ? (<>
                                <span title={row?.det?.note?.text} style={{ display: "inline-flex", width: "18px", height: "18px", borderRadius: "50%", background: row?.det?.note?.bg, color: row?.det?.note?.fg, fontSize: "11px", alignItems: "center", justifyContent: "center", cursor: "help", fontWeight: "700" }}>{"i"}</span>
                              </>) : null}
                            </div>
                            <div style={{ fontSize: "1.1em", fontWeight: "600", marginTop: "4px" }}>{txt(row?.det?.title)}</div>
                            {row?.det?.q ? (<>
                              <div style={{ marginTop: "6px", fontStyle: "italic", color: "var(--tx2)" }}>{txt(v.t?.auditorQ)}{": \""}{txt(row?.det?.q)}{"\""}</div>
                            </>) : null}
                            <div style={{ marginTop: "10px", display: "grid", gridTemplateColumns: "150px 1fr", rowGap: "6px", columnGap: "12px" }}>
                              {list(row?.det?.facts).map((f, $i50) => (<Fragment key={$i50}>
                                <div style={{ color: "var(--tx3)", fontSize: ".9em", paddingTop: "1px" }}>{txt(f?.k)}</div>
                                <div style={{ fontFamily: f?.ff }}>
                                  {f?.go ? (<>
                                    <button onClick={f?.go} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--acc)", cursor: "pointer", textDecoration: "underline" }}>{txt(f?.v)}</button>
                                  </>) : null}
                                  {f?.plain ? (<>
                                    <span style={{ color: f?.color }}>{txt(f?.v)}</span>
                                  </>) : null}
                                </div>
                              </Fragment>))}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                              <div>
                                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.upstream)}</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                  {list(row?.det?.up).map((l, $i51) => (<Fragment key={$i51}>
                                    <button onClick={l?.go} style={{ border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", borderRadius: "6px", padding: "3px 8px", fontFamily: "var(--ffm)", fontSize: ".9em", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(l?.v)}</button>
                                  </Fragment>))}
                                  {row?.det?.noUp ? (<>
                                    <span style={{ color: "var(--bad)", fontSize: ".9em" }}>{"- "}{txt(row?.det?.noUp)}</span>
                                  </>) : null}
                                </div>
                              </div>
                              <div>
                                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.downstream)}</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                  {list(row?.det?.down).map((l, $i52) => (<Fragment key={$i52}>
                                    <button onClick={l?.go} style={{ border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", borderRadius: "6px", padding: "3px 8px", fontFamily: "var(--ffm)", fontSize: ".9em", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(l?.v)}</button>
                                  </Fragment>))}
                                  {row?.det?.noDown ? (<>
                                    <span style={{ color: "var(--bad)", fontSize: ".9em" }}>{"- "}{txt(row?.det?.noDown)}</span>
                                  </>) : null}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "auto" }}>
                              {list(row?.det?.actions).map((a, $i53) => (<Fragment key={$i53}>
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
                        </div>
                      </td>
                    </tr>
                  </>) : null}
                </Fragment>))}
              </tbody>
            </table>
          </div>
          {v.empty ? (<>
            <div style={{ padding: "calc(var(--pad) * 2.5) var(--pad)", textAlign: "center" }}>
              <svg width="120" height="44" viewBox="0 0 120 44" fill="none" stroke="var(--tx3)" strokeWidth="2" strokeLinecap="round" style={{ marginBottom: "10px", opacity: ".7" }}>
                <circle cx="16" cy="22" r="9"></circle>
                <circle cx="60" cy="22" r="9"></circle>
                <circle cx="104" cy="22" r="9"></circle>
                <path d="M25 22h26"></path>
                <path d="M69 22h8M83 22h12" strokeDasharray="3 4"></path>
                <path d="M60 13v18" stroke="var(--acc)"></path>
              </svg>
              <div style={{ fontWeight: "600", fontSize: "1.1em" }}>{txt(v.empty?.title)}</div>
              <div style={{ color: "var(--tx2)", marginTop: "4px", maxWidth: "520px", marginLeft: "auto", marginRight: "auto" }}>{txt(v.empty?.sub)}</div>
            </div>
          </>) : null}
          <div style={{ padding: "8px var(--pad)", fontSize: "12px", color: "var(--tx3)", borderTop: "1px solid var(--bd)", display: "flex", alignItems: "center", gap: "12px" }}>
            <span>{txt(v.t?.showing)}{" "}{txt(v.rowCount)}{" "}{txt(v.itemsWord)}</span>
            {v.moreN ? (<>
              <button onClick={v.showMore} style={{ border: "1px solid var(--bd)", background: "var(--sur)", color: "var(--tx)", borderRadius: "6px", padding: "4px 10px", font: "inherit", fontSize: "12px", cursor: "pointer", fontWeight: "500" }}>{"+ "}{txt(v.moreN)}</button>
            </>) : null}
          </div>
        </div>
      </>) : null}
      <PageDetail v={v} />
      <PendingPeople v={v} />
    </>) : null}</>
  );
}
