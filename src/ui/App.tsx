import { useState, useEffect } from "react";
import type { JobState } from "../types/output.js";
import { LiveStatus } from "./LiveStatus.js";

export interface AppProps {
  subscribe: (cb: (jobs: JobState[]) => void) => void;
}

export function App({ subscribe }: AppProps) {
  const [jobs, setJobs] = useState<JobState[]>([]);

  useEffect(() => {
    subscribe((updatedJobs) => {
      setJobs([...updatedJobs]);
    });
  }, [subscribe]);

  if (jobs.length === 0) {
    return null;
  }

  return <LiveStatus jobs={jobs} />;
}
