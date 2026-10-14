// Generated from the design prototype by scripts/convert-template.mjs.
import { Fragment } from 'react';
import { txt, list } from './util.js';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import PageHeader from './PageHeader.jsx';
import Portfolio from './Portfolio.jsx';
import Journey from './Journey.jsx';
import Team from './Team.jsx';
import Storage from './Storage.jsx';
import DrillScreen from './DrillScreen.jsx';
import Overview from './Overview.jsx';
import MyTasks from './MyTasks.jsx';
import FrameworkLibrary from './FrameworkLibrary.jsx';
import Drawer from './Drawer.jsx';
import Modals from './Modals.jsx';

export default function AppView({ v }) {
  return (
    <>
    <div className="mscd" data-theme={v.theme} data-density={v.density} data-font={v.font} style={{ display: "grid", gridTemplateColumns: `${v.sbW ?? ''} minmax(0,1fr)`, minHeight: "100vh", minWidth: "1180px", transition: "grid-template-columns .2s", background: "var(--bg)", color: "var(--tx)", fontFamily: "var(--ff)", fontSize: "var(--fs)", lineHeight: "1.45" }}>
      <Sidebar v={v} />
      <main style={{ minWidth: "0", display: "flex", flexDirection: "column" }}>
        <TopBar v={v} />
        {v.ready ? (<>
          <div style={{ padding: "var(--pad) calc(var(--pad) + 8px) 80px", display: "flex", flexDirection: "column", gap: "var(--pad)", animation: v.anim }}>
            <PageHeader v={v} />
            {v.msBanner ? (<>
              <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r)", background: v.msBanner?.bg, color: v.msBanner?.fg, border: `1px solid ${v.msBanner?.fg ?? ''}33` }}>
                <span style={{ fontWeight: "700" }}>{"!"}</span>
                <span>{txt(v.msBanner?.text)}</span>
              </div>
            </>) : null}
            <Portfolio v={v} />
            <Journey v={v} />
            <Team v={v} />
            <Storage v={v} />
            <DrillScreen v={v} />
            <Overview v={v} />
            <MyTasks v={v} />
            <FrameworkLibrary v={v} />
          </div>
        </>) : null}
      </main>
      <Drawer v={v} />
      <Modals v={v} />
      <div style={{ position: "fixed", right: "24px", bottom: "24px", zIndex: "45", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "12px", fontFamily: "var(--ff)" }}>
        {v.tera?.open ? (<>
          <div style={{ width: "340px", background: "var(--sur)", color: "var(--tx)", border: "1px solid var(--bd)", borderRadius: "14px", overflow: "hidden", animation: "popIn .25s cubic-bezier(.2,.7,.2,1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", background: "#1c1a17", color: "#f2eee7" }}>
              <span style={{ width: "40px", height: "40px", borderRadius: "12px", background: "#2a2621", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                <svg viewBox="0 0 48 48" width="30" height="30" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
                  <path d="M19 9c0-3 2-5 5-5s5 2 5 5" stroke="#f2eee7" strokeWidth="2.5"></path>
                  <rect x="15" y="9" width="18" height="4" rx="2" fill="#f2eee7"></rect>
                  <rect x="13" y="13" width="22" height="22" rx="6" fill="#e8731a"></rect>
                  <rect x="16" y="16" width="16" height="16" rx="4" fill="#ffb86b"></rect>
                  <circle cx="21" cy="23" r="1.6" fill="#1c1a17"></circle>
                  <circle cx="27" cy="23" r="1.6" fill="#1c1a17"></circle>
                  <path d="M21.5 27c1.5 1.4 3.5 1.4 5 0" stroke="#1c1a17" strokeWidth="1.8"></path>
                  <rect x="15" y="35" width="18" height="4" rx="2" fill="#f2eee7"></rect>
                  <path d="M20 42h8" stroke="#f2eee7" strokeWidth="2.5"></path>
                </svg>
              </span>{" "}
              <span style={{ minWidth: "0" }}>
                <span style={{ display: "block", fontWeight: "700", fontSize: "15px" }}>{"Tera"}</span>
                <span style={{ display: "block", fontSize: "12px", color: "#cfc7b8" }}>{txt(v.t?.teraSub)}</span>
              </span>{" "}
              <button onClick={v.tera?.close} title={v.t?.gotIt} style={{ marginLeft: "auto", width: "28px", height: "28px", borderRadius: "8px", border: "0", background: "transparent", color: "#cfc7b8", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18"></path>
                </svg>
              </button>
            </div>
            <div style={{ padding: "14px 16px 16px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "13.5px", lineHeight: "1.5" }}>
              <div style={{ fontWeight: "600", fontSize: "15px" }}>{txt(v.tera?.title)}</div>
              <div style={{ color: "var(--tx2)" }}>{txt(v.tera?.what)}</div>
              <div>
                <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--tx3)", marginBottom: "6px" }}>{txt(v.t?.teraHow)}</div>
                <ol style={{ margin: "0", padding: "0", listStyle: "none", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {list(v.tera?.how).map((h, $i96) => (<Fragment key={$i96}>
                    <li style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                      <span style={{ flex: "none", width: "20px", height: "20px", borderRadius: "50%", background: "var(--accbg)", color: "var(--acc)", fontSize: "12px", fontWeight: "700", display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: "1px" }}>{txt(h?.n)}</span>
                      <span>{txt(h?.text)}</span>
                    </li>
                  </Fragment>))}
                </ol>
              </div>
              <button onClick={v.tera?.close} style={{ alignSelf: "flex-end", flex: "none", height: "32px", padding: "0 14px", borderRadius: "8px", border: "1px solid var(--acc)", background: "var(--acc)", color: "var(--onacc)", font: "inherit", fontSize: "13px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" }}>{txt(v.t?.gotIt)}</button>
            </div>
          </div>
        </>) : null}
        <button onClick={v.tera?.toggle} title={v.t?.askTera} style={{ width: "54px", height: "54px", borderRadius: "50%", border: "1px solid var(--bd)", background: "#1c1a17", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", animation: "teraBob 3.2s ease-in-out infinite", transition: "transform .15s" }} className="hv10">
          <svg viewBox="0 0 48 48" width="32" height="32" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
            <path d="M19 9c0-3 2-5 5-5s5 2 5 5" stroke="#f2eee7" strokeWidth="2.5"></path>
            <rect x="15" y="9" width="18" height="4" rx="2" fill="#f2eee7"></rect>
            <rect x="13" y="13" width="22" height="22" rx="6" fill="#e8731a"></rect>
            <rect x="16" y="16" width="16" height="16" rx="4" fill="#ffb86b"></rect>
            <circle cx="21" cy="23" r="1.6" fill="#1c1a17"></circle>
            <circle cx="27" cy="23" r="1.6" fill="#1c1a17"></circle>
            <path d="M21.5 27c1.5 1.4 3.5 1.4 5 0" stroke="#1c1a17" strokeWidth="1.8"></path>
            <rect x="15" y="35" width="18" height="4" rx="2" fill="#f2eee7"></rect>
            <path d="M20 42h8" stroke="#f2eee7" strokeWidth="2.5"></path>
          </svg>
        </button>
      </div>
      {v.toast ? (<>
        <div style={{ position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", background: "#1c1a17", color: "#f2eee7", padding: "10px 16px", borderRadius: "10px", zIndex: "60", fontFamily: "var(--ff)", fontSize: "13px", animation: "toastIn .25s ease", maxWidth: "640px" }}>{txt(v.toast)}</div>
      </>) : null}
    </div>
    </>
  );
}
