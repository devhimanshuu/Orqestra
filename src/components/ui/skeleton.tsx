import { cn } from "cn";

/** Neutral pulsing block for loading layouts — matches the shadcn/ui API. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
