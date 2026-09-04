import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReviewQueue } from "@/components/review-queue";
import { Reconciliation } from "@/components/reconciliation";
import { SummaryStats } from "@/components/summary-stats";

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Refund Triage Console</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review queued refunds and reconcile payouts against captured totals.
          </p>
        </div>
        <SummaryStats />
      </div>
      <Tabs defaultValue="queue" className="gap-4">
        <TabsList>
          <TabsTrigger value="queue">Review Queue</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <ReviewQueue />
        </TabsContent>
        <TabsContent value="reconciliation">
          <Reconciliation />
        </TabsContent>
      </Tabs>
    </div>
  );
}
