"use client";

/**
 * NORA Flows — block palette (left column of the editor).
 *
 * v1 catalog blocks grouped by section. CLICK adds to the canvas
 * (the editor decides the position). The trigger is disabled when one already
 * exists on the canvas — the engine requires exactly one per flow.
 */
import Link from "next/link";
import type { IntegrationStatus } from "@/lib/api/types";
import { strings } from "@/lib/strings";

import { CATALOG, KindIcon, KIND_META, type BlockMeta } from "./catalog";
import { isActionAvailable } from "./availability";

const copy = strings.flows.palette;

const SECTIONS = [
  { label: copy.sections.trigger, kind: "trigger" as const },
  { label: copy.sections.condition, kind: "condition" as const },
  { label: copy.sections.action, kind: "action" as const },
];

export function BlockPalette({
  hasTrigger,
  onAdd,
  integrations,
  integrationError,
  onRetry,
}: {
  hasTrigger: boolean;
  onAdd: (block: BlockMeta) => void;
  integrations: IntegrationStatus[] | null;
  integrationError: boolean;
  onRetry: () => void;
}) {
  return (
    <aside className="flows-palette" aria-label={copy.ariaLabel}>
      {SECTIONS.map((section) => (
        <div key={section.kind} style={{ display: "contents" }}>
          <div className="sec-label">{section.label}</div>
          {CATALOG.filter((b) => b.kind === section.kind && isActionAvailable(b.type, integrations)).map((block) => {
            const blocked = block.kind === "trigger" && hasTrigger;
            return (
              <button
                key={block.type}
                type="button"
                className="flows-bloco"
                disabled={blocked}
                title={blocked ? copy.triggerAlreadyOnCanvas : copy.clickToAdd}
                onClick={() => onAdd(block)}
              >
                <span className="ic" style={{ color: KIND_META[block.kind].color }}>
                  {block.Icon ? <block.Icon size={15} /> : <KindIcon kind={block.kind} size={15} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="name" style={{ display: "block" }}>
                    {block.name}
                  </span>
                  <span className="desc" style={{ display: "block" }}>
                    {block.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, padding: "8px 4px" }}>
        {integrationError ? (
          <>
            <p role="alert" style={{ margin: "0 0 6px" }}>{copy.integrationsFailed}</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{copy.retry}</button>
          </>
        ) : integrations === null ? (
          <span role="status">{copy.integrationsLoading}</span>
        ) : !integrations.some((item) => item.configured && item.connected) ? (
          <>
            <p style={{ margin: "0 0 6px" }}>{copy.noConnections}</p>
            {integrations.some((item) => item.configured) && <Link href="/integrations">{copy.connectAccount}</Link>}
          </>
        ) : null}
      </div>
    </aside>
  );
}
