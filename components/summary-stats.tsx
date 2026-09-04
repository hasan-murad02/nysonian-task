"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { AlertTriangle, Hourglass } from "lucide-react";

interface Summary {
  pending: number | null;
  alarms: number | null;
}

function StatCard({
  icon,
  value,
  label,
  tone = "neutral",
  live = false,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  tone?: "neutral" | "alert";
  live?: boolean;
}) {
  return (
    <Card
      className="flex-row items-center gap-3 px-4 py-3"
      {...(live ? { role: "status" as const, "aria-atomic": true } : {})}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
          tone === "alert" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div
          className={`font-mono text-xl leading-none font-semibold tabular-nums ${
            tone === "alert" ? "text-destructive" : ""
          }`}
        >
          {value}
        </div>
        <div className="mt-1 text-xs whitespace-nowrap text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

// Own its own fetch of the same two endpoints ReviewQueue/Reconciliation
// already call, rather than threading state up from those components — this
// is a header-level summary, not shared state the tables themselves need,
// and every other data-fetching component in this console already follows
// the same single-mount-effect pattern.
export function SummaryStats() {
  const [summary, setSummary] = useState<Summary>({ pending: null, alarms: null });

  useEffect(() => {
    Promise.all([
      fetch("/api/refunds/queue?status=review_pending").then((res) => res.json()),
      fetch("/api/reconciliation").then((res) => res.json()),
    ]).then(([queue, reconciliation]) => {
      const alarms = (reconciliation.orders ?? []).filter(
        (o: { flag: string }) => o.flag === "integrity_alarm",
      ).length;
      setSummary({ pending: (queue.runs ?? []).length, alarms });
    });
  }, []);

  const hasAlarms = (summary.alarms ?? 0) > 0;

  return (
    <div className="flex flex-wrap gap-3">
      <StatCard icon={<Hourglass className="size-4" />} value={summary.pending ?? "—"} label="awaiting review" />
      {/* role=status wraps the whole card (icon, number, and label together) so
          it announces as one coherent message — "2 reconciliation alarms" —
          rather than a bare number with no context. */}
      <StatCard
        icon={<AlertTriangle className="size-4" />}
        value={summary.alarms ?? "—"}
        label={`reconciliation ${summary.alarms === 1 ? "alarm" : "alarms"}`}
        tone={hasAlarms ? "alert" : "neutral"}
        live
      />
    </div>
  );
}
