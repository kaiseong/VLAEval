import type { Job } from "../contracts";
import { ResultWorkspace } from "./results/ResultWorkspace";

export function Results({ job }: { readonly job: Job }) {
  return job.result ? <div className="result-stack"><ResultWorkspace key={job.id} job={job} result={job.result} /></div> : null;
}
