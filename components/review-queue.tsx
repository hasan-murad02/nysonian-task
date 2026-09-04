"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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

// Matches Reconciliation's green/red scheme — shadcn's Badge has no
// built-in "success" variant.
function successClassName(isSuccess: boolean): string {
  return isSuccess ? "bg-green-600 text-white" : "";
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
      <div className="flex items-center gap-2">
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
        <span className="text-sm text-muted-foreground">{runs.length} runs</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Requested</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={6}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ))}
          {!loading && runs.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No runs with status &quot;{status}&quot;
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
                <TableCell>{run.order_id}</TableCell>
                <TableCell>{formatMoney(run.requested_amount, run.currency)}</TableCell>
                <TableCell>{run.reason ?? "—"}</TableCell>
                <TableCell>{run.decision ?? "—"}</TableCell>
                <TableCell>{run.confidence ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(run.status)} className={successClassName(run.status === "completed")}>
                    {run.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Refund detail</DialogTitle>
          </DialogHeader>

          {detailLoading && <Skeleton className="h-40 w-full" />}

          {!detailLoading && detail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-muted-foreground">Order</div>
                  <div>{detail.run.order_id}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Captured</div>
                  <div>{formatMoney(detail.order?.captured_amount ?? null, detail.order?.currency ?? null)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Requested</div>
                  <div>{formatMoney(detail.run.requested_amount, detail.order?.currency ?? null)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Reason</div>
                  <div>{detail.run.reason ?? "—"}</div>
                </div>
              </div>

              <div>
                <div className="mb-1 font-medium">Model recommendation</div>
                <div className="rounded border p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant={detail.run.decision === "auto_approve" ? "default" : "secondary"}>
                      {detail.run.decision ?? "no recommendation"}
                    </Badge>
                    {detail.run.confidence !== null && (
                      <span className="text-muted-foreground">confidence {detail.run.confidence}</span>
                    )}
                  </div>
                  {detail.modelReason && <p className="text-muted-foreground">{detail.modelReason}</p>}
                  {detail.citations.length > 0 && (
                    <ul className="mt-2 list-disc pl-4">
                      {detail.citations.map((c) => (
                        <li key={c.id}>
                          <span className="font-medium">{c.title}</span>
                          <span className="text-muted-foreground"> ({c.id})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 font-medium">Workflow trace</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Step</TableHead>
                      <TableHead>Attempt</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.steps.map((s) => (
                      <TableRow key={`${s.step}-${s.attempt}`}>
                        <TableCell>{s.step}</TableCell>
                        <TableCell>{s.attempt}</TableCell>
                        <TableCell>
                          <Badge
                            variant={s.status === "succeeded" ? "default" : "destructive"}
                            className={successClassName(s.status === "succeeded")}
                          >
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
