export default function EmptyState() {
  return (
    <div className="banner">
      <p>No orcha stacks yet.</p>
      <button onClick={() => void window.orchaDesktop.openOnboarding()}>
        Create your first project
      </button>
    </div>
  )
}
