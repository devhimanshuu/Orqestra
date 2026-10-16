import { Skeleton } from "@/components/ui/skeleton";

export default function ExperimentsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-80" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    </div>
  );}
