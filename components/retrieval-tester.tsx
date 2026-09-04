"use client";

import { useRef, useState } from "react";
import { Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const HEAD_CLASS = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

// One scenario per active policy this app ships — the same set exercised
// by scripts/eval-retrieval.mjs, so what a reviewer tries here is exactly
// what the committed eval/retrieval-results.md numbers are about, not a
// different, untested question set. Shown as the real question text, not
// a shortened label, so it's clear exactly what's being sent to retrieval.
const SUGGESTED_QUESTIONS = [
  "Customer wants to return an unused item in original packaging, 40 days after delivery, no damage, just changed their mind.",
  "Customer says the item arrived damaged, reported 3 days after delivery, no photo provided but describes the damage clearly.",
  "A laptop arrived dead on arrival, customer reports it 10 days after delivery.",
  "A grocery delivery of frozen food arrived spoiled and melted, customer reports it the same day.",
  "Customer says only 2 of the 3 items in their order arrived; the third one never showed up.",
  "Order arrived 9 days later than the quoted delivery date; customer is unhappy about the delay but still wants to keep the item.",
  "EU customer requests to withdraw from their purchase 10 days after delivery under their statutory cancellation right, no reason given.",
  "Customer is requesting a refund of $650 on a single order.",
  "This customer has submitted 4 refund requests in the past two months, this being the latest.",
  "High-value order with a missing-item claim and no delivery confirmation on file.",
  "Customer wants a small $30 goodwill credit for a minor inconvenience that doesn't fit any specific refund policy.",
  "A VIP loyalty customer is requesting a $120 goodwill gesture for an inconvenience outside normal policy.",
];

interface RetrievedPolicy {
  id: string;
  title: string;
  body: string;
  score: number;
}

// Same bar-plus-number treatment as the confidence meter elsewhere in this
// app — one visual language for "a 0-1 score" throughout, not a one-off.
function ScoreMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono tabular-nums">{value.toFixed(4)}</span>
      <span className="inline-block h-1 w-16 rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function RetrievalTester() {
  const [input, setInput] = useState("");
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const [results, setResults] = useState<RetrievedPolicy[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same stale-response guard pattern as the review queue's detail fetch —
  // clicking a second suggestion before the first request returns must not
  // let the first one's results land after the second's.
  const requestId = useRef(0);

  async function runQuery(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setInput(trimmed);
    setLastQuery(trimmed);
    setLoading(true);
    setError(null);
    const id = ++requestId.current;
    try {
      const res = await fetch(`/api/retrieval/test?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (requestId.current !== id) return;
      if (!res.ok) {
        setError(data.error ?? "Retrieval failed");
        setResults(null);
        return;
      }
      setResults(data.results ?? []);
    } catch {
      if (requestId.current !== id) return;
      setError("Retrieval failed");
      setResults(null);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            runQuery(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe a refund scenario..."
          />
          <Button type="submit" disabled={loading || !input.trim()}>
            <Search className="size-4" />
            Search
          </Button>
        </form>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {SUGGESTED_QUESTIONS.map((q) => (
            <Button
              key={q}
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => runQuery(q)}
              className="h-auto justify-start px-3 py-2 text-left text-sm font-normal whitespace-normal"
            >
              {q}
            </Button>
          ))}
        </div>
      </Card>

      {loading && (
        <Card className="gap-0 py-0">
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        </Card>
      )}

      {!loading && error && (
        <Card className="p-4 text-sm text-destructive">{error}</Card>
      )}

      {!loading && !error && results && (
        <Card className="gap-0 py-0">
          <div className="border-b px-4 py-3 text-sm text-muted-foreground">
            Top {results.length} for <span className="text-foreground">&quot;{lastQuery}&quot;</span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={`${HEAD_CLASS} w-12`}>Rank</TableHead>
                  <TableHead className={HEAD_CLASS}>Policy</TableHead>
                  <TableHead className={`${HEAD_CLASS} w-40`}>Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No policies retrieved.
                    </TableCell>
                  </TableRow>
                )}
                {results.map((r, i) => (
                  <TableRow key={r.id}>
                    <TableCell className="align-top font-mono tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="whitespace-normal align-top">
                      <div className="font-semibold">{r.title}</div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="font-mono">
                          {r.id}
                        </Badge>
                      </div>
                      <p className="mt-1 max-w-prose text-xs text-muted-foreground">{r.body}</p>
                    </TableCell>
                    <TableCell className="align-top">
                      <ScoreMeter value={r.score} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
