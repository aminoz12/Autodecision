import { cn } from "@/lib/utils";
import { inputClass } from "./Input";

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClass, "cursor-pointer", className)} {...props} />
  );
}
