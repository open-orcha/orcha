/** "Download report": the task's Quality report for a Jira ticket, or the bundle with its screenshots. */
import { useState } from "react";
import { MenuButton } from "../../../components/primitives";
import { downloadReport } from "./api";

export function ReportDownloads({ tid }: { tid: string }) {
  const [err, setErr] = useState<string | null>(null);
  const save = (format: "md" | "zip") => {
    setErr(null);
    downloadReport(tid, format).catch((e: Error) => setErr(e.message));
  };
  return (
    <span className="qa-report-dl" data-qa-report-download>
      <MenuButton size="sm" variant="ghost" menuLabel="Download Quality report" value="Download report"
        items={[
          { label: "Report (.md)", hint: "To attach to the Jira ticket", onSelect: () => save("md") },
          { label: "Bundle with screenshots (.zip)", hint: "To import into Embodent", onSelect: () => save("zip") },
        ]} />
      {err ? <span className="qa-error" role="alert">{err}</span> : null}
    </span>
  );
}
