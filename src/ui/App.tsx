import { useState, useEffect } from "react";
import type { JobState } from "../types/output.js";
import { LiveStatus } from "./LiveStatus.js";

export interface AppProps {
  subscribe: (cb: (jobs: JobState[], skipped: number) => void) => void;
}

export function App({ subscribe }: AppProps) {
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);

  useEffect(() => {
    subscribe((updatedJobs, skipped) => {
      setJobs([...updatedJobs]);
      setSkippedCount(skipped);
    });
  }, [subscribe]);

  if (jobs.length === 0) {
    return null;
  }

  return <LiveStatus jobs={jobs} skippedCount={skippedCount} />;
}
