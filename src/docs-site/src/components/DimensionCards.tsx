const CARD_DEFS = [
  { cls: "lp-dim-goal", weight: "40%", name: "Goal achievement", desc: "Did the agent actually finish the task? Scored against your rubric checks by an LLM judge." },
  { cls: "lp-dim-env",  weight: "20%", name: "Environment",      desc: "Shell, filesystem, build tools. Measure whether your project structure and dev workflow trip agents up." },
  { cls: "lp-dim-svc",  weight: "20%", name: "Service",          desc: "APIs, MCP tools, third-party services. Tells you whether your endpoints are actually usable by an agent." },
  { cls: "lp-dim-agent",weight: "20%", name: "Agent",            desc: "Planning, tool selection, self-organization. Captures the quality of the agent's own decisions." },
];

export default function DimensionCards() {
  return (
    <section className="lp-framework">
      <div className="lp-framework-inner">
        <SectionHead />
        <div className="lp-dim-grid">
          {CARD_DEFS.map((c) => (
            <div key={c.cls} className={`lp-dim ${c.cls}`}>
              <div className="lp-dim-weight">{c.weight}</div>
              <div className="lp-dim-name" style={{ maxWidth: "50%" }}>{c.name}</div>
              <p className="lp-dim-desc">{c.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead() {
  return (
    <div className="lp-section-head">
      <div className="lp-eyebrow">Agent Experience Index Score</div>
      <h2 className="lp-section-title">Four dimensions, one score.</h2>
      <p className="lp-section-blurb">
        A single pass/fail tells you nothing about <em>why</em> an agent
        struggled. AXIS scores four independent dimensions so you can focus on
        what matters: a slow API, a confusing layout, a noisy tool, or the
        agent&apos;s own decisions.
      </p>
    </div>
  );
}
