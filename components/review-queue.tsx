"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Inbox } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyFromString as formatMoney } from "@/lib/money";

// Every value workflow_runs.status can hold (see the CHECK constraint in
// db/migrations/001_init.sql) — not just the "expected" resting states.
// A run stuck in an intermediate step (e.g. issuing_refund, if
// advanceWorkflow throws after the status write but before completing)
// needs to stay reachable from this filter, or an operator has no way to
// find it at all.
const STATUSES = [
  "pending_order",
  "loading_order",
  "checking_eligibility",
  "deciding",
  "issuing_refund",
  "notifying",
  "review_pending",
  "completed",
  "rejected",
  "failed",
];

const HEAD_CLASS = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

interface QueueRun {
  id: string;
  order_id: string;
  requested_amount: string;
  reason: string | null;
  status: string;
  decision: string | null;
  confidence: string | null;
  currency: string | null;
}

interface StepLog {
  step: string;
  attempt: number;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface Citation {
  id: string;
  title: string;
  body: string;
}

interface RunDetail {
  run: QueueRun & { citation_ids: string[] };
  order: { order_id: string; currency: string; captured_amount: string | null } | null;
  steps: StepLog[];
  citations: Citation[];
  modelReason: string | null;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "rejected" || status === "failed") return "destructive";
  if (status === "review_pending") return "secondary";
  return "outline";
}

// A leading dot reads faster than a color-only pill once several rows are
// visible at once. It rides on bg-current, so it always matches whatever
// text color the badge's variant/override className ends up applying —
// nothing to keep in sync by hand.
function StatusDot() {
  return <span className="size-1.5 rounded-full bg-current" />;
}

