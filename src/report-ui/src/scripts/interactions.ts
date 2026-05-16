/** Set every detail-row's colspan to the number of currently-visible header cells. */
function syncDetailColspans(): void {
  const headerRow = document.querySelector<HTMLTableRowElement>(".results-table thead tr");
  if (!headerRow) return;
  const visible = Array.from(headerRow.cells).filter(
    (c) => c.offsetParent !== null || c.getClientRects().length > 0,
  ).length;
  if (visible === 0) return;
  document.querySelectorAll<HTMLTableCellElement>(".detail-row > td[colspan]").forEach((td) => {
    td.colSpan = visible;
  });
}

/** Attach expand/collapse event listeners to the rendered report. */
export function initInteractions(): void {
  syncDetailColspans();
  window.addEventListener("resize", syncDetailColspans);

  // Scenario header collapse/expand
  document.querySelectorAll<HTMLTableRowElement>(".scenario-header-row").forEach((header) => {
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".info-btn")) return;

      const scenarioKey = header.dataset.scenario;
      if (!scenarioKey) return;

      const isExpanded = header.classList.contains("expanded");

      const agentRows = document.querySelectorAll<HTMLTableRowElement>(`.agent-row[data-scenario="${scenarioKey}"]`);
      const detailRows = document.querySelectorAll<HTMLTableRowElement>(`.detail-row[data-scenario="${scenarioKey}"]`);

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
      // The audits list is the immediate next sibling of the toggle button.
      const list = (btn.nextElementSibling as HTMLElement | null)?.classList.contains("audits-list")
        ? (btn.nextElementSibling as HTMLElement)
        : (btn.parentElement?.querySelector<HTMLElement>(".audits-list") ?? null);
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

  // Interaction breadcrumb links — jump from breakdown to transcript line
  document.querySelectorAll<HTMLElement>(".interaction-link[data-interaction-id]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = link.dataset.interactionId;
      if (!id) return;
      const panel = link.closest<HTMLElement>(".detail-panel");
      if (!panel) return;
      const target = panel.querySelector<HTMLElement>(`.sparse-line[data-interaction-id="${CSS.escape(id)}"]`);
      if (!target) return;

      // Ensure the transcript section is expanded so the target is in flow.
      const transcript = panel.querySelector<HTMLElement>(".sparse-index-content");
      const toggle = panel.querySelector<HTMLButtonElement>(".sparse-index-toggle");
      if (transcript && !transcript.classList.contains("visible")) {
        transcript.classList.add("visible");
        if (toggle) toggle.textContent = "Hide transcript";
      }

      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("interaction-flash");
      // Force reflow so the animation re-triggers if clicked twice.
      void target.offsetWidth;
      target.classList.add("interaction-flash");
    });
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
      // Don't collapse when clicking inside the expanded body — users click
      // there to place a caret or copy text.
      if ((e.target as HTMLElement).closest(".sparse-line-content")) return;
      // Don't toggle if the click ended a text selection.
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
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

  initArtifacts();
}

interface ArtifactJson {
  path: string;
  size: number;
  mimeType: string;
  content: string;
}

