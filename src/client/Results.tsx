import type { JobSummary } from "../contracts";
import { ResultWorkspace } from "./results/ResultWorkspace";

export function Results({ job }: { readonly job: JobSummary }) {
  return job.result ? <div className="result-stack"><ResultWorkspace key={job.id} job={job} summary={job.result} /></div> : null;
}
