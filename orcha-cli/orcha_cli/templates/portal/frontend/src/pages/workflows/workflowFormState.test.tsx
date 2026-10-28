import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useWorkflowForm } from "./workflowFormState";
afterEach(cleanup);
function Draft({ identity, project }: { identity: string; project: string }) {
  const [value, setValue] = useWorkflowForm({ origin: "https://orcha.example", project, identity }, "question", "");
  return <input aria-label="Answer" value={value} onChange={(e) => setValue(e.target.value)} />;
}
it("keeps unsent text scoped when the same editor changes human or project", () => {
  const project = crypto.randomUUID();
  const view = render(<Draft identity="alice" project={project} />);
  fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Alice's draft" } });
  view.rerender(<Draft identity="bob" project={project} />);
  expect(screen.getByLabelText("Answer")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Bob's draft" } });
  view.rerender(<Draft identity="alice" project={project} />);
  expect(screen.getByLabelText("Answer")).toHaveValue("Alice's draft");
  view.rerender(<Draft identity="alice" project="different-project" />);
  expect(screen.getByLabelText("Answer")).toHaveValue("");
});