function readArtifacts(key: string): ArtifactJson[] | null {
  const dataEl = document.querySelector<HTMLScriptElement>(
    `script.artifacts-data[data-artifacts-key="${CSS.escape(key)}"]`,
  );
  if (!dataEl?.textContent) return null;
  try {
    return JSON.parse(dataEl.textContent) as ArtifactJson[];
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download handler can read it
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function escapeHtmlInline(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPreviewableText(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return (
    mimeType === "application/json" ||
    mimeType === "application/x-ndjson" ||
    mimeType === "application/yaml" ||
    mimeType === "application/xml" ||
    mimeType === "application/sql" ||
    mimeType === "application/toml"
  );
}

function fmtBytesUI(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function downloadArtifact(a: ArtifactJson): void {
  const bytes = base64ToBytes(a.content);
  const blob = new Blob([new Uint8Array(bytes)], { type: a.mimeType });
  downloadBlob(blob, basename(a.path));
}

function renderArtifactPreviewBody(artifact: ArtifactJson, target: HTMLElement): void {
  const bytes = base64ToBytes(artifact.content);

  if (artifact.mimeType.startsWith("image/")) {
    const blob = new Blob([new Uint8Array(bytes)], { type: artifact.mimeType });
    const url = URL.createObjectURL(blob);
    target.innerHTML = `<img class="artifact-image" alt="${escapeHtmlInline(artifact.path)}" src="${url}" />`;
    return;
  }

  if (isPreviewableText(artifact.mimeType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      text = "";
    }
    target.innerHTML = `<pre class="artifact-text">${escapeHtmlInline(text)}</pre>`;
    return;
  }

  target.innerHTML = `
    <div class="artifact-not-previewable">
      <p>This file type can’t be previewed inline.</p>
      <p class="artifact-not-previewable-meta">${escapeHtmlInline(artifact.mimeType)}</p>
    </div>`;
}

function openArtifactModal(section: HTMLElement, key: string, idx: number): void {
  const artifacts = readArtifacts(key);
  if (!artifacts || !artifacts[idx]) return;
  const a = artifacts[idx];

  const modal = section.querySelector<HTMLElement>(`.artifact-modal[data-artifact-modal-key="${CSS.escape(key)}"]`);
  if (!modal) return;

  const titleEl = modal.querySelector<HTMLElement>(".artifact-modal-title");
  const metaEl = modal.querySelector<HTMLElement>(".artifact-modal-meta");
  const previewEl = modal.querySelector<HTMLElement>(".artifact-modal-preview");
  const dlBtn = modal.querySelector<HTMLButtonElement>(".artifact-modal-download");
  if (!titleEl || !metaEl || !previewEl) return;

  titleEl.textContent = a.path;
  metaEl.textContent = `${a.mimeType} · ${fmtBytesUI(a.size)}`;
  renderArtifactPreviewBody(a, previewEl);
  if (dlBtn) dlBtn.dataset.artifactIndex = String(idx);

  modal.classList.add("visible");
}

function initArtifacts(): void {
  // Toggle to show/hide the file tree
  document.querySelectorAll<HTMLButtonElement>(".artifacts-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.artifactsKey;
      if (!key) return;
      const tree = document.querySelector<HTMLElement>(`.art-tree-root[data-artifacts-key="${CSS.escape(key)}"]`);
      if (!tree) return;
      const wasHidden = tree.hidden;
      tree.hidden = !wasHidden;
      btn.textContent = wasHidden ? "Hide artifacts" : "Show artifacts";
      btn.setAttribute("aria-expanded", wasHidden ? "true" : "false");
    });
  });

  // Folder expand/collapse
  document.querySelectorAll<HTMLButtonElement>(".art-tree-folder-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const li = btn.closest<HTMLElement>(".art-tree-dir");
      if (!li) return;
      const wasCollapsed = li.classList.toggle("collapsed");
      btn.setAttribute("aria-expanded", wasCollapsed ? "false" : "true");
    });
  });

  // Eye icon → open preview modal
  document.querySelectorAll<HTMLButtonElement>(".art-tree-eye").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const section = btn.closest<HTMLElement>(".artifacts-section");
      if (!section) return;
      const key = section.dataset.artifactsKey;
      if (!key) return;
      const indexStr = btn.dataset.artifactIndex;
      if (indexStr === undefined) return;
      openArtifactModal(section, key, Number(indexStr));
    });
  });

  // Per-file download
  document.querySelectorAll<HTMLButtonElement>(".art-tree-download").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const section = btn.closest<HTMLElement>(".artifacts-section");
      if (!section) return;
      const key = section.dataset.artifactsKey;
      if (!key) return;
      const indexStr = btn.dataset.artifactIndex;
      if (indexStr === undefined) return;
      const artifacts = readArtifacts(key);
      if (!artifacts) return;
      const a = artifacts[Number(indexStr)];
      if (a) downloadArtifact(a);
    });
  });

  // Download button inside the modal — uses the artifact currently open
  document.querySelectorAll<HTMLButtonElement>(".artifact-modal-download").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.artifactsKey;
      const indexStr = btn.dataset.artifactIndex;
      if (!key || indexStr === undefined) return;
      const artifacts = readArtifacts(key);
      if (!artifacts) return;
      const a = artifacts[Number(indexStr)];
      if (a) downloadArtifact(a);
    });
  });

  // Download all → in-browser ZIP
  document.querySelectorAll<HTMLButtonElement>(".artifacts-download-all").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.artifactsKey;
      if (!key) return;
      const artifacts = readArtifacts(key);
      if (!artifacts || artifacts.length === 0) return;

      const files = artifacts.map((a) => ({ path: a.path, bytes: base64ToBytes(a.content) }));
      const zipBytes = buildZip(files);
      const blob = new Blob([new Uint8Array(zipBytes)], { type: "application/zip" });
      downloadBlob(blob, `artifacts-${key}.zip`);
    });
  });
}

// --- Minimal store-only ZIP encoder (no compression). ---
// Produces a valid ZIP archive that any extractor can open. Avoids pulling
// a zip dependency into the report bundle. Files are stored uncompressed
// (method 0) — adequate since artifact bundles are small in practice.

interface ZipFile {
  path: string;
  bytes: Uint8Array;
}

function buildZip(files: ZipFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  const dosTime = toDosTime(new Date());

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method (store)
    dv.setUint16(10, dosTime.time, true);
    dv.setUint16(12, dosTime.date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); // compressed size
    dv.setUint32(22, size, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    localChunks.push(local, file.bytes);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true); // signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, dosTime.time, true);
    cdv.setUint16(14, dosTime.date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra
    cdv.setUint16(32, 0, true); // comment
    cdv.setUint16(34, 0, true); // disk
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true); // EOCD signature
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central dir
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true); // comment length

  const total = centralStart + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(end, pos);
  return out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toDosTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}