// confidence comes back as a string (Postgres numeric(3,2), same
// string-not-number precision reasoning as money's bigint columns) — this is
// the one place that parses it, so the bar width and the printed number can
// never drift apart.
function ConfidenceMeter({ value }: { value: string }) {
  const pct = Math.round(Number(value) * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono tabular-nums">{value}</span>
      <span className="inline-block h-1 w-12 rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function QueueSkeletonRow() {
  return (
    <TableRow>
      <TableCell>
        <Skeleton className="h-4 w-20" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-4 w-14" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-24" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-20" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-16" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-24 rounded-full" />
      </TableCell>
    </TableRow>
  );
}

export function ReviewQueue() {
  const [status, setStatus] = useState("review_pending");
  const [runs, setRuns] = useState<QueueRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);

  // Both requestId refs guard against a stale response overwriting newer
  // state — e.g. open row A, close before A's fetch resolves, open row B:
  // without this, A's response can land after B's and show A's context
  // (recommendation, citations, trace) under B's dialog. Only the response
  // whose id still matches "the latest request we issued" is applied.
  const queueRequestId = useRef(0);
  const detailRequestId = useRef(0);

  // setLoading(true) happens at the point that triggers a reload (the
  // status Select's onValueChange, the row click, act()'s own call below)
  // rather than inside the effect itself — an effect setting state
  // synchronously as its own first statement triggers an extra render pass.
  const loadQueue = useCallback(() => {
    const requestId = ++queueRequestId.current;
    fetch(`/api/refunds/queue?status=${status}`)
      .then((res) => res.json())
      .then((data) => {
        if (queueRequestId.current !== requestId) return;
        setRuns(data.runs ?? []);
      })
      .finally(() => {
        if (queueRequestId.current === requestId) setLoading(false);
      });
  }, [status]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) return;
    const requestId = ++detailRequestId.current;
    fetch(`/api/refunds/${selectedId}`)
      .then((res) => res.json())
      .then((data) => {
        if (detailRequestId.current !== requestId) return;
        setDetail(data);
      })
      .finally(() => {
        if (detailRequestId.current === requestId) setDetailLoading(false);
      });
  }, [selectedId]);

  async function act(action: "approve" | "reject") {
    if (!selectedId) return;
    setActing(true);
    try {
      const res = await fetch(`/api/refunds/${selectedId}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        toast.error(body.error ?? `Failed to ${action}`);
        return;
      }
      toast.success(action === "approve" ? "Refund approved" : "Refund rejected");
      setSelectedId(null);
      setDetail(null);
      setLoading(true);
      loadQueue();
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <Select
            value={status}
            onValueChange={(v) => {
              if (!v) return;
              setLoading(true);
              setStatus(v);
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">{runs.length} runs</span>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLASS}>Order</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Requested</TableHead>
                <TableHead className={HEAD_CLASS}>Reason</TableHead>
                <TableHead className={HEAD_CLASS}>Decision</TableHead>
                <TableHead className={HEAD_CLASS}>Confidence</TableHead>
                <TableHead className={HEAD_CLASS}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 5 }).map((_, i) => <QueueSkeletonRow key={i} />)}
              {!loading && runs.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Inbox className="size-5" />
                      <span>No runs with status &quot;{status}&quot;</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                runs.map((run) => (
                  <TableRow
                    key={run.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setDetailLoading(true);
                      setSelectedId(run.id);
                    }}
                  >
                    <TableCell className="font-mono font-semibold tabular-nums">{run.order_id}</TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">
                      {formatMoney(run.requested_amount, run.currency)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{run.reason ?? "—"}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{run.decision ?? "—"}</TableCell>
                    <TableCell>
                      {run.confidence !== null ? <ConfidenceMeter value={run.confidence} /> : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant(run.status)}
                        className={`font-mono ${run.status === "completed" ? "bg-success text-success-foreground" : ""}`}
                      >
                        <StatusDot />
                        {run.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Refund detail</DialogTitle>
          </DialogHeader>

          {detailLoading && (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}

          {!detailLoading && detail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border bg-muted/30 p-3">
                <div>
                  <div className="text-xs tracking-wide text-muted-foreground uppercase">Order</div>
                  <div className="font-mono font-semibold tabular-nums">{detail.run.order_id}</div>
                </div>
                <div>
                  <div className="text-xs tracking-wide text-muted-foreground uppercase">Captured</div>
                  <div className="font-mono font-semibold tabular-nums">
                    {formatMoney(detail.order?.captured_amount ?? null, detail.order?.currency ?? null)}
                  </div>
                </div>
                <div>
                  <div className="text-xs tracking-wide text-muted-foreground uppercase">Requested</div>
                  <div className="font-mono font-semibold tabular-nums">
                    {formatMoney(detail.run.requested_amount, detail.order?.currency ?? null)}
                  </div>
                </div>
                <div>
                  <div className="text-xs tracking-wide text-muted-foreground uppercase">Reason</div>
                  <div className="text-muted-foreground">{detail.run.reason ?? "—"}</div>
                </div>
              </div>

              <div>
                <div className="mb-2 font-medium">Model recommendation</div>
                <div className="rounded-lg border p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={detail.run.decision === "auto_approve" ? "default" : "secondary"}
                      className="font-mono"
                    >
                      <StatusDot />
                      {detail.run.decision ?? "no recommendation"}
                    </Badge>
                    {detail.run.confidence !== null && (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        confidence
                        <ConfidenceMeter value={detail.run.confidence} />
                      </span>
                    )}
                  </div>
                  {detail.modelReason && <p className="mt-2 text-muted-foreground">{detail.modelReason}</p>}
                  {detail.citations.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {detail.citations.map((c) => (
                        <span
                          key={c.id}
                          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
                        >
                          <span className="font-medium">{c.title}</span>
                          <span className="font-mono text-muted-foreground">{c.id}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              <div>
                <div className="mb-2 font-medium">Workflow trace</div>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={HEAD_CLASS}>Step</TableHead>
                        <TableHead className={`${HEAD_CLASS} w-16`}>Attempt</TableHead>
                        <TableHead className={HEAD_CLASS}>Status</TableHead>
                        <TableHead className={HEAD_CLASS}>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.steps.map((s) => (
                        <TableRow key={`${s.step}-${s.attempt}`}>
                          <TableCell>{s.step}</TableCell>
                          <TableCell className="font-mono tabular-nums">{s.attempt}</TableCell>
                          <TableCell>
                            <Badge
                              variant={s.status === "succeeded" ? "default" : "destructive"}
                              className={`font-mono ${s.status === "succeeded" ? "bg-success text-success-foreground" : ""}`}
                            >
                              <StatusDot />
                              {s.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{s.error ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}

          {detail?.run.status === "review_pending" && (
            <DialogFooter>
              <Button variant="outline" disabled={acting} onClick={() => act("reject")}>
                Reject
              </Button>
              <Button disabled={acting} onClick={() => act("approve")}>
                Approve
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
