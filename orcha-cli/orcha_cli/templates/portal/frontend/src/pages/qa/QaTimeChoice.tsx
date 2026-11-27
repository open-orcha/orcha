import { useId } from "react";

/** Zero is an explicit choice of no time limit. Missing values use 20 minutes. */
export function QaTimeChoice({ value, onChange, disabled = false }: { value: number; onChange: (minutes: number) => void; disabled?: boolean }) {
  const id = useId();
  const choices = [...new Set([20, 30, 45, 60, 120, 240, 480, value])].filter((n) => n > 0).sort((a, b) => a - b);
  return <div className="qa-field">
    <label className="qa-label" htmlFor={id}>Time limit</label>
    <select id={id} className="qa-input" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {choices.map((n) => <option key={n} value={n}>{n} minutes</option>)}
      <option value={0}>No limit</option>
    </select>
  </div>;
}
