/** Attach expand/collapse event listeners to the rendered report. */
export function initInteractions(): void {
  // Scenario header collapse/expand
  document.querySelectorAll<HTMLTableRowElement>(".scenario-header-row").forEach((header) => {
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".info-btn")) return;

      const scenarioKey = header.dataset.scenario;
      if (!scenarioKey) return;

      const isExpanded = header.classList.contains("expanded");

      const agentRows = document.querySelectorAll<HTMLTableRowElement>(
        `.agent-row[data-scenario="${scenarioKey}"]`,
      );
      const detailRows = document.querySelectorAll<HTMLTableRowElement>(
        `.detail-row[data-scenario="${scenarioKey}"]`,
      );

      if (isExpanded) {
        header.classList.remove("expanded");
        agentRows.forEach((r) => r.classList.add("scenario-collapsed"));
        detailRows.forEach((r) => {
          r.classList.remove("visible");
          r.classList.add("scenario-collapsed");
          const idx = r.id.replace("detail-", "");
          const resultRow = document.querySelector<HTMLTableRowElement>(`.result-row[data-index="${idx}"]`);
          resultRow?.classList.remove("expanded");
        });
      } else {
        header.classList.add("expanded");
        agentRows.forEach((r) => r.classList.remove("scenario-collapsed"));
        detailRows.forEach((r) => r.classList.remove("scenario-collapsed"));
      }
    });
  });

  // Result row expand/collapse (accordion)
  document.querySelectorAll<HTMLTableRowElement>(".result-row").forEach((row) => {
    row.addEventListener("click", () => {
      if (row.classList.contains("scenario-collapsed")) return;

      const index = row.dataset.index;
      if (index === undefined) return;

      const detail = document.getElementById(`detail-${index}`);
      if (!detail) return;

      const isExpanded = row.classList.contains("expanded");

      // Collapse all
      document.querySelectorAll<HTMLTableRowElement>(".result-row").forEach((r) => {
        r.classList.remove("expanded");
      });
      document.querySelectorAll<HTMLTableRowElement>(".detail-row").forEach((d) => {
        d.classList.remove("visible");
      });

      // Toggle current
      if (!isExpanded) {
        row.classList.add("expanded");
        detail.classList.add("visible");
      }
    });
  });

  // Audit toggle buttons
  document.querySelectorAll<HTMLButtonElement>(".audits-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const section = btn.closest(".audits-section");
      if (!section) return;

      const list = section.querySelector<HTMLElement>(".audits-list");
      if (!list) return;

      const isVisible = list.classList.contains("visible");
      list.classList.toggle("visible");
      btn.textContent = isVisible ? btn.textContent!.replace("Hide", "Show") : btn.textContent!.replace("Show", "Hide");
    });
  });

  // Waterfall "Show all" toggle
  document.querySelectorAll<HTMLButtonElement>(".wf-show-all").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const waterfall = btn.closest(".waterfall");
      if (!waterfall) return;

      const overflow = waterfall.querySelector<HTMLElement>(".wf-overflow");
      if (!overflow) return;

      overflow.style.display = "block";
      btn.style.display = "none";
    });
  });

  // Modal open (info button)
  document.querySelectorAll<HTMLButtonElement>(".info-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const index = btn.dataset.modalIndex;
      if (index === undefined) return;

      const backdrop = document.querySelector<HTMLElement>(`.modal-backdrop[data-modal-index="${index}"]`);
      if (backdrop) backdrop.classList.add("visible");
    });
  });

  // Modal open (error button)
  document.querySelectorAll<HTMLButtonElement>(".error-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const index = btn.dataset.errorIndex;
      if (index === undefined) return;

      const backdrop = document.querySelector<HTMLElement>(`.modal-backdrop[data-error-index="${index}"]`);
      if (backdrop) backdrop.classList.add("visible");
    });
  });

  // Modal close (close button or backdrop click)
  document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("visible");
    });

    const closeBtn = backdrop.querySelector<HTMLButtonElement>(".modal-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => backdrop.classList.remove("visible"));
    }
  });

  // Escape key closes any open modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll<HTMLElement>(".modal-backdrop.visible").forEach((b) => b.classList.remove("visible"));
    }
  });

  // Sparse index toggle
  document.querySelectorAll<HTMLButtonElement>(".sparse-index-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const section = btn.closest(".sparse-index-section");
      if (!section) return;

      const content = section.querySelector<HTMLElement>(".sparse-index-content");
      if (!content) return;

      const isVisible = content.classList.contains("visible");
      content.classList.toggle("visible");
      btn.textContent = isVisible ? "Show transcript" : "Hide transcript";
    });
  });

  // Sparse line expand/collapse (click to show full content)
  document.querySelectorAll<HTMLElement>(".sparse-line-expandable").forEach((line) => {
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      line.classList.toggle("expanded");
    });
  });

  // Expand all / collapse all button
  document.querySelectorAll<HTMLButtonElement>(".sparse-expand-all").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const section = btn.closest(".sparse-index-section");
      if (!section) return;

      const lines = section.querySelectorAll<HTMLElement>(".sparse-line-expandable");
      const allExpanded = Array.from(lines).every((l) => l.classList.contains("expanded"));

      lines.forEach((l) => {
        if (allExpanded) {
          l.classList.remove("expanded");
        } else {
          l.classList.add("expanded");
        }
      });

      btn.textContent = allExpanded ? "Expand all" : "Collapse all";
    });
  });
}
